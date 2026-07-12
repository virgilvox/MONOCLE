"""Tests for the pose estimation seam and its identity implementation.

These run on numpy alone (no torch, open3d, or model weights), so they are not
skipped in CI: the seam every future SLAM backend plugs into must stay covered.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from monocle_sidecar.pose import (
    FrameRef,
    IdentityPoseEstimator,
    PoseResult,
)


def _frames(count: int) -> list[FrameRef]:
    return [FrameRef(image=Path(f"frame_{i:05d}.png")) for i in range(count)]


def test_identity_returns_one_pose_per_frame() -> None:
    result = IdentityPoseEstimator().estimate(_frames(5))

    assert isinstance(result, PoseResult)
    assert len(result) == 5
    assert result.poses.shape == (5, 4, 4)


def test_identity_poses_are_identity() -> None:
    result = IdentityPoseEstimator().estimate(_frames(3))

    expected = np.broadcast_to(np.eye(4), (3, 4, 4))
    assert np.array_equal(result.poses, expected)
    assert result.poses.dtype == np.float64


def test_identity_extrinsics_are_identity() -> None:
    # Inverting identity world-from-camera poses is still identity, the extrinsic
    # a static-camera fusion pass would integrate with.
    result = IdentityPoseEstimator().estimate(_frames(2))

    extrinsics = result.extrinsics()
    assert extrinsics.shape == (2, 4, 4)
    assert np.allclose(extrinsics, np.broadcast_to(np.eye(4), (2, 4, 4)))


def test_identity_rejects_empty_input() -> None:
    with pytest.raises(ValueError, match="at least one frame"):
        IdentityPoseEstimator().estimate([])


def test_pose_result_rejects_wrong_shape() -> None:
    with pytest.raises(ValueError, match="shape"):
        PoseResult(poses=np.zeros((4, 4)))
