"""Depth Anything V2 (Small) backend: single-view monocular depth to mesh.

The Small checkpoint is Apache-2.0, which is why it is the default: shippable in
a commercial build where the Base and Large checkpoints (CC-BY-NC) are not. This
module declares its metadata unconditionally; the heavy path raises a clear error
until the `depth` extra and model weights are present, so the app can list and
select it before anything is downloaded.

Scale caveat: monocular depth is *relative*. Depth Anything V2 predicts an
inverse-depth (disparity-like) map with no metric scale and no known origin, so
we cannot recover true millimetres from one image. We normalise the prediction
to [0, 1] and map it into a plausible, configurable metric window (near..far,
defaulting to 0.2..0.6 m) purely so the exported STL sits at a sane size. Treat
the absolute scale of a single-view scan as a placeholder, not a measurement.
"""

from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Any

from ..geometry_io import write_binary_stl
from .base import Backend, Cancelled, Notify, ShouldCancel

# Model input side (Depth Anything V2 expects a square 518x518 tensor).
_INPUT_SIZE = 518
# ImageNet normalisation, matching the checkpoint's training preprocessing.
_IMAGENET_MEAN = (0.485, 0.456, 0.406)
_IMAGENET_STD = (0.229, 0.224, 0.225)

# Default metric window the normalised disparity is mapped into (see caveat).
_DEFAULT_NEAR_M = 0.2
_DEFAULT_FAR_M = 0.6
# Fraction of the metric window used as the per-quad discontinuity threshold.
_EDGE_FRACTION = 0.05
# Cap on the meshed grid's larger side; the depth map is strided down to this
# so a full-res frame does not produce millions of triangles.
_DEFAULT_MESH_MAX_DIM = 256
# Fallback horizontal field of view when no intrinsics are supplied.
_FALLBACK_HFOV_DEG = 60.0

# Hugging Face repo and in-repo path for the ONNX export.
_HF_REPO = "onnx-community/depth-anything-v2-small"
_HF_FILE = "onnx/model.onnx"

_EXTRA_HINT = (
    "Depth path unavailable: install the 'depth' extra "
    "(pip install -e '.[depth]') for numpy, pillow and onnxruntime."
)


class DepthAnythingV2Backend(Backend):
    def reconstruct(
        self, params: dict[str, Any], notify: Notify, should_cancel: ShouldCancel
    ) -> dict[str, Any]:
        np, ort, Image = _require_deps()
        from . import _depth_grid

        near = float(params.get("nearMeters", _DEFAULT_NEAR_M))
        far = float(params.get("farMeters", _DEFAULT_FAR_M))
        mesh_max_dim = int(params.get("meshMaxDim", _DEFAULT_MESH_MAX_DIM))
        edge_threshold = float(
            params.get("edgeThresholdMeters", _EDGE_FRACTION * (far - near))
        )

        frames_dir = Path(params["framesDir"])
        out_dir = Path(params["outputDir"])
        out_dir.mkdir(parents=True, exist_ok=True)

        notify("progress", {"stage": "load", "ratio": 0.0, "message": "reading frames"})
        frame_paths = _list_frames(frames_dir)
        if not frame_paths:
            raise RuntimeError(f"no frames found in {frames_dir} (expected frame_00000.png ...)")

        image = _pick_sharpest(np, Image, frame_paths)
        width, height = image.size
        intrinsics = _load_intrinsics(np, frames_dir, width, height)
        _check(should_cancel)

        notify("progress", {"stage": "infer", "ratio": 0.2, "message": "running depth model"})
        session = _load_session(ort)
        disparity = _infer_disparity(np, Image, session, image, width, height)
        depth = _to_metric_depth(np, disparity, near, far)
        _check(should_cancel)

        notify("progress", {"stage": "backproject", "ratio": 0.55, "message": "back-projecting"})
        depth_ds, fx, fy, cx, cy = _downsample(np, depth, intrinsics, mesh_max_dim)
        points = _depth_grid.backproject(depth_ds, fx, fy, cx, cy)
        _check(should_cancel)

        notify("progress", {"stage": "mesh", "ratio": 0.75, "message": "building mesh"})
        triangles = _depth_grid.build_grid_mesh(points, depth_ds, edge_threshold)
        if not triangles:
            raise RuntimeError(
                "depth mesh is empty: every quad was dropped as invalid or "
                "discontinuous (try a larger edgeThresholdMeters)"
            )
        _check(should_cancel)

        notify("progress", {"stage": "write", "ratio": 0.9, "message": "writing STL"})
        mesh_path = out_dir / "scan.stl"
        write_binary_stl(mesh_path, triangles)

        vertex_count = _count_unique_vertices(np, depth_ds)
        notify("progress", {"stage": "write", "ratio": 1.0, "message": "done"})
        return {
            "meshPath": str(mesh_path),
            "pointCloudPath": None,
            "vertexCount": vertex_count,
            "triangleCount": len(triangles),
        }


def _check(should_cancel: ShouldCancel) -> None:
    if should_cancel():
        raise Cancelled()


def _require_deps() -> tuple[Any, Any, Any]:
    """Import the third-party stack, raising one clear error if any is missing."""
    try:
        import numpy as np
        import onnxruntime as ort
        from PIL import Image
    except ImportError as error:
        raise RuntimeError(_EXTRA_HINT) from error
    return np, ort, Image


def _list_frames(frames_dir: Path) -> list[Path]:
    return sorted(frames_dir.glob("frame_*.png"))


def _pick_sharpest(np: Any, Image: Any, frame_paths: list[Path]) -> Any:
    """Return the sharpest frame by variance of its Laplacian.

    Sharpness is measured on a grayscale copy with a 4-neighbour Laplacian
    computed by array slicing, so no opencv or scipy is required.
    """
    best_image = None
    best_score = -1.0
    for path in frame_paths:
        image = Image.open(path).convert("RGB")
        gray = np.asarray(image.convert("L"), dtype=np.float64)
        score = _variance_of_laplacian(np, gray)
        if score > best_score:
            best_score = score
            best_image = image
    assert best_image is not None
    return best_image


def _variance_of_laplacian(np: Any, gray: Any) -> float:
    if gray.shape[0] < 3 or gray.shape[1] < 3:
        return float(gray.var())
    center = gray[1:-1, 1:-1]
    laplacian = (
        4.0 * center
        - gray[:-2, 1:-1]
        - gray[2:, 1:-1]
        - gray[1:-1, :-2]
        - gray[1:-1, 2:]
    )
    return float(laplacian.var())


def _load_intrinsics(np: Any, frames_dir: Path, width: int, height: int) -> dict[str, float]:
    """Read framesDir/intrinsics.json or fall back to a 60-degree HFOV pinhole."""
    path = frames_dir / "intrinsics.json"
    if path.exists():
        import json

        data = json.loads(path.read_text(encoding="utf-8"))
        return {
            "fx": float(data["fx"]),
            "fy": float(data["fy"]),
            "cx": float(data["cx"]),
            "cy": float(data["cy"]),
        }
    fx = (width / 2.0) / math.tan(math.radians(_FALLBACK_HFOV_DEG) / 2.0)
    return {"fx": fx, "fy": fx, "cx": width / 2.0, "cy": height / 2.0}


def _load_session(ort: Any) -> Any:
    model_path = _resolve_model_path()
    return ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])


def _resolve_model_path() -> str:
    """Resolve the ONNX weights from MONOCLE_DA2_ONNX or huggingface_hub."""
    env_path = os.environ.get("MONOCLE_DA2_ONNX")
    if env_path:
        if not Path(env_path).exists():
            raise RuntimeError(f"MONOCLE_DA2_ONNX points to a missing file: {env_path}")
        return env_path
    try:
        from huggingface_hub import hf_hub_download
    except ImportError as error:
        raise RuntimeError(
            "Depth model weights unavailable: set MONOCLE_DA2_ONNX to a local "
            f"{_HF_REPO} ONNX file, or install huggingface_hub (part of the "
            "'depth' extra) to download it automatically."
        ) from error
    return hf_hub_download(_HF_REPO, _HF_FILE)


def _infer_disparity(
    np: Any, Image: Any, session: Any, image: Any, width: int, height: int
) -> Any:
    """Run the model and resize its inverse-depth output back to the frame size."""
    resized = image.resize((_INPUT_SIZE, _INPUT_SIZE), Image.BILINEAR)
    tensor = np.asarray(resized, dtype=np.float32) / 255.0
    mean = np.array(_IMAGENET_MEAN, dtype=np.float32)
    std = np.array(_IMAGENET_STD, dtype=np.float32)
    tensor = (tensor - mean) / std
    tensor = np.transpose(tensor, (2, 0, 1))[np.newaxis, ...]  # NCHW

    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    output = session.run([output_name], {input_name: tensor})[0]
    disparity = np.asarray(output, dtype=np.float32).squeeze()

    disp_image = Image.fromarray(disparity, mode="F")
    disp_full = disp_image.resize((width, height), Image.BILINEAR)
    return np.asarray(disp_full, dtype=np.float32)


def _to_metric_depth(np: Any, disparity: Any, near: float, far: float) -> Any:
    """Map normalised inverse depth into the near..far metric window.

    Higher disparity means nearer, so the closest pixel lands at ``near`` and
    the farthest at ``far``. A flat prediction collapses to the window midpoint.
    """
    lo = float(disparity.min())
    hi = float(disparity.max())
    if hi - lo < 1e-9:
        return np.full_like(disparity, (near + far) / 2.0, dtype=np.float32)
    normalised = (disparity - lo) / (hi - lo)
    depth = far - normalised * (far - near)
    return depth.astype(np.float32)


def _downsample(
    np: Any, depth: Any, intrinsics: dict[str, float], mesh_max_dim: int
) -> tuple[Any, float, float, float, float]:
    """Stride the depth map down to mesh_max_dim and scale intrinsics to match.

    Striding (rather than interpolating) preserves sharp silhouette edges so the
    discontinuity test in the grid mesher stays meaningful.
    """
    height, width = depth.shape
    step = max(1, math.ceil(max(height, width) / max(1, mesh_max_dim)))
    if step == 1:
        return depth, intrinsics["fx"], intrinsics["fy"], intrinsics["cx"], intrinsics["cy"]
    depth_ds = depth[::step, ::step]
    return (
        depth_ds,
        intrinsics["fx"] / step,
        intrinsics["fy"] / step,
        intrinsics["cx"] / step,
        intrinsics["cy"] / step,
    )


def _count_unique_vertices(np: Any, depth: Any) -> int:
    """Vertices actually referenced by the mesh: pixels with valid depth."""
    return int((depth > 0).sum())
