"""Tests for the Depth Anything V2 two-pass walk-around backend (the default).

Three layers:

- ``build_posed_frames`` is a pure helper (numpy only) that maps loop-closed
  keyframes to fusion frames; it is unit-tested that each frame lands at its
  optimized camera-from-world pose with depth mapped through the frozen affine.
- The two-pass fuse path is exercised with an injected fake estimator that hands
  back a hand-built looped pose result, so it needs only Open3D (no DA2 weights):
  it verifies a coherent capture fuses to a non-empty mesh at the optimized poses
  and that loop closure is reported.
- The full smoke test runs the real backend (DA2 + ORB VO + TSDF) and is skipped
  without the depth/reconstruct extras and DA2 weights.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from monocle_sidecar.backends.base import BackendConfig


def _noop(_method, _params):
    pass


def _config() -> BackendConfig:
    return BackendConfig(
        id="depth-anything-v2-walk",
        label="walk",
        module="monocle_sidecar.backends.walkaround:WalkaroundBackend",
        license="Apache-2.0",
        commercial_use=True,
        mono=True,
        multiview=True,
        needs_poses=False,
        device="cpu",
        dtype="fp16",
    )


class _FakeEstimator:
    """Returns a pre-built MetricPoseResult, so fusion is tested without DA2."""

    def __init__(self, result: Any) -> None:
        self._result = result

    def estimate_with_scale(self, _frames: Any) -> Any:
        return self._result


def _wall_keyframes(count: int, width: int, height: int):
    """`count` keyframes of a frontal wall at 0.4 m, sharing one K and disparity."""
    from monocle_sidecar.pose.loop_closure import Keyframe

    k = np.array([[60.0, 0.0, width / 2.0], [0.0, 60.0, height / 2.0], [0.0, 0.0, 1.0]])
    disparity = np.full((height, width), 2.5, dtype=np.float32)  # depth = 1/2.5 = 0.4
    return [
        Keyframe(
            index=i,
            keypoints=np.zeros((0, 2)),
            descriptors=None,
            k=k,
            disparity=disparity,
        )
        for i in range(count)
    ]


def test_build_posed_frames_places_depth_at_optimized_poses():
    from monocle_sidecar.backends.walkaround import build_posed_frames
    from monocle_sidecar.pose.loop_closure import Keyframe
    from monocle_sidecar.pose.metric_scale import DepthAffine

    affine = DepthAffine(a=1.0, b=0.0)  # depth = 1 / disparity
    keyframes = _wall_keyframes(3, 64, 48)
    extrinsics = np.stack([np.eye(4) for _ in range(3)])
    extrinsics[1, :3, 3] = (0.05, 0.0, 0.0)
    extrinsics[2, :3, 3] = (0.10, 0.0, 0.0)

    frames = build_posed_frames(keyframes, extrinsics, affine)
    assert len(frames) == 3
    for i, frame in enumerate(frames):
        # The optimized camera-from-world pose is used verbatim for fusion.
        np.testing.assert_array_equal(frame.pose, extrinsics[i])
        assert frame.intrinsics["fx"] == 60.0
        assert frame.intrinsics["width"] == 64.0 and frame.intrinsics["height"] == 48.0
        # Depth comes from the frozen affine, not a per-frame renormalization.
        np.testing.assert_allclose(frame.depth[frame.depth > 0], 0.4, atol=1e-4)
        assert frame.color is None

    # A keyframe with no disparity is skipped rather than fused at a guessed depth.
    keyframes.append(
        Keyframe(index=3, keypoints=np.zeros((0, 2)), descriptors=None, k=keyframes[0].k, disparity=None)
    )
    extrinsics = np.concatenate([extrinsics, np.eye(4)[np.newaxis]])
    assert len(build_posed_frames(keyframes, extrinsics, affine)) == 3


def test_build_posed_frames_skips_unplaced_frames():
    # A frame the pose pass could not locate holds its predecessor's pose; fusing it
    # would weld a different view onto the wrong spot and smear the volume, so it is
    # dropped. Only the placed frames integrate.
    from monocle_sidecar.backends.walkaround import build_posed_frames
    from monocle_sidecar.pose.metric_scale import DepthAffine

    affine = DepthAffine(a=1.0, b=0.0)
    keyframes = _wall_keyframes(4, 64, 48)
    extrinsics = np.stack([np.eye(4) for _ in range(4)])
    placed = [True, False, True, False]

    frames = build_posed_frames(keyframes, extrinsics, affine, placed=placed)
    assert len(frames) == 2  # only the two located frames

    # None means "no placement info": every keyframe with a disparity still fuses.
    assert len(build_posed_frames(keyframes, extrinsics, affine, placed=None)) == 4


def test_two_pass_backend_fuses_at_optimized_poses(tmp_path):
    pytest.importorskip("open3d")
    Image = pytest.importorskip("PIL.Image")
    from monocle_sidecar.backends.walkaround import WalkaroundBackend
    from monocle_sidecar.pose.base import PoseResult
    from monocle_sidecar.pose.loop_closure import LoopEdge
    from monocle_sidecar.pose.metric_scale import DepthAffine
    from monocle_sidecar.pose.orb_pgo import MetricPoseResult

    width, height, count = 64, 48, 4
    keyframes = _wall_keyframes(count, width, height)
    for i in range(count):
        Image.fromarray(np.full((height, width, 3), 200, np.uint8)).save(
            tmp_path / f"frame_{i:05d}.png"
        )

    # Loop-closed world-from-camera poses: small sideways steps viewing the wall,
    # with the return frame pulled back near the origin (a closed loop).
    poses = np.stack([np.eye(4) for _ in range(count)])
    for i in range(count):
        poses[i, 0, 3] = 0.02 * i
    poses[-1, 0, 3] = 0.005
    result = MetricPoseResult(
        poses=PoseResult(poses=poses),
        affine=DepthAffine(a=1.0, b=0.0),
        keyframes=keyframes,
        loop_edges=[LoopEdge(source=0, target=count - 1, transformation=np.eye(4))],
    )

    logs: list[dict] = []

    def notify(method, payload):
        if method == "log":
            logs.append(payload)

    backend = WalkaroundBackend(_config(), estimator=_FakeEstimator(result))
    out = backend.reconstruct(
        {"framesDir": str(tmp_path), "outputDir": str(tmp_path), "color": True},
        notify,
        lambda: False,
    )

    assert out["vertexCount"] > 0
    assert out["triangleCount"] > 0
    # The loop-closure diagnostic fired, telling the user closure actually ran.
    assert any(
        "loop closure" in log.get("message", "") and "closed" in log["message"] for log in logs
    )


def test_two_pass_backend_raises_when_scale_uncalibratable(tmp_path):
    # When the pose pass cannot seed a metric scale (affine is None), fusion has no
    # consistent depth to build, so the backend surfaces a clear error.
    Image = pytest.importorskip("PIL.Image")
    from monocle_sidecar.backends.walkaround import WalkaroundBackend
    from monocle_sidecar.pose.base import PoseResult
    from monocle_sidecar.pose.orb_pgo import MetricPoseResult

    for i in range(2):
        Image.fromarray(np.zeros((48, 64, 3), np.uint8)).save(tmp_path / f"frame_{i:05d}.png")
    poses = np.stack([np.eye(4), np.eye(4)])
    result = MetricPoseResult(PoseResult(poses=poses), None, [], [])

    backend = WalkaroundBackend(_config(), estimator=_FakeEstimator(result))
    with pytest.raises(RuntimeError, match="metric scale"):
        backend.reconstruct(
            {"framesDir": str(tmp_path), "outputDir": str(tmp_path)}, _noop, lambda: False
        )


def test_walkaround_backend_produces_a_mesh(tmp_path):
    pytest.importorskip("cv2")
    pytest.importorskip("open3d")
    pytest.importorskip("onnxruntime")
    from monocle_sidecar.backends.walkaround import WalkaroundBackend

    Image = pytest.importorskip("PIL.Image")
    rng = np.random.default_rng(0)
    for i in range(3):
        array = rng.integers(0, 255, size=(240, 320, 3), dtype=np.uint8)
        Image.fromarray(array).save(tmp_path / f"frame_{i:05d}.png")

    backend = WalkaroundBackend(_config())
    try:
        result = backend.reconstruct(
            {"framesDir": str(tmp_path), "outputDir": str(tmp_path), "color": True},
            _noop,
            lambda: False,
        )
    except RuntimeError as error:
        # On featureless synthetic noise the pose pass cannot calibrate a metric
        # scale (or fusion yields nothing); either is an honest, acceptable
        # outcome. The point is that the two-pass pipeline ran without an
        # unexpected failure.
        message = str(error)
        assert "empty mesh" in message or "metric scale" in message
        return

    assert "meshPath" in result
    assert result["vertexCount"] > 0
    assert result["triangleCount"] > 0
