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

# Decimation target (triangles) per quality tier for the post-fusion cleanup.
_QUALITY_TARGET_TRIANGLES = {"fast": 40_000, "balanced": 150_000, "high": 500_000}
# A light Taubin pass knocks off TSDF staircasing without shrinking the surface.
_SMOOTH_ITERATIONS = 5


class MultiViewBackend(Backend):
    """Reconstruct from unposed multi-view RGB with a Depth Anything 3 model."""

    def reconstruct(
        self, params: dict[str, Any], notify: Notify, should_cancel: ShouldCancel
    ) -> dict[str, Any]:
        # Fail fast on a missing environment before touching frames or fusion,
        # so selecting this backend without the extras gives one clear error.
        torch = _require_torch()

        quality = str(params.get("quality", "balanced"))
        want_color = bool(params.get("color", False))

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
        posed = _to_posed_frames(images, views, want_color)
        _check_cancel(should_cancel)
        mesh = _fuse(posed)
        _check_cancel(should_cancel)

        notify("progress", {"stage": "mesh", "ratio": 0.5, "message": "cleaning mesh"})
        mesh = _cleanup(mesh, quality)
        _check_cancel(should_cancel)
        if _is_empty(mesh):
            raise RuntimeError(
                "multi-view fusion produced an empty mesh: check that the views "
                "overlap and the subject sits within the depth range"
            )

        notify("progress", {"stage": "mesh", "ratio": 1.0, "message": "extracted mesh"})
        notify("progress", {"stage": "write", "ratio": 0.0, "message": "writing outputs"})
        result = _write(mesh, out_dir, want_color)
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

    # macOS OpenMP guard. depth_anything_3 pulls in OpenCV (cv2, via its input
    # processor) and pycolmap, each of which ships its own OpenMP runtime. If
    # cv2's runtime initializes before Open3D's, Open3D's TSDF integration
    # segfaults (OMP #179) the instant it enters a parallel region; pycolmap's
    # duplicate libomp otherwise aborts the process outright (OMP #15). Importing
    # open3d here -- before the DA3 import drags in cv2 -- pins Open3D's OpenMP
    # first so the runtimes coexist, and KMP_DUPLICATE_LIB_OK lets the duplicate
    # libomp load rather than abort. Both env vars must be set before that first
    # OpenMP-bearing import, which is why this sits ahead of the DA3 import.
    os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    try:
        import open3d  # noqa: F401  (side effect: initialize Open3D's OpenMP first)
    except ImportError:
        pass  # No Open3D means the fusion path is off; that surfaces later in _fuse.

    try:
        from depth_anything_3.api import DepthAnything3
    except ImportError as error:
        raise RuntimeError(
            "Depth Anything 3 model code is unavailable: "
            f"{_RECONSTRUCT_HINT}, or set MONOCLE_DA3_CKPT to a checkpoint path."
        ) from error

    # Default to the Apache-2.0 checkpoint so the shipped default is
    # commercial-safe. DA3-LARGE and DA3-GIANT are CC-BY-NC-4.0; opt into them
    # explicitly via MONOCLE_DA3_CKPT.
    source = ckpt if ckpt else "depth-anything/DA3-BASE"
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
    (N, 3, 4 world->camera). Iterating each stacked array over axis 0 yields the
    per-view entries. The extrinsics are world->camera, exactly the extrinsic
    Open3D's TSDF integrate expects, so no inversion is needed downstream, but
    each (3, 4) is padded to a full 4x4 (see `_pad_extrinsic`) because Open3D
    needs the homogeneous form.
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
        pose_arr = _pad_extrinsic(pose)
        views.append((depth_arr, intr, pose_arr))
    return views


def _pad_extrinsic(pose: Any) -> Any:
    """Return a 4x4 world->camera extrinsic from a (3, 4) or (4, 4) DA3 pose.

    DA3 hands back each extrinsic as a (3, 4) [R | t] world->camera matrix, but
    Open3D's TSDF integrate needs the full homogeneous 4x4. Stack the bottom row
    [0, 0, 0, 1] onto a (3, 4); a matrix that already carries that row (4, 4)
    passes through unchanged. Anything else is a contract violation we surface
    loudly rather than silently reshape.
    """
    import numpy as np

    arr = np.asarray(_to_numpy(pose), dtype=np.float64)
    if arr.shape == (4, 4):
        return arr
    if arr.shape == (3, 4):
        bottom = np.array([[0.0, 0.0, 0.0, 1.0]], dtype=np.float64)
        return np.vstack((arr, bottom))
    raise RuntimeError(
        f"DA3 extrinsic has unexpected shape {arr.shape}; expected (3, 4) or (4, 4)."
    )


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


def _to_posed_frames(
    images: list[Any], views: list[tuple[Any, dict, Any]], want_color: bool
) -> list[Any]:
    """Wrap each (depth, intrinsics, pose) view as a fusion PosedDepthFrame.

    When color capture is on, the source image rides along as vertex color. DA3
    predicts depth at its own working resolution, which rarely matches the source
    frame, so the RGB is resized to the depth map rather than dropped: dropping it
    silently produced geometry-only output on nearly every real scan (M7).
    """
    from ..fusion.frames import PosedDepthFrame

    frames = []
    for image, (depth, intrinsics, pose) in zip(images, views):
        color = _resize_rgb(image, depth.shape[:2]) if want_color else None
        frames.append(
            PosedDepthFrame(depth=depth, intrinsics=intrinsics, pose=pose, color=color)
        )
    return frames


def _resize_rgb(image: Any, target_hw: tuple[int, int]) -> Any:
    """Resize an (H, W, 3) uint8 image to the depth map's (H, W) so color aligns.

    Uses OpenCV (present with the multiview extra) with area sampling when
    shrinking and linear when growing; falls back to nearest-neighbour numpy so
    color survives even without cv2.
    """
    import numpy as np

    target_h, target_w = int(target_hw[0]), int(target_hw[1])
    if image.shape[:2] == (target_h, target_w):
        return image
    try:
        import cv2

        shrinking = target_h * target_w < image.shape[0] * image.shape[1]
        interp = cv2.INTER_AREA if shrinking else cv2.INTER_LINEAR
        return cv2.resize(image, (target_w, target_h), interpolation=interp)
    except ImportError:
        rows = np.linspace(0, image.shape[0] - 1, target_h).round().astype(int)
        cols = np.linspace(0, image.shape[1] - 1, target_w).round().astype(int)
        return image[rows][:, cols]


def _fuse(frames: list[Any]) -> Any:
    """Integrate posed depth frames into a single triangle mesh via TSDF fusion."""
    try:
        from ..fusion.tsdf import integrate_depth_frames
    except ImportError as error:
        raise RuntimeError(f"TSDF fusion is unavailable: {_RECONSTRUCT_HINT}.") from error
    return integrate_depth_frames(frames)


def _cleanup(mesh: Any, quality: str) -> Any:
    """Keep the largest component, smooth lightly, and decimate to the quality tier.

    TSDF fusion leaves floating specks and a dense marching-cubes surface; the
    shared cleanup trims both. Poisson is deliberately not run: this is a fused
    multi-view surface, not a single-view sheet that needs closing.
    """
    from ..fusion.cleanup import clean_mesh

    target = _QUALITY_TARGET_TRIANGLES.get(quality, _QUALITY_TARGET_TRIANGLES["balanced"])
    return clean_mesh(
        mesh,
        keep_largest=True,
        smooth_iterations=_SMOOTH_ITERATIONS,
        target_triangles=target,
    )


def _is_empty(mesh: Any) -> bool:
    """True when the fused mesh carries no triangles, so it must not be exported.

    Fusion or cleanup can leave nothing behind (no view overlap, the subject
    outside the depth range). Exporting that would report success for a file with
    no geometry, so the backend raises instead. Works on any object exposing a
    length-able `triangles`, which is what Open3D's TriangleMesh provides.
    """
    return len(mesh.triangles) == 0


def _write(mesh: Any, out_dir: Path, want_color: bool) -> dict[str, Any]:
    """Export the fused mesh through write_all (STL/PLY/GLB/3MF) with vertex color."""
    import numpy as np

    from ..fusion.export import write_all

    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    triangles = np.asarray(mesh.triangles, dtype=np.int64)
    colors = None
    if want_color and mesh.has_vertex_colors():
        # Open3D stores vertex colors as float [0, 1]; write_all wants uint8 RGB.
        rgb = np.asarray(mesh.vertex_colors, dtype=np.float64)
        colors = np.clip(rgb * 255.0 + 0.5, 0.0, 255.0).astype(np.uint8)
    return write_all(out_dir, "scan", vertices, triangles, colors=colors)
