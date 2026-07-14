"""Depth Anything V2 walk-around backend for an object scan.

An object scan on the fast, Apache-2.0 depth model. It has two paths:

Default (greedy LiveWalkFusion, the working reference from commit 90f5cd9). Fuse
the whole capture with the same engine the live preview uses: calibrate one depth
affine from the first pair that places, freeze it, track each frame against the
last placed frame, derive every baseline from metric depth, and integrate nothing
on a tracking failure. A fixed surface then lands at one world position in every
view and the volume converges to a bounded single body rather than a smear. This
is the path used unless a caller opts into loop closure, because on real captures
it reconstructs a coherent object where the two-pass path below did not.

Opt-in two-pass loop-closed (a caller injects an estimator or passes
``loopClosure``). Runs the capture in two passes so a walk-around that returns to
an earlier viewpoint can be closed instead of drifting open:

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
            raise RuntimeError(
                "walk-around needs at least 2 captured frames; capture a short "
                "sweep with the camera or the object moving."
            )

        # Default to the proven greedy LiveWalkFusion path. On a real capture it
        # fuses a bounded single body; the two-pass loop-closed estimator, by
        # contrast, cascaded to 1-of-50 frames placed and exploded the volume on the
        # same frames because it restarts tracking from frame 0 against a decoupled
        # frozen affine. The two-pass path stays available for a caller that injects
        # an estimator or asks for loop closure (a long capture that truly revisits).
        use_two_pass = self._estimator is not None or bool(params.get("loopClosure", False))
        if not use_two_pass:
            return self._reconstruct_live(
                frame_paths, frames_dir, out_dir, quality, want_color, notify, should_cancel
            )
        return self._reconstruct_two_pass(
            frame_paths, frames_dir, out_dir, quality, want_color, notify, should_cancel
        )

    def _reconstruct_live(
        self, frame_paths, frames_dir, out_dir, quality, want_color, notify, should_cancel
    ) -> dict[str, Any]:
        """The working reference (commit 90f5cd9): fuse the whole walk-around with
        LiveWalkFusion. It calibrates one depth affine on the first pair it actually
        places, tracks each frame against the last placed frame, derives every
        baseline from metric depth, and integrates nothing on a tracking failure, so
        a fixed surface lands at one world position in every view and the volume
        converges to a single body instead of a smear."""
        from ..fusion.cleanup import clean_mesh
        from ..fusion.export import write_all
        from ..live import LiveWalkFusion

        fusion = LiveWalkFusion(frames_dir=frames_dir)
        mesh = None
        for index, path in enumerate(frame_paths):
            _check(should_cancel)
            mesh = fusion.add_frame(path)
            notify(
                "progress",
                {"stage": "fuse", "ratio": (index + 1) / len(frame_paths), "message": path.name},
            )
        if mesh is None or len(mesh.triangles) == 0:
            raise RuntimeError(
                "walk-around fusion produced an empty mesh: the frames may not track "
                "(too little parallax or texture). Try a slower, more textured sweep."
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

    def _reconstruct_two_pass(
        self, frame_paths, frames_dir, out_dir, quality, want_color, notify, should_cancel
    ) -> dict[str, Any]:
        from ..fusion.cleanup import clean_mesh
        from ..fusion.export import write_all
        from ..fusion.tsdf import integrate_depth_frames, suggest_fusion_params
        from ..pose.base import FrameRef

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
        _report_placement(notify, pose_result.placed)

        # FUSE pass: metric depth at the optimized poses -> one TSDF volume. Only
        # located frames integrate; a frame the pose pass could not place is left
        # out rather than fused at a stale pose (which layered misaligned surfaces).
        notify("progress", {"stage": "fuse", "ratio": 0.55, "message": "fusing posed depth"})
        extrinsics = pose_result.poses.extrinsics()
        colors = _load_colors(frame_paths, pose_result.keyframes) if want_color else None
        posed = build_posed_frames(
            pose_result.keyframes, extrinsics, pose_result.affine, colors, pose_result.placed
        )
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
    keyframes: Any, extrinsics: Any, affine: Any, colors: Any | None = None, placed: Any | None = None
) -> list[Any]:
    """Wrap each *located* keyframe as a PosedDepthFrame at its optimized pose.

    Pure with respect to the geometry: for keyframe ``i`` the frozen ``affine``
    maps its disparity to metric depth, ``extrinsics[i]`` (camera-from-world, the
    optimized pose) places it, and ``colors[i]`` rides along when present. A
    keyframe with no disparity is skipped rather than fused at a guessed depth.

    ``placed`` is the pose pass's per-keyframe placement mask: a frame that could
    not be geometrically located holds its predecessor's pose, so fusing it would
    weld a different view onto the wrong spot and smear the volume (the layered
    misalignment that garbled these scans). Such frames are skipped. ``None`` fuses
    every keyframe with a disparity, for callers with no placement information.
    Kept out of ``reconstruct`` so it is unit-tested without a depth model.
    """
    from ..fusion.frames import PosedDepthFrame

    frames = []
    for index, keyframe in enumerate(keyframes):
        if keyframe.disparity is None:
            continue
        if placed is not None and not placed[index]:
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


def _report_placement(notify: Notify, placed: Any | None) -> None:
    """Surface how many frames located, so a poorly-tracked sweep is visible rather
    than silently fusing a sparse, holey body."""
    if not placed:
        return
    located = sum(1 for ok in placed if ok)
    total = len(placed)
    if located >= total:
        return
    notify(
        "log",
        {
            "level": "info" if located >= max(2, total // 2) else "warn",
            "message": (
                f"placed {located} of {total} frames; the rest could not be located "
                "and were left out of fusion. A slower, more textured sweep with more "
                "overlap between frames places more of them."
            ),
        },
    )


def _check(should_cancel: ShouldCancel) -> None:
    if should_cancel():
        raise Cancelled()
