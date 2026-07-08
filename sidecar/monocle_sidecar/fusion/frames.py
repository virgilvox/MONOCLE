"""The posed depth frame that every fusion strategy consumes.

A depth backend produces these; a fusion strategy (TSDF, point-map merge)
integrates them. Numpy is imported at module top because this module only ever
loads on the reconstruct path, where numpy is already present.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class PosedDepthFrame:
    """One depth frame with everything needed to place it in world space.

    Attributes:
        depth: (H, W) float32 metric depth in meters. A value of 0 means the
            pixel has no valid depth and is ignored during integration.
        intrinsics: pinhole intrinsics in pixels with keys fx, fy, cx, cy,
            width, height.
        pose: (4, 4) float64 camera-from-world (world->camera) matrix. This is
            the extrinsic Open3D's TSDF integrate expects.
        color: (H, W, 3) uint8 RGB aligned to depth, or None for depth-only.
    """

    depth: np.ndarray
    intrinsics: dict
    pose: np.ndarray
    color: np.ndarray | None = None
