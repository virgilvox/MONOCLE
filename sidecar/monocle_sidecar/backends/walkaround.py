"""Depth Anything V2 walk-around backend: multi-view without the DA3 transformer.

An object scan that stays on the fast, Apache-2.0 depth model. It fuses the whole
captured walk-around to completion with the same engine the live preview uses:
per keyframe, ORB visual odometry recovers the camera pose, Depth Anything V2
predicts depth, and the posed depth is integrated into a TSDF volume, then the
volume is cleaned and exported.

Experimental, like the live preview it shares: monocular pose is recovered only
up to scale and drifts, so geometry is approximate. It runs far faster than the
Depth Anything 3 path on CPU because there is no heavy multi-view transformer,
which is why it is the default object-scan model. Needs OpenCV and onnxruntime
(the `depth` extra) plus Open3D (the `reconstruct` extra) for TSDF fusion.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .base import Backend, Cancelled, Notify, ShouldCancel

_QUALITY_TARGET_TRIANGLES = {"fast": 40_000, "balanced": 150_000, "high": 400_000}
_SMOOTH_ITERATIONS = 5


class WalkaroundBackend(Backend):
    """Reconstruct a walk-around from monocular depth and visual-odometry pose."""

    def reconstruct(
        self, params: dict[str, Any], notify: Notify, should_cancel: ShouldCancel
    ) -> dict[str, Any]:
        import numpy as np

        from ..fusion.cleanup import clean_mesh
        from ..fusion.export import write_all
        from ..live import LiveWalkFusion

        quality = str(params.get("quality", "balanced"))
        want_color = bool(params.get("color", True))
        frames_dir = Path(params["framesDir"])
        out_dir = Path(params["outputDir"])
        out_dir.mkdir(parents=True, exist_ok=True)

        notify("progress", {"stage": "load", "ratio": 0.0, "message": "reading frames"})
        frame_paths = sorted(frames_dir.glob("frame_*.png"))
        if not frame_paths:
            raise RuntimeError(f"no frames found in {frames_dir} (expected frame_00000.png ...)")

        fusion = LiveWalkFusion()
        mesh = None
        for i, path in enumerate(frame_paths):
            _check(should_cancel)
            mesh = fusion.add_frame(path)
            notify(
                "progress",
                {"stage": "fuse", "ratio": (i + 1) / len(frame_paths), "message": path.name},
            )

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
        vertices = np.asarray(mesh.vertices, dtype=np.float64)
        triangles = np.asarray(mesh.triangles, dtype=np.int64)
        colors = None
        if want_color and mesh.has_vertex_colors():
            rgb = np.asarray(mesh.vertex_colors, dtype=np.float64)
            colors = np.clip(rgb * 255.0 + 0.5, 0.0, 255.0).astype(np.uint8)
        result = write_all(out_dir, "scan", vertices, triangles, colors=colors)
        notify("progress", {"stage": "write", "ratio": 1.0, "message": "done"})
        return result


def _check(should_cancel: ShouldCancel) -> None:
    if should_cancel():
        raise Cancelled()
