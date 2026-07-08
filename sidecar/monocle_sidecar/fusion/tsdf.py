"""TSDF fusion over posed depth frames, backed by Open3D.

Placeholder for the pipeline milestone. The signature is fixed now so backends
can target it: posed depth frames in, a triangle mesh out.
"""

from __future__ import annotations

from typing import Any


def integrate_frames(frames: list[dict[str, Any]], voxel_size: float = 0.004) -> Any:
    """Integrate posed depth frames into a TSDF volume and extract a mesh.

    Args:
        frames: posed depth frames, each with intrinsics and a camera-from-world pose.
        voxel_size: TSDF voxel edge length in meters.

    Raises:
        RuntimeError: until the reconstruct extra (Open3D) is wired in.
    """
    raise RuntimeError("TSDF fusion lands with the pipeline milestone; install the 'reconstruct' extra.")
