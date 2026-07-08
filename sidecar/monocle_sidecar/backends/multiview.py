"""Feed-forward multi-view backend (Depth Anything 3 / VGGT class).

Depth Anything 3 takes a set of unposed RGB views and predicts, jointly, a metric
depth map, camera intrinsics, and a camera pose for every view. That is exactly
the input the TSDF fuser needs, so this backend is a thin adapter: load frames,
run the model, wrap each view as a PosedDepthFrame, fuse, and export.

The DA3 weights are CC-BY-NC-4.0, hence commercial_use = false in the registry.
Model code and weights live behind the optional 'reconstruct' extra plus the
'depth-anything-3' package; until those are present every heavy path raises a
clear RuntimeError, so the app can still list and select this backend.

DA3 API assumption: the exact inference entry point of the depth_anything_3
package is not stable across releases. Every call into it is isolated in
_run_da3 and _load_da3_model below, each of which documents what it assumes and
must be verified against the pinned package version before shipping. The rest of
the pipeline (frame selection, fusion, export, progress, cancellation) is correct
independent of those details.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .base import Backend, Cancelled, Notify, ShouldCancel

# Cap on how many views we feed the model. Feed-forward multi-view transformers
# hold every view in memory at once, so an unbounded capture would blow up VRAM.
# Forty evenly spaced keyframes is plenty of coverage for a turntable-style scan.
_MAX_FRAMES = 40

_RECONSTRUCT_HINT = (
    "install the 'reconstruct' extra (pip install -e '.[reconstruct]') and the "
    "'depth-anything-3' package"
)


class MultiViewBackend(Backend):
    """Reconstruct from unposed multi-view RGB with a Depth Anything 3 model."""

    def reconstruct(
        self, params: dict[str, Any], notify: Notify, should_cancel: ShouldCancel
    ) -> dict[str, Any]:
        # Fail fast on a missing environment before touching frames or fusion,
        # so selecting this backend without the extras gives one clear error.
        torch = _require_torch()

        frames_dir = Path(params["framesDir"])
        out_dir = Path(params["outputDir"])
        out_dir.mkdir(parents=True, exist_ok=True)

        notify("progress", {"stage": "load", "ratio": 0.0, "message": "loading frames"})
        frame_paths = _select_frame_paths(frames_dir)
        images = _load_images(frame_paths, notify, should_cancel)
        _check_cancel(should_cancel)

        notify("progress", {"stage": "infer", "ratio": 0.0, "message": "running Depth Anything 3"})
        views = _run_da3(images, torch, self.config.device, self.config.dtype)
        _check_cancel(should_cancel)

        notify("progress", {"stage": "fuse", "ratio": 0.0, "message": "fusing depth frames"})
        posed = _to_posed_frames(images, views)
        _check_cancel(should_cancel)
        mesh = _fuse(posed)
        _check_cancel(should_cancel)

        notify("progress", {"stage": "mesh", "ratio": 1.0, "message": "extracted mesh"})
        notify("progress", {"stage": "write", "ratio": 0.0, "message": "writing outputs"})
        result = _write(mesh, out_dir)
        notify("progress", {"stage": "write", "ratio": 1.0, "message": "done"})
        return result


def _check_cancel(should_cancel: ShouldCancel) -> None:
    if should_cancel():
        raise Cancelled()


def _require_torch() -> Any:
    """Import torch, or explain how to get it. torch is the floor dependency for
    every model backend, so its absence is the clearest signal the extra is off."""
    try:
        import torch
    except ImportError as error:
        raise RuntimeError(
            f"Depth Anything 3 is unavailable: {_RECONSTRUCT_HINT}."
        ) from error
    return torch


def _select_frame_paths(frames_dir: Path) -> list[Path]:
    """Sorted RGB keyframes, subsampled to at most _MAX_FRAMES evenly spaced views."""
    paths = sorted(frames_dir.glob("frame_*.png"))
    if not paths:
        raise RuntimeError(f"no frames found in {frames_dir} (expected frame_00000.png ...)")
    if len(paths) <= _MAX_FRAMES:
        return paths
    last = len(paths) - 1
    picked = {round(i * last / (_MAX_FRAMES - 1)) for i in range(_MAX_FRAMES)}
    return [paths[i] for i in sorted(picked)]


def _load_images(
    paths: list[Path], notify: Notify, should_cancel: ShouldCancel
) -> list[Any]:
    """Read each keyframe into an (H, W, 3) uint8 array, dropping any alpha."""
    try:
        import numpy as np
        from PIL import Image
    except ImportError as error:
        raise RuntimeError(f"Image loading is unavailable: {_RECONSTRUCT_HINT}.") from error

    images: list[Any] = []
    for i, path in enumerate(paths):
        _check_cancel(should_cancel)
        with Image.open(path) as handle:
            images.append(np.asarray(handle.convert("RGB"), dtype=np.uint8))
        notify("progress", {"stage": "load", "ratio": (i + 1) / len(paths), "message": path.name})
    return images


def _load_da3_model(torch: Any, device: str, dtype: str) -> Any:
    """Resolve and build the Depth Anything 3 model.

    Resolution order:
      1. The depth_anything_3 PyPI package (module `depth_anything_3`).
      2. A checkpoint path in the MONOCLE_DA3_CKPT environment variable, loaded
         through that same package.
    If neither is available, raise a clear RuntimeError.

    DA3 API (verified against depth-anything-3 0.1.1): the model class is
    `depth_anything_3.api.DepthAnything3` (the package ships no top-level
    re-export, so `depth_anything_3.DepthAnything3` does not exist) and it gains
    `from_pretrained` from huggingface_hub's PyTorchModelHubMixin, returning a
    torch.nn.Module with `.to(device)` and `.eval()`. `from_pretrained` takes a
    Hub repo id such as `depth-anything/DA3-LARGE` (the package's own default is
    the constant `depth-anything/DA3NESTED-GIANT-LARGE-1.1`).
    """
    ckpt = os.environ.get("MONOCLE_DA3_CKPT")
    try:
        from depth_anything_3.api import DepthAnything3
    except ImportError as error:
        raise RuntimeError(
            "Depth Anything 3 model code is unavailable: "
            f"{_RECONSTRUCT_HINT}, or set MONOCLE_DA3_CKPT to a checkpoint path."
        ) from error

    source = ckpt if ckpt else "depth-anything/DA3-LARGE"
    model = DepthAnything3.from_pretrained(source)
    model = model.to(_resolve_device(torch, device))
    model.eval()
    return model


def _resolve_device(torch: Any, device: str) -> str:
    """Turn the registry's device hint into a concrete torch device string."""
    if device != "auto":
        return device
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _run_da3(images: list[Any], torch: Any, device: str, dtype: str) -> list[tuple[Any, dict, Any]]:
    """Run Depth Anything 3 over all views jointly.

    Returns one (depth, intrinsics, pose) triple per input image, in input order:
      - depth: (H, W) float32 array, metric meters, 0 meaning invalid.
      - intrinsics: {fx, fy, cx, cy, width, height} in pixels.
      - pose: (4, 4) float64 camera-from-world (world->camera) matrix.

    DA3 API (verified against depth-anything-3 0.1.1): `model.inference(image)`
    takes the full list of views at once (numpy arrays, PIL images, or paths) so
    poses come out in one shared world frame, and returns a `Prediction`
    dataclass with `depth` (N, H, W), `intrinsics` (N, 3, 3 K), and `extrinsics`
    (N, 4, 4 world->camera). Iterating each stacked array over axis 0 yields the
    per-view entries. The extrinsics are world->camera, exactly the extrinsic
    Open3D's TSDF integrate expects, so no inversion is needed downstream.
    """
    import numpy as np

    model = _load_da3_model(torch, device, dtype)
    with torch.no_grad():
        prediction = model.inference(images)

    depths = _as_list(prediction, "depth", len(images))
    intrinsics = _as_list(prediction, "intrinsics", len(images))
    poses = _as_list(prediction, "extrinsics", len(images))

    views: list[tuple[Any, dict, Any]] = []
    for image, depth, k, pose in zip(images, depths, intrinsics, poses):
        depth_arr = _to_numpy(depth).astype(np.float32)
        height, width = depth_arr.shape[:2]
        intr = _intrinsics_dict(_to_numpy(k), width, height)
        pose_arr = _to_numpy(pose).astype(np.float64).reshape(4, 4)
        views.append((depth_arr, intr, pose_arr))
    return views


def _as_list(prediction: Any, field: str, count: int) -> list[Any]:
    """Pull a per-view field off the model output whether it is an attribute,
    a mapping key, or already a sequence of the right length."""
    if hasattr(prediction, field):
        value = getattr(prediction, field)
    elif isinstance(prediction, dict):
        value = prediction[field]
    else:
        value = prediction
    seq = list(value)
    if len(seq) != count:
        raise RuntimeError(f"DA3 returned {len(seq)} '{field}' entries for {count} views")
    return seq


def _to_numpy(value: Any) -> Any:
    """Detach a torch tensor to a numpy array, or pass a numpy array through."""
    import numpy as np

    if hasattr(value, "detach"):
        return value.detach().cpu().numpy()
    return np.asarray(value)


def _intrinsics_dict(k: Any, width: int, height: int) -> dict[str, float]:
    """Build the intrinsics dict from a 3x3 camera matrix K."""
    k = k.reshape(3, 3)
    return {
        "fx": float(k[0, 0]),
        "fy": float(k[1, 1]),
        "cx": float(k[0, 2]),
        "cy": float(k[1, 2]),
        "width": int(width),
        "height": int(height),
    }


def _to_posed_frames(images: list[Any], views: list[tuple[Any, dict, Any]]) -> list[Any]:
    """Wrap each (depth, intrinsics, pose) view as a fusion PosedDepthFrame,
    attaching the source image as vertex color when its resolution matches."""
    from ..fusion.frames import PosedDepthFrame

    frames = []
    for image, (depth, intrinsics, pose) in zip(images, views):
        color = image if image.shape[:2] == depth.shape[:2] else None
        frames.append(
            PosedDepthFrame(depth=depth, intrinsics=intrinsics, pose=pose, color=color)
        )
    return frames


def _fuse(frames: list[Any]) -> Any:
    """Integrate posed depth frames into a single triangle mesh via TSDF fusion."""
    try:
        from ..fusion.tsdf import integrate_depth_frames
    except ImportError as error:
        raise RuntimeError(f"TSDF fusion is unavailable: {_RECONSTRUCT_HINT}.") from error
    return integrate_depth_frames(frames)


def _write(mesh: Any, out_dir: Path) -> dict[str, Any]:
    """Export the fused mesh to STL (plus a PLY point cloud) and return the result."""
    from ..fusion.export import write_mesh

    return write_mesh(mesh, out_dir)
