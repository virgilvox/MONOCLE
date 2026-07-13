"""Tests for the keyframe pose-graph optimizer.

The pure edge math runs everywhere; the optimization itself needs Open3D (the
reconstruct extra) and is skipped gracefully where that is not installed, like
the other heavy-path tests.
"""

from __future__ import annotations

import numpy as np
import pytest

from monocle_sidecar.pose.pose_graph import (
    LoopEdge,
    optimize_pose_graph,
    relative_transform,
)


def _translation(x: float, y: float, z: float) -> np.ndarray:
    """A world-from-camera pose at a position with identity rotation."""
    pose = np.identity(4)
    pose[:3, 3] = (x, y, z)
    return pose


def test_relative_transform_is_target_from_source() -> None:
    source = _translation(1.0, 0.0, 0.0)
    target = _translation(1.0, 2.0, 0.0)
    rel = relative_transform(source, target)
    # Mapping the source camera origin into the target frame gives -(target-source).
    np.testing.assert_allclose(rel[:3, 3], [0.0, -2.0, 0.0], atol=1e-9)
    # Composing target with the relative recovers the source pose.
    np.testing.assert_allclose(target @ rel, source, atol=1e-9)


def _square_loop_poses() -> np.ndarray:
    """Nine world-from-camera poses walking a unit square back to the origin."""
    steps = [(1, 0, 0)] * 2 + [(0, 1, 0)] * 2 + [(-1, 0, 0)] * 2 + [(0, -1, 0)] * 2
    position = np.zeros(3)
    poses = [_translation(*position)]
    for step in steps:
        position = position + np.array(step, dtype=float)
        poses.append(_translation(*position))
    return np.array(poses)  # poses[0] == poses[8] == origin: a closed loop


def _drifted(poses: np.ndarray, drift: np.ndarray) -> np.ndarray:
    """Accumulate a constant per-step translation drift into each pose."""
    drifted = poses.copy()
    for index in range(1, len(drifted)):
        drifted[index, :3, 3] += drift * index
    return drifted


def test_loop_edge_closes_a_drifted_trajectory() -> None:
    o3d = pytest.importorskip("open3d")
    assert hasattr(o3d.pipelines.registration, "global_optimization")

    true_poses = _square_loop_poses()
    drift = np.array([0.05, 0.03, 0.0])
    odom = _drifted(true_poses, drift)

    last = len(odom) - 1
    open_gap = float(np.linalg.norm(odom[last, :3, 3] - odom[0, :3, 3]))
    assert open_gap > 0.4  # the drifted trajectory does not close

    # The true relative from the last keyframe back to the first is identity
    # (they are the same physical spot), the loop constraint we measured.
    loop = LoopEdge(
        source=last,
        target=0,
        transformation=relative_transform(true_poses[last], true_poses[0]),
    )
    optimized = optimize_pose_graph(odom, [loop])

    closed_gap = float(np.linalg.norm(optimized[last, :3, 3] - optimized[0, :3, 3]))
    # The optimizer redistributes the drift so the loop closes far tighter.
    assert closed_gap < open_gap * 0.25


def test_without_loop_edges_poses_are_left_alone() -> None:
    pytest.importorskip("open3d")
    true_poses = _square_loop_poses()
    odom = _drifted(true_poses, np.array([0.05, 0.03, 0.0]))
    optimized = optimize_pose_graph(odom)
    # A pure chain has nothing to correct; poses come back essentially unchanged.
    np.testing.assert_allclose(optimized, odom, atol=1e-6)


def test_rejects_malformed_poses_and_edges() -> None:
    pytest.importorskip("open3d")
    with pytest.raises(ValueError):
        optimize_pose_graph(np.zeros((3, 3)))
    with pytest.raises(ValueError):
        optimize_pose_graph(np.zeros((0, 4, 4)))
    with pytest.raises(ValueError):
        optimize_pose_graph(
            np.stack([np.identity(4), np.identity(4)]),
            [LoopEdge(source=0, target=5, transformation=np.identity(4))],
        )
