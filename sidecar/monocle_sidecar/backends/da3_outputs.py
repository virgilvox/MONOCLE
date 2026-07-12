"""Native Depth Anything 3 outputs: point cloud, COLMAP model, Gaussian splat.

The mesh path fuses DA3's per-view depth into a watertight TSDF surface. The
three outputs here skip fusion and use Depth Anything 3's own exporters straight
from a Prediction: a colored point cloud with camera poses (GLB), a COLMAP sparse
model other photogrammetry tools can read, and a 3D Gaussian splat PLY.

Every call into depth_anything_3.api.export lives in this module, one function
per output kind, mirroring how multiview._infer_da3 isolates model.inference: the
heavy package import stays lazy and the single place to fix if the DA3 export API
shifts is obvious.

DA3 export API (verified against the pinned depth-anything-3 in the venv):
`depth_anything_3.api.export(prediction, export_format, export_dir, **kwargs)`
dispatches on one format token; per-format options are nested under the format
name, for example export(pred, "colmap", d, colmap={"image_paths": paths}).
  - "glb"    writes <dir>/scene.glb (point cloud + camera wireframes) and needs
             prediction.processed_images and prediction.conf.
  - "colmap" writes a COLMAP sparse model (cameras/images/points3D) into <dir>
             and needs the source image paths.
  - "gs_ply" writes <dir>/gs_ply/0000.ply from prediction.gaussians, populated
             only when inference ran with infer_gs=True on a Gaussian-capable
             checkpoint (giant / nested-giant).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

# Checkpoints whose weights carry a Gaussian head. BASE and LARGE do not, so a
# gaussian request against them is rejected before inference (see
# require_gaussian_capable). Matched case-insensitively against the resolved
# checkpoint id: DA3-GIANT and DA3NESTED-GIANT-LARGE both contain "giant".
_GAUSSIAN_CAPABLE_TOKEN = "giant"
_GAUSSIAN_CAPABLE_NAMES = "da3-giant or da3nested-giant-large"

_EXPORT_HINT = (
    "install the 'reconstruct' extra (pip install -e '.[reconstruct]') and the "
    "'depth-anything-3' package"
)


def is_gaussian_capable(checkpoint: str) -> bool:
    """True when a resolved checkpoint id carries a Gaussian head (giant/nested)."""
    return _GAUSSIAN_CAPABLE_TOKEN in checkpoint.lower()


def require_gaussian_capable(checkpoint: str) -> None:
    """Raise unless the resolved checkpoint can produce Gaussians.

    Only da3-giant and da3nested-giant-large ship the Gaussian head; BASE and
    LARGE do not. Checked before inference so a gaussian request fails fast with a
    clear message rather than after a full (and expensive) forward pass.
    """
    if not is_gaussian_capable(checkpoint):
        raise RuntimeError(
            f"gaussian output needs a Gaussian-capable Depth Anything 3 checkpoint "
            f"({_GAUSSIAN_CAPABLE_NAMES}); '{checkpoint}' does not carry a Gaussian "
            f"head. Select a giant checkpoint or set MONOCLE_DA3_CKPT to one."
        )


def export_point_cloud(prediction: Any, out_dir: Path) -> dict[str, Any]:
    """Export DA3's colored point cloud plus camera poses as a GLB.

    Returns a ReconstructResult with the GLB as the primary and preview file. The
    point count is read back from the GLB when trimesh is present, else 0;
    triangleCount is always 0 because a point cloud carries no faces.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    _export(prediction, "glb", out)
    glb = out / "scene.glb"
    if not glb.exists():
        raise RuntimeError(f"Depth Anything 3 glb export did not write {glb.name}")
    return {
        "meshPath": str(glb),
        "pointCloudPath": str(glb),
        "previewPath": str(glb),
        "vertexCount": _glb_point_count(glb),
        "triangleCount": 0,
        "hasColor": True,
        "output": "pointCloud",
        "artifacts": {"glb": str(glb)},
    }


def export_colmap(
    prediction: Any, out_dir: Path, image_paths: list[str]
) -> dict[str, Any]:
    """Export a COLMAP sparse model (cameras, images, points3D) into <out_dir>/colmap.

    DA3's colmap exporter needs the source image paths to name images and rescale
    intrinsics back to full resolution, so they are threaded through here.
    """
    out = Path(out_dir)
    colmap_dir = out / "colmap"
    colmap_dir.mkdir(parents=True, exist_ok=True)
    _export(prediction, "colmap", colmap_dir, colmap={"image_paths": list(image_paths)})
    return {
        "meshPath": str(colmap_dir),
        "vertexCount": 0,
        "triangleCount": 0,
        "output": "colmap",
        "artifacts": {"colmap": str(colmap_dir)},
    }


def export_gaussian(prediction: Any, out_dir: Path) -> dict[str, Any]:
    """Export a 3D Gaussian splat PLY from prediction.gaussians.

    The caller must have run inference with infer_gs=True on a Gaussian-capable
    checkpoint (see require_gaussian_capable); without that prediction.gaussians is
    empty and the DA3 exporter fails.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    _export(prediction, "gs_ply", out)
    ply = out / "gs_ply" / "0000.ply"
    if not ply.exists():
        raise RuntimeError(f"Depth Anything 3 gs_ply export did not write {ply.name}")
    return {
        "meshPath": str(ply),
        "pointCloudPath": str(ply),
        "previewPath": str(ply),
        "vertexCount": 0,
        "triangleCount": 0,
        "hasColor": True,
        "output": "gaussian",
        "artifacts": {"gsPly": str(ply)},
    }


def _export(
    prediction: Any, export_format: str, export_dir: Path, **kwargs: Any
) -> None:
    """Call depth_anything_3.api.export, isolating the one heavy, lazy import."""
    # Match the OpenMP guard multiview._load_da3_model sets: the export path pulls
    # in cv2 and pycolmap, each with its own libomp, and a duplicate load aborts
    # the process without this. The model load already set it when inference ran,
    # but export can be exercised on its own, so keep the guard here too.
    os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
    try:
        from depth_anything_3.api import export as da3_export
    except ImportError as error:
        raise RuntimeError(
            f"Depth Anything 3 export code is unavailable: {_EXPORT_HINT}."
        ) from error
    da3_export(prediction, export_format, str(export_dir), **kwargs)


def _glb_point_count(glb_path: Path) -> int:
    """Best-effort point count from an exported GLB; 0 when it cannot be read.

    The GLB carries the point cloud plus camera wireframes, so only PointCloud
    geometry is counted. Any failure (trimesh missing, unreadable file) yields 0,
    matching the contract that vertexCount is the point count when obtainable.
    """
    try:
        import trimesh

        loaded = trimesh.load(str(glb_path))
        geometries = getattr(loaded, "geometry", None)
        candidates = geometries.values() if geometries is not None else [loaded]
        total = 0
        for geometry in candidates:
            if type(geometry).__name__ == "PointCloud":
                total += len(geometry.vertices)
        return int(total)
    except Exception:  # noqa: BLE001 - the count is a nicety, never fail the export for it
        return 0
