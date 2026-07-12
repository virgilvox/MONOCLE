"""Tests for scale-adaptive TSDF parameter suggestion.

Pure numpy (PosedDepthFrame plus numpy stats), so no Open3D is required.
"""

from __future__ import annotations

import numpy as np

from monocle_sidecar.fusion.frames import PosedDepthFrame
from monocle_sidecar.fusion.tsdf import suggest_fusion_params

_INTR = {"fx": 400.0, "fy": 400.0, "cx": 80.0, "cy": 60.0, "width": 160.0, "height": 120.0}


def _frame(depth: np.ndarray) -> PosedDepthFrame:
    return PosedDepthFrame(depth=depth.astype(np.float32), intrinsics=_INTR, pose=np.eye(4))


def test_params_scale_with_depth_magnitude():
    near = [_frame(np.full((16, 16), 0.5))]
    far = [_frame(np.full((16, 16), 50.0))]  # same scene, 100x the scale

    p_near = suggest_fusion_params(near)
    p_far = suggest_fusion_params(far)

    # A 100x larger scene gets a ~100x larger voxel, keeping resolution constant.
    assert p_far["voxel_size"] / p_near["voxel_size"] == np.float64(100.0)
    assert p_far["depth_trunc"] > p_far["voxel_size"] * 100
    # Truncation stays a few voxels wide at either scale.
    assert 3.0 < p_near["sdf_trunc"] / p_near["voxel_size"] < 8.0


def test_params_ignore_invalid_depth():
    depth = np.zeros((16, 16), dtype=np.float32)
    depth[:8] = 0.5  # half valid, half the 0 sentinel
    params = suggest_fusion_params([_frame(depth)])
    assert params["voxel_size"] == np.float64(0.5) / 256.0


def test_params_fall_back_when_no_valid_depth():
    params = suggest_fusion_params([_frame(np.zeros((8, 8), dtype=np.float32))])
    assert params == {"voxel_size": 0.004, "sdf_trunc": 0.02, "depth_trunc": 3.0}
