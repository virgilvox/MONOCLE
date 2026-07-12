"""Tests for the pose stage that bridges an estimator to reconstruction.

These cover the estimator selection, the poses.json wire format (column-major
camera-from-world), the round trip, and running the stage end to end with the
identity estimator, which reads no image pixels so it needs only frame files.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from monocle_sidecar.pose import (
    IdentityPoseEstimator,
    MASt3RSlamPoseEstimator,
    OrbVisualOdometry,
    load_poses,
    make_estimator,
    run_pose_stage,
    write_poses_json,
)


def test_make_estimator_selects_by_id():
    assert isinstance(make_estimator("identity"), IdentityPoseEstimator)
    assert isinstance(make_estimator("orb"), OrbVisualOdometry)
    # mast3r resolves lazily but still constructs without importing torch.
    assert isinstance(make_estimator("mast3r"), MASt3RSlamPoseEstimator)


def test_make_estimator_rejects_unknown():
    with pytest.raises(ValueError):
        make_estimator("nope")


def test_poses_json_is_column_major_and_round_trips(tmp_path):
    # A distinctly asymmetric matrix so a row/column-major mixup would show.
    matrix = np.arange(16, dtype=np.float64).reshape(4, 4)
    write_poses_json(tmp_path, matrix[np.newaxis, :, :])

    on_disk = json.loads((tmp_path / "poses.json").read_text())["poses"][0]
    assert on_disk == matrix.flatten(order="F").tolist()

    loaded = load_poses(tmp_path)
    assert loaded.shape == (1, 4, 4)
    assert np.allclose(loaded[0], matrix)


def test_write_poses_json_rejects_bad_shape(tmp_path):
    with pytest.raises(ValueError):
        write_poses_json(tmp_path, np.zeros((3, 3)))


def test_run_pose_stage_identity_writes_identity_extrinsics(tmp_path):
    for i in range(3):
        (tmp_path / f"frame_{i:05d}.png").write_bytes(b"")

    out = run_pose_stage(tmp_path, estimator="identity")
    assert out == tmp_path / "poses.json"

    poses = load_poses(tmp_path)
    assert poses.shape == (3, 4, 4)
    # Identity world-from-camera inverts to identity camera-from-world.
    for pose in poses:
        assert np.allclose(pose, np.eye(4))


def test_run_pose_stage_requires_frames(tmp_path):
    with pytest.raises(RuntimeError):
        run_pose_stage(tmp_path, estimator="identity")
