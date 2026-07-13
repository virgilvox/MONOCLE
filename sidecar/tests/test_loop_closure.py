"""Tests for loop-closure detection between temporally distant keyframes.

The pure geometry (candidate enumeration, the metric scale of a unit translation)
runs everywhere on numpy. The match-and-verify path needs OpenCV, so those tests
build a synthetic scene: a cloud of 3-D points, each carrying a unique ORB-like
descriptor, is projected into cameras at known poses. Two cameras that see the
same points (a revisit) then match and verify; cameras that see disjoint clouds
do not. This exercises the real cv2 matcher, essential-matrix estimate, and pose
recovery without needing captured imagery.
"""

from __future__ import annotations

import numpy as np
import pytest

from monocle_sidecar.pose.loop_closure import (
    Keyframe,
    _assert_single_camera,
    candidate_pairs,
    detect_loop_edges,
    effective_index_gap,
    loop_edge_information,
    metric_translation,
    verify_pair,
)
from monocle_sidecar.pose.metric_scale import DepthAffine
from monocle_sidecar.pose.pose_graph import _DEFAULT_LOOP_WEIGHT, relative_transform

_WIDTH, _HEIGHT = 320, 240
# depth affine identity: metric depth = 1 / (1 * inverse_depth + 0) = camera z.
_AFFINE = DepthAffine(a=1.0, b=0.0)


def _k() -> np.ndarray:
    return np.array([[250.0, 0.0, 160.0], [0.0, 250.0, 120.0], [0.0, 0.0, 1.0]])


def _pose(x: float, y: float, z: float) -> np.ndarray:
    """World-from-camera at a position with identity rotation (camera looks +z)."""
    pose = np.eye(4)
    pose[:3, 3] = (x, y, z)
    return pose


def _cloud(rng: np.random.Generator, n: int) -> np.ndarray:
    """3-D points in a metric window in front of a camera at the origin."""
    xs = rng.uniform(-0.5, 0.5, n)
    ys = rng.uniform(-0.4, 0.4, n)
    zs = rng.uniform(0.6, 1.6, n)
    return np.stack([xs, ys, zs], axis=1)


def _descriptors(rng: np.random.Generator, n: int) -> np.ndarray:
    return rng.integers(0, 256, size=(n, 32), dtype=np.uint8)


def _project(points: np.ndarray, k: np.ndarray, pose_wc: np.ndarray):
    """Return (u, v, z) of world points in the camera of world-from-camera pose."""
    cw = np.linalg.inv(pose_wc)
    cam = points @ cw[:3, :3].T + cw[:3, 3]
    z = cam[:, 2]
    proj = (k @ cam.T).T
    with np.errstate(divide="ignore", invalid="ignore"):
        u = proj[:, 0] / z
        v = proj[:, 1] / z
    return u, v, z


def _keyframe(index, points, descriptors, k, pose_wc) -> Keyframe:
    """Project a cloud into one camera and pack the visible features + disparity."""
    u, v, z = _project(points, k, pose_wc)
    visible = (z > 1e-3) & (u >= 0) & (u < _WIDTH) & (v >= 0) & (v < _HEIGHT)
    keypoints = np.stack([u[visible], v[visible]], axis=1)
    disparity = np.zeros((_HEIGHT, _WIDTH), dtype=np.float32)
    cols = np.clip(np.round(u[visible]).astype(int), 0, _WIDTH - 1)
    rows = np.clip(np.round(v[visible]).astype(int), 0, _HEIGHT - 1)
    disparity[rows, cols] = 1.0 / z[visible]  # inverse depth; affine maps it to z
    return Keyframe(
        index=index,
        keypoints=keypoints,
        descriptors=np.ascontiguousarray(descriptors[visible]),
        k=k,
        disparity=disparity,
    )


# --- pure geometry, no cv2 ---------------------------------------------------


def test_candidate_pairs_enforce_minimum_gap():
    pairs = candidate_pairs(6, min_index_gap=4)
    assert (0, 4) in pairs and (0, 5) in pairs and (1, 5) in pairs
    # Nothing closer than the gap, and every source precedes its target.
    assert all(target - source >= 4 and source < target for source, target in pairs)
    # Consecutive frames are never proposed as loops.
    assert (0, 1) not in pairs


def test_candidate_pairs_rejects_degenerate_gap():
    with pytest.raises(ValueError):
        candidate_pairs(5, min_index_gap=0)


def test_effective_index_gap_adapts_to_short_captures():
    # A third of the length, never above the requested gap, never below 1.
    assert effective_index_gap(30, 8) == 8  # long capture keeps the full gap
    assert effective_index_gap(16, 8) == 5
    assert effective_index_gap(12, 8) == 4
    assert effective_index_gap(9, 8) == 3
    assert effective_index_gap(3, 8) == 1  # never disabled on a tiny capture
    assert effective_index_gap(1, 8) == 1


def test_effective_index_gap_rejects_degenerate_gap():
    with pytest.raises(ValueError):
        effective_index_gap(10, 0)


def test_adapted_gap_keeps_short_captures_from_disabling_loop_closure():
    # The audit's failing counts: at the old fixed gap of 15 every one of these
    # yielded zero candidate pairs, silently disabling loop closure. Adapting the
    # gap to the sequence length restores at least one candidate for each.
    for count in (8, 12, 15, 16, 20):
        gap = effective_index_gap(count, 8)
        assert candidate_pairs(count, gap), f"count={count} still has no candidates"
        # The old behavior this fixes: a large fixed gap starves the short capture.
        assert candidate_pairs(count, 15) == [] or count > 15


def test_metric_translation_recovers_the_true_baseline():
    rng = np.random.default_rng(1)
    k = _k()
    points = _cloud(rng, 120)
    source_pose = _pose(0.0, 0.0, 0.0)
    target_pose = _pose(0.12, 0.0, 0.0)  # a real, known baseline

    rel = relative_transform(source_pose, target_pose)  # target-from-source
    rot = rel[:3, :3]
    full_t = rel[:3, 3]
    unit_t = full_t / np.linalg.norm(full_t)

    u0, v0, z0 = _project(points, k, source_pose)
    u1, v1, _z1 = _project(points, k, target_pose)
    pts_source = np.stack([u0, v0], axis=1)
    pts_target = np.stack([u1, v1], axis=1)

    disparity = np.zeros((_HEIGHT, _WIDTH), dtype=np.float32)
    cols = np.clip(np.round(u0).astype(int), 0, _WIDTH - 1)
    rows = np.clip(np.round(v0).astype(int), 0, _HEIGHT - 1)
    disparity[rows, cols] = 1.0 / z0

    metric = metric_translation(
        k, rot, unit_t, pts_source, pts_target, disparity, _AFFINE, min_samples=8
    )
    assert metric is not None
    # The scaled translation reproduces the true metric baseline.
    np.testing.assert_allclose(metric, full_t, atol=1e-2)


# --- loop-edge distance taper, pure ------------------------------------------


def test_loop_edge_information_tapers_with_distance():
    # A loop at (or within) the near gap keeps the full base weight; a more distant
    # loop is down-weighted by near_gap / gap.
    near = loop_edge_information(4, near_gap=4)
    twice = loop_edge_information(8, near_gap=4)
    thrice = loop_edge_information(12, near_gap=4)
    assert np.allclose(near, np.identity(6) * _DEFAULT_LOOP_WEIGHT)
    assert np.allclose(twice, np.identity(6) * (_DEFAULT_LOOP_WEIGHT / 2))
    assert np.allclose(thrice, np.identity(6) * (_DEFAULT_LOOP_WEIGHT / 3))
    # Inside the near gap the weight is capped at the base, never boosted above it.
    assert np.allclose(loop_edge_information(2, near_gap=4), near)


def test_loop_edge_information_is_monotonic_and_positive():
    weights = [loop_edge_information(gap, near_gap=4)[0, 0] for gap in range(4, 40)]
    assert all(later <= earlier for earlier, later in zip(weights, weights[1:]))
    assert all(w > 0 for w in weights)


def test_loop_edge_information_rejects_degenerate_arguments():
    with pytest.raises(ValueError):
        loop_edge_information(0)
    with pytest.raises(ValueError):
        loop_edge_information(5, near_gap=0)


# --- single-camera intrinsics guard, pure ------------------------------------


def _bare_keyframe(index: int, k: np.ndarray) -> Keyframe:
    return Keyframe(
        index=index,
        keypoints=np.zeros((0, 2)),
        descriptors=None,
        k=k,
        disparity=np.zeros((4, 4), dtype=np.float32),
    )


def test_single_camera_guard_rejects_mismatched_intrinsics():
    k1 = _k()
    k2 = k1.copy()
    k2[0, 0] = 500.0  # a different focal length: a second camera
    with pytest.raises(ValueError, match="single camera"):
        _assert_single_camera(_bare_keyframe(0, k1), _bare_keyframe(1, k2))
    # Identical intrinsics (the one intrinsics.json the pose stage loads) pass.
    _assert_single_camera(_bare_keyframe(0, k1), _bare_keyframe(1, k1.copy()))


def test_verify_pair_enforces_single_camera_before_matching():
    # The guard fires on the public path before any cv2 work, so dummy cv2/matcher
    # objects are never touched: a mismatch is a hard error, not a silent bad pose.
    k1 = _k()
    k2 = k1.copy()
    k2[1, 1] = 999.0
    with pytest.raises(ValueError, match="single camera"):
        verify_pair(
            _bare_keyframe(0, k1),
            _bare_keyframe(1, k2),
            _AFFINE,
            cv2=object(),
            matcher=object(),
        )


# --- match + verify, needs cv2 ----------------------------------------------


def test_detects_a_planted_revisit_as_a_metric_edge():
    pytest.importorskip("cv2")
    rng = np.random.default_rng(2)
    k = _k()
    loop_points = _cloud(rng, 90)
    loop_desc = _descriptors(rng, 90)

    keyframes = [_keyframe(0, loop_points, loop_desc, k, _pose(0.0, 0.0, 0.0))]
    # Filler frames in between, each with its own disjoint cloud so nothing but
    # the planted pair can match.
    for index in range(1, 5):
        filler_points = _cloud(rng, 60)
        keyframes.append(_keyframe(index, filler_points, _descriptors(rng, 60), k, _pose(0, 0, 0)))
    # The revisit: same points as frame 0, seen from a nearby, parallax-inducing
    # viewpoint.
    baseline = np.array([0.1, 0.02, 0.0])
    keyframes.append(_keyframe(5, loop_points, loop_desc, k, _pose(*baseline)))

    edges = detect_loop_edges(
        keyframes,
        _AFFINE,
        min_index_gap=4,
        min_matches=12,
        min_inliers=8,
        min_parallax_px=0.5,
    )

    assert len(edges) == 1
    edge = edges[0]
    assert (edge.source, edge.target) == (0, 5)
    # The edge translation is metric: it matches the true baseline magnitude.
    measured = float(np.linalg.norm(edge.transformation[:3, 3]))
    assert measured == pytest.approx(np.linalg.norm(baseline), rel=0.15)


def test_rejects_a_non_revisit():
    pytest.importorskip("cv2")
    rng = np.random.default_rng(3)
    k = _k()
    # Two temporally distant frames that look at entirely different clouds.
    first = _keyframe(0, _cloud(rng, 80), _descriptors(rng, 80), k, _pose(0, 0, 0))
    fillers = [
        _keyframe(i, _cloud(rng, 40), _descriptors(rng, 40), k, _pose(0, 0, 0))
        for i in range(1, 5)
    ]
    last = _keyframe(5, _cloud(rng, 80), _descriptors(rng, 80), k, _pose(0.1, 0.0, 0.0))
    edges = detect_loop_edges(
        [first, *fillers, last], _AFFINE, min_index_gap=4, min_matches=12, min_inliers=8
    )
    assert edges == []


def test_minimum_gap_excludes_a_near_revisit():
    pytest.importorskip("cv2")
    rng = np.random.default_rng(4)
    k = _k()
    points = _cloud(rng, 90)
    desc = _descriptors(rng, 90)
    # The only matching pair is two frames apart; a larger gap excludes it.
    keyframes = [
        _keyframe(0, points, desc, k, _pose(0, 0, 0)),
        _keyframe(1, _cloud(rng, 50), _descriptors(rng, 50), k, _pose(0, 0, 0)),
        _keyframe(2, points, desc, k, _pose(0.1, 0.0, 0.0)),
    ]
    edges = detect_loop_edges(keyframes, _AFFINE, min_index_gap=5, min_matches=12, min_inliers=8)
    assert edges == []


def test_distant_loop_gets_lower_information_than_a_near_loop():
    pytest.importorskip("cv2")
    rng = np.random.default_rng(6)
    k = _k()
    # Two independent revisits at different temporal spans. Cloud A closes a near
    # loop (frames 0 -> 6, gap 6); cloud B closes a far loop (frames 2 -> 14, gap
    # 12). Every other frame carries a disjoint cloud so only the planted pairs
    # match. The far loop's frozen-affine scale is trusted less, so its edge
    # information must be smaller.
    cloud_a, desc_a = _cloud(rng, 90), _descriptors(rng, 90)
    cloud_b, desc_b = _cloud(rng, 90), _descriptors(rng, 90)
    baseline = _pose(0.1, 0.02, 0.0)
    plants = {
        0: (cloud_a, desc_a, _pose(0, 0, 0)),
        6: (cloud_a, desc_a, baseline),
        2: (cloud_b, desc_b, _pose(0, 0, 0)),
        14: (cloud_b, desc_b, baseline),
    }
    keyframes = []
    for index in range(15):
        if index in plants:
            points, desc, pose = plants[index]
        else:
            points, desc, pose = _cloud(rng, 50), _descriptors(rng, 50), _pose(0, 0, 0)
        keyframes.append(_keyframe(index, points, desc, k, pose))

    edges = detect_loop_edges(
        keyframes,
        _AFFINE,
        min_index_gap=4,
        min_matches=12,
        min_inliers=8,
        min_parallax_px=0.5,
    )

    by_pair = {(edge.source, edge.target): edge for edge in edges}
    assert (0, 6) in by_pair and (2, 14) in by_pair
    near_info = by_pair[(0, 6)].information
    far_info = by_pair[(2, 14)].information
    # The distant loop carries strictly less weight than the near one.
    assert far_info[0, 0] < near_info[0, 0]
    # And the exact taper: base * near_gap / gap, with near_gap == min_index_gap.
    assert near_info[0, 0] == pytest.approx(_DEFAULT_LOOP_WEIGHT * 4 / 6)
    assert far_info[0, 0] == pytest.approx(_DEFAULT_LOOP_WEIGHT * 4 / 12)


def test_explicit_information_overrides_the_distance_taper():
    pytest.importorskip("cv2")
    rng = np.random.default_rng(2)
    k = _k()
    loop_points, loop_desc = _cloud(rng, 90), _descriptors(rng, 90)
    keyframes = [_keyframe(0, loop_points, loop_desc, k, _pose(0.0, 0.0, 0.0))]
    for index in range(1, 5):
        keyframes.append(_keyframe(index, _cloud(rng, 60), _descriptors(rng, 60), k, _pose(0, 0, 0)))
    keyframes.append(_keyframe(5, loop_points, loop_desc, k, _pose(0.1, 0.02, 0.0)))

    override = np.identity(6) * 7.0
    edges = detect_loop_edges(
        keyframes,
        _AFFINE,
        min_index_gap=4,
        min_matches=12,
        min_inliers=8,
        min_parallax_px=0.5,
        information=override,
    )
    assert len(edges) == 1
    # An explicit information matrix is used verbatim, not tapered.
    np.testing.assert_array_equal(edges[0].information, override)
