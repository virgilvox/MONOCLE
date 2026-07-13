"""Tests for the orb-pgo estimator: ORB VO plus loop closure and optimization.

The estimator is registered and selectable like the others. Its refinement core
(``refine_poses``) is exercised on a synthetic looped trajectory: odometry that
has drifted open is fed with keyframes whose first and last frames see the same
planted cloud, and the pose-graph optimization must pull the loop shut far
tighter than the raw drifted track. That path needs cv2 (match and verify) and
Open3D (global optimization), so it is skipped where those extras are absent. The
full ``estimate`` over image files additionally needs the Depth Anything V2
weights and is out of scope here; the geometry it relies on is covered directly.
"""

from __future__ import annotations

import numpy as np
import pytest

from monocle_sidecar.pose import OrbPgoPoseEstimator, make_estimator
from monocle_sidecar.pose.loop_closure import Keyframe
from monocle_sidecar.pose.metric_scale import DepthAffine
from monocle_sidecar.pose.orb_pgo import refine_poses

_WIDTH, _HEIGHT = 320, 240
_AFFINE = DepthAffine(a=1.0, b=0.0)


def _k() -> np.ndarray:
    return np.array([[250.0, 0.0, 160.0], [0.0, 250.0, 120.0], [0.0, 0.0, 1.0]])


def _pose(position) -> np.ndarray:
    pose = np.eye(4)
    pose[:3, 3] = position
    return pose


def _cloud(rng, n, center):
    pts = np.stack(
        [rng.uniform(-0.5, 0.5, n), rng.uniform(-0.4, 0.4, n), rng.uniform(0.6, 1.6, n)], axis=1
    )
    return pts + np.asarray(center)


def _descriptors(rng, n):
    return rng.integers(0, 256, size=(n, 32), dtype=np.uint8)


def _keyframe(index, points, descriptors, pose_wc) -> Keyframe:
    k = _k()
    cw = np.linalg.inv(pose_wc)
    cam = points @ cw[:3, :3].T + cw[:3, 3]
    z = cam[:, 2]
    proj = (k @ cam.T).T
    with np.errstate(divide="ignore", invalid="ignore"):
        u, v = proj[:, 0] / z, proj[:, 1] / z
    visible = (z > 1e-3) & (u >= 0) & (u < _WIDTH) & (v >= 0) & (v < _HEIGHT)
    disparity = np.zeros((_HEIGHT, _WIDTH), dtype=np.float32)
    cols = np.clip(np.round(u[visible]).astype(int), 0, _WIDTH - 1)
    rows = np.clip(np.round(v[visible]).astype(int), 0, _HEIGHT - 1)
    disparity[rows, cols] = 1.0 / z[visible]
    return Keyframe(
        index=index,
        keypoints=np.stack([u[visible], v[visible]], axis=1),
        descriptors=np.ascontiguousarray(descriptors[visible]),
        k=k,
        disparity=disparity,
    )


def test_orb_pgo_is_selectable():
    assert isinstance(make_estimator("orb-pgo"), OrbPgoPoseEstimator)


def test_estimate_rejects_empty_frames():
    with pytest.raises(ValueError):
        OrbPgoPoseEstimator().estimate([])


def test_refine_closes_a_looped_trajectory():
    pytest.importorskip("cv2")
    pytest.importorskip("open3d")

    rng = np.random.default_rng(7)
    count = 9
    # The revisit: frame 0 and the final frame look at one shared cloud from two
    # nearby viewpoints, so the loop is real and has parallax.
    loop_points = _cloud(rng, 90, center=(0.0, 0.0, 0.0))
    loop_desc = _descriptors(rng, 90)
    revisit_offset = np.array([0.07, 0.0, 0.0])

    true_positions = [np.zeros(3)]
    keyframes = [_keyframe(0, loop_points, loop_desc, _pose(true_positions[0]))]
    # Intermediate frames wander and each see a disjoint cloud, so only the
    # planted pair can close.
    for index in range(1, count - 1):
        position = np.array([0.1 * index, 0.05 * index, 0.0])
        true_positions.append(position)
        cloud = _cloud(rng, 55, center=(0.1 * index, 0.05 * index, 0.0))
        keyframes.append(_keyframe(index, cloud, _descriptors(rng, 55), _pose(position)))
    true_positions.append(revisit_offset)
    keyframes.append(_keyframe(count - 1, loop_points, loop_desc, _pose(revisit_offset)))

    # Accumulate a constant per-step drift to model open odometry.
    drift = np.array([0.03, 0.02, 0.0])
    odom = np.stack([_pose(true_positions[i] + drift * i) for i in range(count)])

    open_gap = float(np.linalg.norm(odom[-1, :3, 3] - odom[0, :3, 3]))
    assert open_gap > 0.25  # the drifted track is clearly open

    optimized = refine_poses(
        odom,
        keyframes,
        _AFFINE,
        min_index_gap=4,
        min_matches=12,
        min_inliers=8,
        min_parallax_px=0.5,
    )
    assert optimized.shape == odom.shape
    closed_gap = float(np.linalg.norm(optimized[-1, :3, 3] - optimized[0, :3, 3]))
    # The loop constraint pulls the return frame back onto its true near-origin
    # position, closing far tighter than the raw drift.
    assert closed_gap < open_gap * 0.5
