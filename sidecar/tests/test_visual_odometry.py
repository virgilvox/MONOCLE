"""Tests for the ORB visual-odometry pose estimator.

The pose-chaining math and the intrinsics fallback are pure numpy and are tested
deterministically. The full estimator needs OpenCV and real image features, so
those tests are skipped when cv2 is absent (the plain CI environment) and assert
the estimator's structural contract (shape, first pose identity, valid SE(3)
poses) rather than exact recovered motion, which depends on real imagery.
"""

from __future__ import annotations

import numpy as np
import pytest

from monocle_sidecar.pose import OrbVisualOdometry, PoseResult
from monocle_sidecar.pose.base import FrameRef
from monocle_sidecar.pose.visual_odometry import (
    _camera_matrix,
    _compose_camera_from_world,
    _default_intrinsics,
)


def test_default_intrinsics_center_and_focal():
    intr = _default_intrinsics(640, 480)
    assert intr["cx"] == 320.0
    assert intr["cy"] == 240.0
    # Focal defaults to the larger image side.
    assert intr["fx"] == 640.0
    assert intr["fy"] == 640.0
    k = _camera_matrix(intr)
    assert k.shape == (3, 3)
    assert k[2, 2] == 1.0


def test_compose_pure_translation():
    # First camera is the world frame. A relative motion of R = I, t = [1, 0, 0]
    # (the new camera sees world points shifted by -t) advances camera-from-world
    # to that translation, so the camera sits at world position -t.
    prev_cfw = np.eye(4)
    cfw = _compose_camera_from_world(prev_cfw, np.eye(3), np.array([1.0, 0.0, 0.0]))
    world_from_camera = np.linalg.inv(cfw)
    assert np.allclose(world_from_camera[:3, 3], [-1.0, 0.0, 0.0])
    assert np.allclose(world_from_camera[:3, :3], np.eye(3))


def test_compose_chains_rotations():
    # Two successive 90 degree yaw steps compose to 180 degrees.
    yaw = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]])
    cfw = _compose_camera_from_world(np.eye(4), yaw, np.zeros(3))
    cfw = _compose_camera_from_world(cfw, yaw, np.zeros(3))
    expected = yaw @ yaw
    assert np.allclose(cfw[:3, :3], expected)


def test_empty_frames_raises():
    with pytest.raises(ValueError):
        OrbVisualOdometry().estimate([])


def _write_noise_image(path, rng, size=(240, 320)):
    cv2 = pytest.importorskip("cv2")
    image = rng.integers(0, 255, size=size, dtype=np.uint8)
    cv2.imwrite(str(path), image)


def test_estimate_returns_valid_se3_poses(tmp_path):
    pytest.importorskip("cv2")
    rng = np.random.default_rng(0)
    frames = []
    for i in range(3):
        path = tmp_path / f"frame_{i:05d}.png"
        _write_noise_image(path, rng)
        frames.append(FrameRef(image=path))

    result = OrbVisualOdometry().estimate(frames)
    assert isinstance(result, PoseResult)
    assert len(result) == 3
    assert result.poses.shape == (3, 4, 4)

    # The first camera defines the world frame.
    assert np.allclose(result.poses[0], np.eye(4))

    # Every pose is a valid rigid transform: orthonormal rotation, unit
    # determinant, and a clean homogeneous bottom row.
    for pose in result.poses:
        rot = pose[:3, :3]
        assert np.allclose(rot @ rot.T, np.eye(3), atol=1e-6)
        assert np.isclose(np.linalg.det(rot), 1.0, atol=1e-6)
        assert np.allclose(pose[3], [0.0, 0.0, 0.0, 1.0])

    # extrinsics() inverts back to camera-from-world for fusion.
    extr = result.extrinsics()
    assert extr.shape == (3, 4, 4)
    assert np.allclose(extr[0] @ result.poses[0], np.eye(4), atol=1e-6)
