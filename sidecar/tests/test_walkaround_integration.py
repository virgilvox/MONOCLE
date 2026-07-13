"""End-to-end integration of the two-pass Object (walk-around) scan.

Unlike ``test_walkaround`` (which fakes the estimator with a canned pose result)
and ``test_orb_pgo`` (which exercises the pose refinement in isolation), this test
drives the *whole* two-pass path through ``WalkaroundBackend.reconstruct`` on a
small looped synthetic capture: pass 1 runs the real ORB-PGO estimator, so loop
closure (cv2 essential-matrix verification) and the global pose-graph
optimization (Open3D) actually run and produce loop-closed metric poses, and pass
2 fuses metric depth at *those optimized* poses into a real TSDF mesh (Open3D).

Chosen seam and why not a raw on-disk image capture
---------------------------------------------------
The estimator's two pixel-facing collaborators are injected rather than run for
real: the ORB front end (``OrbVisualOdometry``) and the Depth Anything V2 depth
runner. Both are non-deterministic or unavailable in CI: ORB keypoint detection
plus RANSAC essential-matrix estimation on rendered pixels is cv2-version and
seed sensitive, and the depth weights are a multi-hundred-MB download. So this
drives the highest seam that still exercises pose->fuse together: the estimator's
real ``estimate_with_scale`` glue (affine calibration, metric re-chaining, loop
detection, pose-graph optimization) runs on synthetic features and disparities
that describe one coherent 3D object (a sphere) observed around a small loop.
That keeps the geometry deterministic while running the real loop-closure,
pose-graph, and TSDF code the same way the shipped backend does. The feature-only
geometry is the same seam the committed ``test_orb_pgo`` relies on.

Needs cv2 (matching and essential-matrix verification), Open3D (pose graph and
TSDF), and PIL (frame I/O); skipped where any is absent.
"""

from __future__ import annotations

import json
from typing import Any

import numpy as np
import pytest

from monocle_sidecar.backends.base import BackendConfig

# A small object filmed around a short loop: a sphere in front of the camera, the
# camera orbiting it on a tight circle so it returns to near its start.
_WIDTH, _HEIGHT, _FOCAL = 160, 120, 140.0
_SPHERE_CENTER = np.array([0.0, 0.0, 1.2])
_SPHERE_RADIUS = 0.4
_ORBIT_RADIUS = 0.07
_N_FRAMES = 8
_N_POINTS = 260


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


def _k() -> np.ndarray:
    return np.array(
        [[_FOCAL, 0.0, _WIDTH / 2.0], [0.0, _FOCAL, _HEIGHT / 2.0], [0.0, 0.0, 1.0]]
    )


def _camera_positions() -> np.ndarray:
    """Camera positions on a tight circular loop, all looking down +Z."""
    angles = 2.0 * np.pi * np.arange(_N_FRAMES) / _N_FRAMES
    return np.stack(
        [_ORBIT_RADIUS * np.cos(angles), _ORBIT_RADIUS * np.sin(angles), np.zeros(_N_FRAMES)],
        axis=1,
    )


def _sphere_points(rng: np.random.Generator) -> np.ndarray:
    """Points on the camera-facing cap of the sphere (world coordinates)."""
    normals = []
    while len(normals) < _N_POINTS:
        n = rng.normal(size=3)
        norm = np.linalg.norm(n)
        if norm < 1e-6:
            continue
        n = n / norm
        if n[2] < -0.25:  # front cap only, comfortably away from the silhouette
            normals.append(n)
    return _SPHERE_CENTER + _SPHERE_RADIUS * np.stack(normals)


def _project_visible(
    points: np.ndarray, descriptors: np.ndarray, cam_pos: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Front-facing, in-frame projections of the sphere points from one camera.

    Identity camera rotation, so the camera axes are the world axes and the
    projection is a plain pinhole with the camera at ``cam_pos``.
    """
    k = _k()
    view = points - cam_pos  # camera-frame coordinates (identity rotation)
    normals = points - _SPHERE_CENTER
    front = np.einsum("ij,ij->i", normals, view) < 0.0  # normal faces the camera
    z = view[:, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        u = _FOCAL * view[:, 0] / z + k[0, 2]
        v = _FOCAL * view[:, 1] / z + k[1, 2]
    visible = front & (z > 1e-3) & (u >= 0) & (u < _WIDTH) & (v >= 0) & (v < _HEIGHT)
    keypoints = np.stack([u[visible], v[visible]], axis=1)
    return keypoints, np.ascontiguousarray(descriptors[visible])


def _dense_disparity(cam_pos: np.ndarray) -> np.ndarray:
    """Per-pixel inverse depth of the sphere from one camera (0 where it misses).

    Ray-sphere intersection for every pixel, giving the dense metric depth the
    Depth Anything runner would otherwise predict. This is what fusion integrates,
    and (sampled at the keypoints) what pins the depth-to-motion metric scale.
    """
    xs = (np.arange(_WIDTH) - _WIDTH / 2.0) / _FOCAL
    ys = (np.arange(_HEIGHT) - _HEIGHT / 2.0) / _FOCAL
    grid_x, grid_y = np.meshgrid(xs, ys)  # (H, W)
    dir_x, dir_y = grid_x, grid_y
    oc = cam_pos - _SPHERE_CENTER
    a = dir_x**2 + dir_y**2 + 1.0
    b = 2.0 * (dir_x * oc[0] + dir_y * oc[1] + oc[2])
    c = float(oc @ oc) - _SPHERE_RADIUS**2
    disc = b**2 - 4.0 * a * c
    hit = disc >= 0.0
    depth = np.zeros((_HEIGHT, _WIDTH), dtype=np.float64)
    sqrt_disc = np.sqrt(np.where(hit, disc, 0.0))
    t = (-b - sqrt_disc) / (2.0 * a)  # nearest intersection; depth == camera Z (dir_z == 1)
    valid = hit & (t > 1e-3)
    depth[valid] = t[valid]
    disparity = np.zeros((_HEIGHT, _WIDTH), dtype=np.float32)
    disparity[valid] = (1.0 / depth[valid]).astype(np.float32)
    return disparity


def _scene(seed: int = 3):
    """Build per-frame ORB features and dense disparities for the looped capture."""
    from monocle_sidecar.pose.visual_odometry import KeyframeFeatures

    rng = np.random.default_rng(seed)
    points = _sphere_points(rng)
    descriptors = rng.integers(0, 256, size=(len(points), 32), dtype=np.uint8)
    positions = _camera_positions()

    features: list[Any] = []
    disparities: list[np.ndarray] = []
    for cam_pos in positions:
        keypoints, desc = _project_visible(points, descriptors, cam_pos)
        features.append(
            KeyframeFeatures(
                keypoints=keypoints, descriptors=desc, k=_k(), width=_WIDTH, height=_HEIGHT
            )
        )
        disparities.append(_dense_disparity(cam_pos))
    return positions, features, disparities


class _CannedOdometry:
    """A stand-in ORB front end that hands back pre-built features and a raw track.

    ``estimate_with_features`` is the exact seam ``OrbPgoPoseEstimator`` calls. The
    returned poses are a deliberately drifted, up-to-scale odometry track (the
    greedy estimate) that the estimator uses only as a fallback; the metric,
    loop-closed track is recomputed from the features and disparities.
    """

    def __init__(self, greedy_poses: np.ndarray, features: list[Any]) -> None:
        self._greedy_poses = greedy_poses
        self._features = features

    def estimate_with_features(self, _frames: Any):
        from monocle_sidecar.pose.base import PoseResult

        return PoseResult(poses=self._greedy_poses), self._features


class _CannedDepth:
    """Return the prepared per-frame disparity in capture order (no real model)."""

    def __init__(self, disparities: list[np.ndarray]) -> None:
        self._disparities = list(disparities)
        self._index = 0

    def run(self, _image: Any):
        disparity = self._disparities[self._index]
        self._index += 1
        return disparity, None, {}


class _RecordingEstimator:
    """Wrap the real estimator so the test can inspect the pose result it produced."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.last: Any = None

    def estimate_with_scale(self, frames: Any):
        self.last = self._inner.estimate_with_scale(frames)
        return self.last


def _greedy_track(positions: np.ndarray) -> np.ndarray:
    """A drifted, up-to-scale odometry track: open, and clearly not the truth."""
    drift = np.array([0.02, 0.015, 0.0])
    poses = np.stack([np.eye(4) for _ in range(len(positions))])
    for i, pos in enumerate(positions):
        poses[i, :3, 3] = (pos - positions[0]) + drift * i
    return poses


def _relative_recovery_error(estimated: np.ndarray, truth: np.ndarray) -> float:
    """Scale-invariant fit error of an estimated track against the true positions.

    Both tracks share camera 0 as their origin and identity rotation, so a single
    best-fit scalar absorbs the arbitrary monocular scale; the residual is the
    genuine trajectory error, normalized by the track's own extent.
    """
    est = estimated - estimated[0]
    tru = truth - truth[0]
    scale = float(np.sum(est * tru) / np.sum(tru * tru))
    residual = est - scale * tru
    span = float(np.max(np.linalg.norm(tru - tru.mean(axis=0), axis=1)))
    return float(np.max(np.linalg.norm(residual, axis=1)) / (abs(scale) * span + 1e-9))


def _write_capture(tmp_path) -> None:
    from PIL import Image

    for i in range(_N_FRAMES):
        Image.fromarray(np.full((_HEIGHT, _WIDTH, 3), 128, np.uint8)).save(
            tmp_path / f"frame_{i:05d}.png"
        )
    intrinsics = {
        "fx": _FOCAL,
        "fy": _FOCAL,
        "cx": _WIDTH / 2.0,
        "cy": _HEIGHT / 2.0,
        "width": _WIDTH,
        "height": _HEIGHT,
    }
    (tmp_path / "intrinsics.json").write_text(json.dumps(intrinsics), encoding="utf-8")


def test_two_pass_object_scan_fuses_at_loop_closed_poses(tmp_path):
    pytest.importorskip("cv2")
    pytest.importorskip("open3d")
    pytest.importorskip("PIL.Image")
    import open3d as o3d

    from monocle_sidecar.backends.walkaround import WalkaroundBackend
    from monocle_sidecar.pose.orb_pgo import OrbPgoPoseEstimator

    positions, features, disparities = _scene()
    _write_capture(tmp_path)

    greedy_poses = _greedy_track(positions)
    real = OrbPgoPoseEstimator(
        ratio=0.8,
        min_matches=12,
        min_inliers=8,
        min_index_gap=3,
        min_parallax_px=0.5,
        depth_runner=_CannedDepth(disparities),
        odometry=_CannedOdometry(greedy_poses, features),
    )
    estimator = _RecordingEstimator(real)

    logs: list[dict] = []

    def notify(method, payload):
        if method == "log":
            logs.append(payload)

    backend = WalkaroundBackend(_config(), estimator=estimator)
    result = backend.reconstruct(
        {"framesDir": str(tmp_path), "outputDir": str(tmp_path), "color": True},
        notify,
        lambda: False,
    )

    # Pass 1 established the metric branch (not the greedy up-to-scale fallback):
    # the affine froze and real loop-closure edges were detected and optimized.
    posed = estimator.last
    assert posed is not None
    assert posed.affine is not None, "the pose pass must have calibrated a metric scale"
    assert len(posed.loop_edges) >= 1, "loop closure must find at least one revisit"

    optimized = np.asarray(posed.poses.poses)
    assert optimized.shape == (_N_FRAMES, 4, 4)
    assert np.isfinite(optimized).all(), "optimized poses must be finite"

    # The fused poses are the loop-closed, pose-graph-optimized track, not the
    # greedy odometry the front end handed back.
    assert not np.allclose(optimized, greedy_poses)
    opt_positions = optimized[:, :3, 3]
    optimized_error = _relative_recovery_error(opt_positions, positions)
    greedy_error = _relative_recovery_error(greedy_poses[:, :3, 3], positions)
    assert optimized_error < 0.2, f"loop-closed track should recover the true loop ({optimized_error:.3f})"
    assert greedy_error > optimized_error * 2.0, "the greedy track is the drifted, worse one"

    # Pass 2 fused those poses into a real, finite, non-empty mesh.
    assert result["vertexCount"] > 0
    assert result["triangleCount"] > 0
    mesh = o3d.io.read_triangle_mesh(result["meshPath"])
    assert len(mesh.vertices) > 0 and len(mesh.triangles) > 0
    assert np.isfinite(np.asarray(mesh.vertices)).all(), "fused geometry must be finite"

    # The loop-closure diagnostic fired, so the user is told closure actually ran.
    assert any(
        "loop closure" in log.get("message", "") and "closed" in log["message"] for log in logs
    )
