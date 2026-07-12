"""TSDF fusion over posed depth frames, backed by Open3D.

Posed depth frames go in, a watertight-ish triangle mesh comes out. The heavy
imports (numpy, open3d) are deferred into the function body so importing this
module stays cheap and the failure mode when Open3D is missing is a clear
message instead of an ImportError at load time.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .frames import PosedDepthFrame


def _require_open3d() -> Any:
    """Import Open3D or raise a message pointing at the 'reconstruct' extra."""
    try:
        import open3d as o3d  # noqa: F401
    except ImportError as exc:
        raise RuntimeError(
            "TSDF fusion needs Open3D. Install the 'reconstruct' extra: "
            "pip install 'monocle-sidecar[reconstruct]'."
        ) from exc
    # Open3D logs to stdout, which is the JSON-RPC channel; keep it to errors on
    # stderr so it cannot corrupt the protocol framing.
    o3d.utility.set_verbosity_level(o3d.utility.VerbosityLevel.Error)
    return o3d


def integrate_depth_frames(
    frames: list["PosedDepthFrame"],
    voxel_size: float = 0.004,
    sdf_trunc: float = 0.02,
    depth_trunc: float = 3.0,
) -> Any:
    """Fuse posed depth frames into a TSDF volume and extract a triangle mesh.

    Args:
        frames: posed depth frames in meters. Frames carrying color are fused
            with color; the volume runs in RGB mode as soon as any frame has it.
        voxel_size: TSDF voxel edge length in meters.
        sdf_trunc: signed-distance truncation in meters.
        depth_trunc: max reliable depth in meters. Open3D drops any depth at or
            beyond this value, so it must sit strictly above the farthest surface
            you want fused. The default of 3.0 covers room-scale captures; keep it
            comfortably larger than your scene depth or surfaces at the cutoff
            silently vanish.

    Returns:
        An open3d.geometry.TriangleMesh with vertex normals computed.

    Raises:
        RuntimeError: if Open3D is not installed.
        ValueError: if frames is empty.
    """
    o3d = _require_open3d()
    import numpy as np

    if not frames:
        raise ValueError("integrate_depth_frames needs at least one frame.")

    with_color = any(frame.color is not None for frame in frames)
    color_type = (
        o3d.pipelines.integration.TSDFVolumeColorType.RGB8
        if with_color
        else o3d.pipelines.integration.TSDFVolumeColorType.NoColor
    )
    volume = o3d.pipelines.integration.ScalableTSDFVolume(
        voxel_length=voxel_size,
        sdf_trunc=sdf_trunc,
        color_type=color_type,
    )

    for frame in frames:
        intrinsic = _to_pinhole(o3d, frame.intrinsics)
        rgbd = _to_rgbd(o3d, np, frame, with_color, depth_trunc)
        extrinsic = np.ascontiguousarray(frame.pose, dtype=np.float64)
        volume.integrate(rgbd, intrinsic, extrinsic)

    mesh = volume.extract_triangle_mesh()
    mesh.compute_vertex_normals()
    return mesh


def suggest_fusion_params(frames: list["PosedDepthFrame"]) -> dict[str, float]:
    """Derive scale-appropriate TSDF parameters from the frames' depth statistics.

    The default voxel and truncation constants assume a small object in meters.
    A backend whose depth is only up-to-scale (Depth Anything 3's relative depth,
    for example) can hand over depths in arbitrary units, where those fixed
    constants are either far too fine (the volume explodes) or coarser than the
    truncation band (nothing fuses). Sizing the voxel to the scene's own
    characteristic depth keeps roughly constant resolution regardless of the
    absolute scale the model happened to output.

    Returns a dict of voxel_size, sdf_trunc, depth_trunc suitable to pass straight
    to ``integrate_depth_frames``. Falls back to the metric defaults when the
    depths carry no signal.
    """
    import numpy as np

    samples = []
    for frame in frames:
        depth = np.asarray(frame.depth, dtype=np.float64)
        valid = depth[depth > 0]
        if valid.size:
            # Subsample so a full-res batch does not cost a full copy per frame.
            step = max(1, valid.size // 4096)
            samples.append(valid[::step])
    if not samples:
        return {"voxel_size": 0.004, "sdf_trunc": 0.02, "depth_trunc": 3.0}

    depths = np.concatenate(samples)
    characteristic = float(np.median(depths))
    far = float(np.quantile(depths, 0.995))
    if not np.isfinite(characteristic) or characteristic <= 0:
        return {"voxel_size": 0.004, "sdf_trunc": 0.02, "depth_trunc": 3.0}

    # ~256 voxels across the characteristic depth; truncation a few voxels wide.
    voxel = characteristic / 256.0
    return {
        "voxel_size": voxel,
        "sdf_trunc": 5.0 * voxel,
        "depth_trunc": far * 1.25,
    }


def _to_pinhole(o3d: Any, intrinsics: dict) -> Any:
    """Build an Open3D PinholeCameraIntrinsic from the intrinsics dict."""
    return o3d.camera.PinholeCameraIntrinsic(
        width=int(intrinsics["width"]),
        height=int(intrinsics["height"]),
        fx=float(intrinsics["fx"]),
        fy=float(intrinsics["fy"]),
        cx=float(intrinsics["cx"]),
        cy=float(intrinsics["cy"]),
    )


def _to_rgbd(
    o3d: Any,
    np: Any,
    frame: "PosedDepthFrame",
    with_color: bool,
    depth_trunc: float,
) -> Any:
    """Convert a PosedDepthFrame to an Open3D RGBDImage.

    Depth is already metric meters, so depth_scale is 1.0. When the volume runs
    in color mode but this frame has no color, a black image stands in so the
    frame still contributes geometry.
    """
    depth = np.ascontiguousarray(frame.depth, dtype=np.float32)
    depth_image = o3d.geometry.Image(depth)

    if not with_color:
        return o3d.geometry.RGBDImage.create_from_color_and_depth(
            _blank_color(o3d, np, depth.shape),
            depth_image,
            depth_scale=1.0,
            depth_trunc=depth_trunc,
            convert_rgb_to_intensity=False,
        )

    if frame.color is not None:
        color = np.ascontiguousarray(frame.color, dtype=np.uint8)
    else:
        color = np.zeros((*depth.shape, 3), dtype=np.uint8)
    color_image = o3d.geometry.Image(color)
    return o3d.geometry.RGBDImage.create_from_color_and_depth(
        color_image,
        depth_image,
        depth_scale=1.0,
        depth_trunc=depth_trunc,
        convert_rgb_to_intensity=False,
    )


def _blank_color(o3d: Any, np: Any, shape: tuple[int, int]) -> Any:
    """A black RGB image matching the depth resolution, for depth-only frames."""
    return o3d.geometry.Image(np.zeros((*shape, 3), dtype=np.uint8))
