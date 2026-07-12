"""Numeric tests for the depth/VO metric-scale bridge.

These build a synthetic two-view scene with known cameras and a known
affine-invariant disparity model, then prove the property the garbled scans
violated: a fixed 3D point reconstructs to the *same* world coordinate from
different frames. The final test shows the old per-frame renormalization fails
exactly that check, which is why it garbled fusion.

Pure numpy, no OpenCV or depth model, so it runs in the base CI environment.
"""

from __future__ import annotations

import numpy as np

from monocle_sidecar.pose.metric_scale import (
    DepthAffine,
    calibrate_depth_affine,
    median_displacement,
    translation_scale,
    triangulate,
)
from monocle_sidecar.pose.visual_odometry import _compose_camera_from_world

_K = np.array([[400.0, 0.0, 160.0], [0.0, 400.0, 120.0], [0.0, 0.0, 1.0]])


def _rot_y(deg: float) -> np.ndarray:
    r = np.radians(deg)
    c, s = np.cos(r), np.sin(r)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def _project(k: np.ndarray, pts_cam: np.ndarray) -> np.ndarray:
    """Pinhole-project (N, 3) camera-space points to (N, 2) pixels."""
    z = pts_cam[:, 2]
    u = k[0, 0] * pts_cam[:, 0] / z + k[0, 2]
    v = k[1, 1] * pts_cam[:, 1] / z + k[1, 2]
    return np.stack([u, v], axis=1)


def _disparity_model(depth: np.ndarray) -> np.ndarray:
    """An affine-invariant inverse-depth model: nearer is larger disparity.

    Unknown scale (3.0) and shift (0.7) stand in for the arbitrary affine a real
    depth network produces; the bridge must recover metric depth despite them.
    """
    return 3.0 / np.asarray(depth, dtype=np.float64) + 0.7


def _scene(n: int = 80):
    """A cloud in front of camera 0 and a second camera with a sideways baseline."""
    rng = np.random.default_rng(1)
    x = rng.uniform(-0.12, 0.12, n)
    y = rng.uniform(-0.09, 0.09, n)
    z = rng.uniform(0.30, 0.55, n)
    pts0 = np.stack([x, y, z], axis=1)

    rot = _rot_y(9.0)  # camera 0 -> camera 1
    trans = np.array([0.06, 0.005, 0.01])  # metric baseline, mostly sideways
    pts1 = pts0 @ rot.T + trans
    return pts0, rot, trans, pts1


def test_triangulate_recovers_points_up_to_baseline_scale():
    pts0, rot, trans, pts1 = _scene()
    px0 = _project(_K, pts0)
    px1 = _project(_K, pts1)

    unit_t = trans / np.linalg.norm(trans)
    recovered, valid = triangulate(_K, rot, unit_t, px0, px1)

    assert valid.all()
    # Triangulating at a unit baseline recovers the true geometry scaled by
    # 1/|t|, uniformly across all points.
    scaled = recovered * np.linalg.norm(trans)
    assert np.allclose(scaled, pts0, atol=1e-6)


def test_triangulate_rejects_points_behind_the_camera():
    pts0, rot, trans, pts1 = _scene(n=10)
    px0 = _project(_K, pts0)
    px1 = _project(_K, pts1)
    # Corrupt one correspondence so its triangulation lands behind a camera.
    px1[0] = np.array([5.0, 5.0])
    _, valid = triangulate(_K, rot, trans / np.linalg.norm(trans), px0, px1)
    assert not valid[0]
    assert valid[1:].all()


def test_calibrate_recovers_consistent_metric_depth():
    pts0, rot, trans, pts1 = _scene()
    px0 = _project(_K, pts0)
    px1 = _project(_K, pts1)
    z0 = pts0[:, 2]

    unit_t = trans / np.linalg.norm(trans)
    recovered, valid = triangulate(_K, rot, unit_t, px0, px1)
    disp0 = _disparity_model(z0)

    affine = calibrate_depth_affine(disp0[valid], recovered[valid, 2])
    assert affine is not None

    metric = affine.depth(disp0, min_depth=0.0, max_depth=10.0)
    # Metric depth is proportional to true depth (one shared scale)...
    ratio = metric / z0
    assert np.std(ratio) / np.mean(ratio) < 1e-6
    # ...and normalized so the scene sits near the target median depth.
    assert abs(float(np.median(metric)) - 0.4) < 1e-6


def test_translation_scale_matches_true_baseline():
    pts0, rot, trans, pts1 = _scene()
    px0 = _project(_K, pts0)
    px1 = _project(_K, pts1)
    z0 = pts0[:, 2]

    unit_t = trans / np.linalg.norm(trans)
    recovered, valid = triangulate(_K, rot, unit_t, px0, px1)
    disp0 = _disparity_model(z0)
    affine = calibrate_depth_affine(disp0[valid], recovered[valid, 2])
    assert affine is not None

    metric0 = affine.depth(disp0, min_depth=0.0, max_depth=10.0)
    ts = translation_scale(metric0[valid], recovered[valid, 2])
    assert ts is not None

    # The recovered metric baseline equals the true baseline times the global
    # world scale the calibration imposed (0.4 / median true depth).
    world_scale = 0.4 / float(np.median(z0))
    assert abs(ts - world_scale * np.linalg.norm(trans)) < 1e-6


def test_cross_frame_world_consistency():
    """A fixed point reconstructs to the same world coordinate from both frames.

    This is the invariant TSDF fusion needs and the old engine broke. It drives
    the whole bridge: triangulate, calibrate depth, recover the metric camera
    pose, and back-project each frame's depth into world space.
    """
    pts0, rot, trans, pts1 = _scene()
    px0 = _project(_K, pts0)
    px1 = _project(_K, pts1)
    z0 = pts0[:, 2]
    z1 = pts1[:, 2]

    unit_t = trans / np.linalg.norm(trans)
    recovered, valid = triangulate(_K, rot, unit_t, px0, px1)
    assert valid.all()

    disp0 = _disparity_model(z0)
    disp1 = _disparity_model(z1)
    affine = calibrate_depth_affine(disp0, recovered[:, 2])
    assert affine is not None

    metric0 = affine.depth(disp0, min_depth=0.0, max_depth=10.0)
    metric1 = affine.depth(disp1, min_depth=0.0, max_depth=10.0)

    ts = translation_scale(metric0, recovered[:, 2])
    cfw1 = _compose_camera_from_world(np.eye(4), rot, unit_t * ts)

    world0 = _backproject_to_world(px0, metric0, np.eye(4))
    world1 = _backproject_to_world(px1, metric1, cfw1)
    assert np.allclose(world0, world1, atol=1e-6)


def test_per_frame_normalization_breaks_consistency():
    """The old approach: each frame's depth is renormalized independently.

    The same two frames reconstruct the same points to *different* world
    coordinates, which is precisely the garble this fix removes.
    """
    pts0, rot, trans, pts1 = _scene()
    px0 = _project(_K, pts0)
    px1 = _project(_K, pts1)
    z0, z1 = pts0[:, 2], pts1[:, 2]

    def per_frame_metric(depth, near=0.2, far=0.6):
        disp = _disparity_model(depth)
        lo, hi = disp.min(), disp.max()
        norm = (disp - lo) / (hi - lo)
        return far - norm * (far - near)

    # A plausible (even generous) fixed camera baseline, as the old engine used.
    cfw1 = _compose_camera_from_world(np.eye(4), rot, trans)
    world0 = _backproject_to_world(px0, per_frame_metric(z0), np.eye(4))
    world1 = _backproject_to_world(px1, per_frame_metric(z1), cfw1)
    # Independent per-frame windows put the same surface in different places.
    assert not np.allclose(world0, world1, atol=1e-2)


def test_depth_affine_zeros_invalid_pixels():
    affine = DepthAffine(a=1.0, b=0.0)
    disp = np.array([[2.0, -5.0], [1e6, 0.5]])  # negative and huge inverse depths
    depth = affine.depth(disp, min_depth=0.1, max_depth=1.0)
    assert depth[0, 0] == 0.5  # 1/2.0, in window
    assert depth[0, 1] == 0.0  # negative inverse depth -> invalid
    assert depth[1, 0] == 0.0  # depth 1e-6, below min -> invalid
    assert depth[1, 1] == 0.0  # 1/0.5 = 2.0, above max -> invalid


def test_calibrate_rejects_too_few_points():
    assert calibrate_depth_affine(np.array([1.0, 2.0]), np.array([0.5, 0.4])) is None


def test_median_displacement():
    pts0 = np.array([[0.0, 0.0], [10.0, 0.0]])
    pts1 = np.array([[3.0, 4.0], [13.0, 4.0]])  # each moved 5 px
    assert abs(median_displacement(pts0, pts1) - 5.0) < 1e-9


def _backproject_to_world(px, depth, cfw):
    """Back-project pixels at metric depth into world space via a camera pose.

    ``cfw`` is camera-from-world (world->camera); its inverse places camera
    points in the world. Mirrors what TSDF fusion does internally.
    """
    rays = np.stack(
        [(px[:, 0] - _K[0, 2]) / _K[0, 0], (px[:, 1] - _K[1, 2]) / _K[1, 1], np.ones(len(px))],
        axis=1,
    )
    cam_pts = rays * np.asarray(depth).reshape(-1, 1)
    wfc = np.linalg.inv(cfw)
    homog = np.hstack([cam_pts, np.ones((len(cam_pts), 1))])
    return (homog @ wfc.T)[:, :3]
