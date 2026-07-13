"""Depth Anything V2 walk-around backend: a two-pass, loop-closed object scan.

An object scan that stays on the fast, Apache-2.0 depth model. Unlike the live
preview it shares machinery with, this runs the capture to completion in two
passes so a walk-around that returns to an earlier viewpoint actually closes
instead of drifting open:

  1. POSE pass: the ``orb-pgo`` estimator recovers globally consistent, loop-closed
     world-from-camera poses for every keyframe. ORB visual odometry seeds the
     chain, a Depth Anything V2 disparity per keyframe plus a frozen depth affine
     put every baseline and every loop edge on one metric scale, temporally
     distant revisits are detected and verified, and a global pose-graph
     optimization redistributes the accumulated drift so the loops close.
  2. FUSE pass: per keyframe, the frozen affine maps its disparity to metric
     depth, that depth is wrapped as a ``PosedDepthFrame`` at the optimized
     camera-from-world pose, and the posed frames integrate into one TSDF volume,
     which is then cleaned and exported.

Why call the estimator in-backend rather than the ``needs_poses`` seam
--------------------------------------------------------------------
The documented seam writes ``poses.json`` (camera-from-world extrinsics only) and
lets a backend read it back. That is not enough here: fusion depth must be built
on the *same* disparity-to-metric-depth affine the poses were scaled with, or the
camera baselines and the depth maps disagree in scale and a fixed surface lands
in a different world position in every view, which is precisely the garbled
fusion ``pose/metric_scale.py`` exists to prevent. ``poses.json`` cannot carry
that affine. Running the estimator here returns the optimized poses *and* the
frozen affine *and* the per-keyframe disparities together, so depth and motion
share one metric, and the Depth Anything inference the pose pass already did is
reused instead of run a second time. Fusion still consumes ``PosedDepthFrame`` via
``integrate_depth_frames``; the engine is not forked. The backend therefore stays
``needs_poses = false`` so the server does not also run a redundant pose stage.

The live/streaming path (``live.py``, ``liveReconstruct``) is untouched: it stays
greedy because it is online and cannot look ahead to close a loop.

Needs OpenCV and onnxruntime (the `depth` extra) plus Open3D (the `reconstruct`
extra) for TSDF fusion.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .base import Backend, BackendConfig, Cancelled, Notify, ShouldCancel, require_mesh_output

_QUALITY_TARGET_TRIANGLES = {"fast": 40_000, "balanced": 150_000, "high": 400_000}
_SMOOTH_ITERATIONS = 5


class WalkaroundBackend(Backend):
    """Reconstruct a walk-around with loop-closed poses and TSDF fusion.

    Args:
        config: the registry BackendConfig.
        estimator: an optional injected pose estimator exposing
            ``estimate_with_scale``; the loop-closing ``OrbPgoPoseEstimator`` is
            constructed lazily when omitted. Injection keeps the fuse pass
            testable without the Depth Anything weights.
    """

    def __init__(self, config: BackendConfig, estimator: Any = None) -> None:
        super().__init__(config)
        self._estimator = estimator

    def reconstruct(
        self, params: dict[str, Any], notify: Notify, should_cancel: ShouldCancel
    ) -> dict[str, Any]:
        require_mesh_output(params)

        from ..fusion.cleanup import clean_mesh
        from ..fusion.export import write_all
        from ..fusion.tsdf import integrate_depth_frames, suggest_fusion_params
        from ..pose.base import FrameRef
        from ..pose.pipeline import list_frames

        quality = str(params.get("quality", "balanced"))
        want_color = bool(params.get("color", True))
        frames_dir = Path(params["framesDir"])
        out_dir = Path(params["outputDir"])
        out_dir.mkdir(parents=True, exist_ok=True)

        notify("progress", {"stage": "load", "ratio": 0.0, "message": "reading frames"})
        frame_paths = list_frames(frames_dir)
        if not frame_paths:
            raise RuntimeError(f"no frames found in {frames_dir} (expected frame_00000.png ...)")
        if len(frame_paths) < 2:
            # Distinct from the metric-scale failure below: a walk-around needs
            # motion between at least two views, so name the real cause.
            raise RuntimeError(
                "walk-around needs at least 2 captured frames; capture a short "
                "sweep with the camera or the object moving."
            )

        # POSE pass: loop-closed poses plus the metric context fusion needs.
        notify("progress", {"stage": "pose", "ratio": 0.05, "message": "estimating loop-closed pose"})
        intrinsics = _load_intrinsics(frames_dir)
        refs = [FrameRef(image=path, intrinsics=intrinsics) for path in frame_paths]
        pose_result = self._make_estimator().estimate_with_scale(refs)
        _check(should_cancel)

        if pose_result.affine is None or len(pose_result.keyframes) < 2:
            raise RuntimeError(
                "walk-around could not establish a metric scale: no keyframe pair "
                "calibrated a consistent depth-to-motion scale, so a coherent volume "
                "cannot be fused. Try a slower, more textured sweep with real parallax."
            )

        _report_loops(notify, len(pose_result.loop_edges))

        # FUSE pass: metric depth at the optimized poses -> one TSDF volume.
        notify("progress", {"stage": "fuse", "ratio": 0.55, "message": "fusing posed depth"})
        extrinsics = pose_result.poses.extrinsics()
        colors = _load_colors(frame_paths, pose_result.keyframes) if want_color else None
        posed = build_posed_frames(pose_result.keyframes, extrinsics, pose_result.affine, colors)
        if not posed:
            raise RuntimeError(
                "walk-around fusion produced no posed frames: every keyframe lacked a "
                "usable disparity. Try a slower, more textured sweep."
            )
        mesh = integrate_depth_frames(posed, **suggest_fusion_params(posed))
        _check(should_cancel)

        if mesh is None or len(mesh.triangles) == 0:
            raise RuntimeError(
                "walk-around fusion produced an empty mesh: the frames may not "
                "overlap or track. Try a slower, more textured sweep."
            )

        notify("progress", {"stage": "mesh", "ratio": 0.9, "message": "cleaning mesh"})
        target = _QUALITY_TARGET_TRIANGLES.get(quality, _QUALITY_TARGET_TRIANGLES["balanced"])
        mesh = clean_mesh(
            mesh, keep_largest=True, smooth_iterations=_SMOOTH_ITERATIONS, target_triangles=target
        )
        _check(should_cancel)

        notify("progress", {"stage": "write", "ratio": 0.95, "message": "writing outputs"})
        result = _write_mesh(write_all, out_dir, mesh, want_color)
        notify("progress", {"stage": "write", "ratio": 1.0, "message": "done"})
        return result

    def _make_estimator(self) -> Any:
        if self._estimator is not None:
            return self._estimator
        from ..pose.orb_pgo import OrbPgoPoseEstimator

        return OrbPgoPoseEstimator()


def build_posed_frames(
    keyframes: Any, extrinsics: Any, affine: Any, colors: Any | None = None
) -> list[Any]:
    """Wrap each keyframe as a PosedDepthFrame at its optimized pose.

    Pure with respect to the geometry: for keyframe ``i`` the frozen ``affine``
    maps its disparity to metric depth, ``extrinsics[i]`` (camera-from-world, the
    optimized pose) places it, and ``colors[i]`` rides along when present. A
    keyframe with no disparity is skipped rather than fused at a guessed depth.
    Kept out of ``reconstruct`` so it is unit-tested without a depth model.
    """
    from ..fusion.frames import PosedDepthFrame

    frames = []
    for index, keyframe in enumerate(keyframes):
        if keyframe.disparity is None:
            continue
        depth = affine.depth(keyframe.disparity)
        intrinsics = _intrinsics_dict(keyframe.k, depth.shape)
        color = colors[index] if colors is not None else None
        frames.append(
            PosedDepthFrame(
                depth=depth, intrinsics=intrinsics, pose=extrinsics[index], color=color
            )
        )
    return frames


def _intrinsics_dict(k: Any, shape: tuple[int, int]) -> dict[str, float]:
    """The fusion intrinsics dict for a (3, 3) K at a depth map's (H, W)."""
    height, width = int(shape[0]), int(shape[1])
    return {
        "fx": float(k[0, 0]),
        "fy": float(k[1, 1]),
        "cx": float(k[0, 2]),
        "cy": float(k[1, 2]),
        "width": float(width),
        "height": float(height),
    }


def _load_colors(frame_paths: list[Path], keyframes: Any) -> list[Any]:
    """Read each frame's RGB, aligned to its keyframe disparity resolution."""
    from PIL import Image

    import numpy as np

    colors = []
    for path, keyframe in zip(frame_paths, keyframes):
        with Image.open(path) as handle:
            rgb = np.asarray(handle.convert("RGB"), dtype=np.uint8)
        if keyframe.disparity is not None:
            target = keyframe.disparity.shape[:2]
            if rgb.shape[:2] != target:
                rgb = _resize_rgb(np, rgb, target)
        colors.append(rgb)
    return colors


def _resize_rgb(np: Any, rgb: Any, target_hw: tuple[int, int]) -> Any:
    """Nearest-neighbour resize of an (H, W, 3) image to the depth map's (H, W)."""
    target_h, target_w = int(target_hw[0]), int(target_hw[1])
    rows = np.linspace(0, rgb.shape[0] - 1, target_h).round().astype(int)
    cols = np.linspace(0, rgb.shape[1] - 1, target_w).round().astype(int)
    return rgb[rows][:, cols]


def _load_intrinsics(frames_dir: Path) -> dict | None:
    """Read framesDir/intrinsics.json for the pose estimator, or None."""
    import json

    path = frames_dir / "intrinsics.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    return {key: float(data[key]) for key in ("fx", "fy", "cx", "cy") if key in data}


def _write_mesh(write_all: Any, out_dir: Path, mesh: Any, want_color: bool) -> dict[str, Any]:
    import numpy as np

    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    triangles = np.asarray(mesh.triangles, dtype=np.int64)
    colors = None
    if want_color and mesh.has_vertex_colors():
        rgb = np.asarray(mesh.vertex_colors, dtype=np.float64)
        colors = np.clip(rgb * 255.0 + 0.5, 0.0, 255.0).astype(np.uint8)
    return write_all(out_dir, "scan", vertices, triangles, colors=colors)


def _report_loops(notify: Notify, count: int) -> None:
    if count > 0:
        notify(
            "log",
            {"level": "info", "message": f"loop closure: {count} revisit(s) closed the track"},
        )
    else:
        notify(
            "log",
            {
                "level": "warn",
                "message": (
                    "loop closure found no revisit; the track is the open odometry "
                    "estimate. Close the loop back to an earlier viewpoint for a "
                    "globally consistent scan."
                ),
            },
        )


def _check(should_cancel: ShouldCancel) -> None:
    if should_cancel():
        raise Cancelled()
