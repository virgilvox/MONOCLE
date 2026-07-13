"""Detect loop closures between temporally distant keyframes for the pose graph.

Visual odometry chains motion frame to frame, so error accumulates and a path
that returns to an earlier viewpoint does not close. A pose-graph optimizer
(``pose/pose_graph.py``) fixes that, but only if it is fed loop constraints: a
measured relative pose between two keyframes that see the same place at different
times. This module produces those constraints.

For a candidate pair of keyframes (temporally distant enough that they are a real
revisit, not odometry) it:

  1. brute-force matches their ORB descriptors with Lowe's ratio test,
  2. gates on parallax (``median_displacement``) so a near-pure-rotation or a
     barely-moved pair, where essential-matrix pose is ill-conditioned, is
     dropped,
  3. geometrically verifies the match with ``findEssentialMat`` +
     ``recoverPose``, requiring a minimum inlier count, and
  4. scales the recovered unit translation into metric using the frozen depth
     affine, exactly the way the online walk-around scales each baseline
     (``metric_scale.translation_scale`` against triangulated unit-baseline
     depths), so the loop edge is in the same units as the keyframe poses.

A verified, scaled pair becomes a ``pose_graph.LoopEdge`` whose transformation is
target-from-source (``recoverPose`` maps the source camera into the target
camera). The pure, numpy-only helpers (candidate enumeration, the metric scale of
a unit translation, the rigid-transform assembly) are kept separate from the cv2
matching and verification so the geometry is unit-testable without image pixels.

cv2 is imported lazily, like the rest of the pose package, so importing this
module stays numpy-only for the plain CI environment.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from .metric_scale import (
    DepthAffine,
    calibrate_depth_affine,
    median_displacement,
    sample_nearest,
    translation_scale,
    triangulate,
)
from .pose_graph import LoopEdge

# Defaults tuned for a webcam walk-around. A loop must be at least this many
# keyframes back so consecutive, near-identical frames are never treated as a
# revisit; the rest gate the match strength the way live.py gates a frame.
_MIN_INDEX_GAP = 15
_RATIO = 0.75
_MIN_MATCHES = 25
_MIN_INLIERS = 15
_MIN_PARALLAX_PX = 3.0
# A triangulated pair needs at least this many valid points to trust its metric
# scale, matching the online step's floor.
_MIN_SCALE_SAMPLES = 8


@dataclass(frozen=True)
class Keyframe:
    """One keyframe's features for loop detection.

    Attributes:
        index: position of this keyframe in the capture (the pose-graph node id).
        keypoints: (M, 2) float64 pixel coordinates of the ORB keypoints.
        descriptors: (M, 32) uint8 ORB descriptors, one row per keypoint, or None
            when the frame yielded no features.
        k: (3, 3) pinhole intrinsics in the same pixel frame as ``keypoints``.
        disparity: dense up-to-scale disparity (inverse depth) aligned to the
            keypoint pixel frame, used with the frozen depth affine to put the
            edge translation into metric. None disables metric scaling for edges
            sourced at this keyframe.
    """

    index: int
    keypoints: np.ndarray
    descriptors: np.ndarray | None
    k: np.ndarray
    disparity: np.ndarray | None = None


def candidate_pairs(count: int, min_index_gap: int = _MIN_INDEX_GAP) -> list[tuple[int, int]]:
    """Ordered (source, target) keyframe index pairs at least a gap apart.

    Pure and cv2-free. Only pairs whose indices differ by ``min_index_gap`` or
    more are returned, which is what keeps consecutive frames (odometry) from
    being proposed as loops. Source is always the earlier index.
    """
    if min_index_gap < 1:
        raise ValueError("min_index_gap must be at least 1 to exclude self-pairs.")
    return [
        (source, target)
        for source in range(count)
        for target in range(source + min_index_gap, count)
    ]


def rigid_transform(rot: np.ndarray, trans: np.ndarray) -> np.ndarray:
    """Assemble a (4, 4) homogeneous transform from a rotation and translation."""
    matrix = np.eye(4, dtype=np.float64)
    matrix[:3, :3] = np.asarray(rot, dtype=np.float64)
    matrix[:3, 3] = np.asarray(trans, dtype=np.float64).reshape(3)
    return matrix


def metric_translation(
    k: np.ndarray,
    rot: np.ndarray,
    unit_t: np.ndarray,
    pts_source: np.ndarray,
    pts_target: np.ndarray,
    disparity: np.ndarray,
    affine: DepthAffine,
    min_samples: int = _MIN_SCALE_SAMPLES,
) -> np.ndarray | None:
    """Scale a unit essential-matrix translation into metric, or None.

    Reuses the online walk-around's scale recovery exactly: triangulate the
    matched points at a unit baseline in the source camera frame, read the frozen
    affine's metric depth at the same source pixels, and multiply the unit
    translation by the robust median depth ratio (``translation_scale``). Pure
    numpy, so it is unit-tested without cv2.

    Args:
        k: (3, 3) intrinsics shared by the pair.
        rot: (3, 3) target-from-source rotation from ``recoverPose``.
        unit_t: (3,) unit target-from-source translation direction.
        pts_source: (N, 2) inlier pixels in the source frame.
        pts_target: (N, 2) matching inlier pixels in the target frame.
        disparity: the source keyframe's dense disparity map.
        affine: the frozen disparity-to-metric-depth affine.
        min_samples: minimum triangulated points required to trust the scale.

    Returns:
        The metric (N,) translation, or None when the pair cannot be scaled
        (too few valid points in front of both cameras, or no trustworthy ratio).
    """
    points, valid = triangulate(k, rot, unit_t, pts_source, pts_target)
    if int(valid.sum()) < min_samples:
        return None
    unit_depths = points[valid, 2]
    metric = affine.depth(disparity)
    metric_depths = sample_nearest(metric, np.asarray(pts_source)[valid])
    scale = translation_scale(metric_depths, unit_depths, min_samples=min_samples)
    if scale is None:
        return None
    return np.asarray(unit_t, dtype=np.float64).reshape(3) * scale


def _bf_matcher(cv2):
    """A Hamming brute-force matcher for ORB descriptors."""
    return cv2.BFMatcher(cv2.NORM_HAMMING)


def match_descriptors(
    cv2,
    matcher,
    desc_source: np.ndarray | None,
    desc_target: np.ndarray | None,
    ratio: float = _RATIO,
    min_matches: int = _MIN_MATCHES,
) -> tuple[np.ndarray, np.ndarray] | None:
    """Ratio-tested ORB matches as (source_idx, target_idx), or None.

    Returns the keypoint index arrays of the good matches, so the caller pulls
    the matched pixel coordinates from each keyframe. None when either frame has
    too few descriptors or the pair does not reach ``min_matches`` good matches.
    """
    if desc_source is None or desc_target is None:
        return None
    if len(desc_source) < 2 or len(desc_target) < 2:
        return None
    pairs = [p for p in matcher.knnMatch(desc_source, desc_target, k=2) if len(p) == 2]
    good = [m for m, n in pairs if m.distance < ratio * n.distance]
    if len(good) < min_matches:
        return None
    source_idx = np.array([m.queryIdx for m in good], dtype=np.int64)
    target_idx = np.array([m.trainIdx for m in good], dtype=np.int64)
    return source_idx, target_idx


def verify_essential(
    cv2,
    k: np.ndarray,
    pts_source: np.ndarray,
    pts_target: np.ndarray,
    min_inliers: int = _MIN_INLIERS,
) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """Recover a target-from-source pose from matched pixels, or None.

    Estimates the essential matrix with RANSAC and decomposes it with
    ``recoverPose``, which returns the rotation and unit translation mapping the
    source camera frame into the target camera frame. Returns
    ``(rot, unit_t, inlier_mask)`` or None when the estimate is degenerate or
    supported by fewer than ``min_inliers`` inliers.
    """
    pts_source = np.asarray(pts_source, dtype=np.float64)
    pts_target = np.asarray(pts_target, dtype=np.float64)
    essential, mask = cv2.findEssentialMat(
        pts_source, pts_target, k, method=cv2.RANSAC, prob=0.999, threshold=1.0
    )
    if essential is None or essential.shape != (3, 3):
        return None
    _, rot, trans, mask = cv2.recoverPose(essential, pts_source, pts_target, k, mask=mask)
    inliers = mask.ravel() > 0
    if int(inliers.sum()) < min_inliers:
        return None
    return rot.astype(np.float64), trans.reshape(3).astype(np.float64), inliers


def verify_pair(
    source: Keyframe,
    target: Keyframe,
    affine: DepthAffine,
    *,
    cv2=None,
    matcher=None,
    ratio: float = _RATIO,
    min_matches: int = _MIN_MATCHES,
    min_inliers: int = _MIN_INLIERS,
    min_parallax_px: float = _MIN_PARALLAX_PX,
    min_samples: int = _MIN_SCALE_SAMPLES,
) -> tuple[np.ndarray, np.ndarray] | None:
    """Verified target-from-source (rot, metric_t) for a keyframe pair, or None.

    The full match, parallax gate, geometric verification, and metric scale for
    one pair, shared by loop detection and the estimator's consecutive-frame
    chaining. Returns None whenever any stage rejects the pair.
    """
    if cv2 is None:
        import cv2 as cv2  # noqa: PLC0414 - lazy, keeps import numpy-only
    if matcher is None:
        matcher = _bf_matcher(cv2)
    if source.disparity is None:
        return None

    matched = match_descriptors(
        cv2, matcher, source.descriptors, target.descriptors, ratio, min_matches
    )
    if matched is None:
        return None
    source_idx, target_idx = matched
    pts_source = np.asarray(source.keypoints, dtype=np.float64)[source_idx]
    pts_target = np.asarray(target.keypoints, dtype=np.float64)[target_idx]

    if median_displacement(pts_source, pts_target) < min_parallax_px:
        return None

    verified = verify_essential(cv2, source.k, pts_source, pts_target, min_inliers)
    if verified is None:
        return None
    rot, unit_t, inliers = verified

    metric_t = metric_translation(
        source.k,
        rot,
        unit_t,
        pts_source[inliers],
        pts_target[inliers],
        source.disparity,
        affine,
        min_samples=min_samples,
    )
    if metric_t is None:
        return None
    return rot, metric_t


def calibrate_pair(
    source: Keyframe,
    target: Keyframe,
    *,
    cv2=None,
    matcher=None,
    ratio: float = _RATIO,
    min_matches: int = _MIN_MATCHES,
    min_inliers: int = _MIN_INLIERS,
    min_parallax_px: float = _MIN_PARALLAX_PX,
) -> DepthAffine | None:
    """Fit the frozen disparity-to-metric-depth affine from one keyframe pair.

    Matches and verifies the pair, triangulates the inliers at a unit baseline,
    reads the source disparity at those pixels, and fits the affine with
    ``metric_scale.calibrate_depth_affine``. Returns None when the pair cannot
    seed a global scale, so the caller tries the next pair. This is the offline
    analog of the first-pair calibration ``live.py`` runs online.
    """
    if cv2 is None:
        import cv2 as cv2  # noqa: PLC0414 - lazy
    if matcher is None:
        matcher = _bf_matcher(cv2)
    if source.disparity is None:
        return None

    matched = match_descriptors(
        cv2, matcher, source.descriptors, target.descriptors, ratio, min_matches
    )
    if matched is None:
        return None
    source_idx, target_idx = matched
    pts_source = np.asarray(source.keypoints, dtype=np.float64)[source_idx]
    pts_target = np.asarray(target.keypoints, dtype=np.float64)[target_idx]
    if median_displacement(pts_source, pts_target) < min_parallax_px:
        return None

    verified = verify_essential(cv2, source.k, pts_source, pts_target, min_inliers)
    if verified is None:
        return None
    rot, unit_t, inliers = verified

    points, valid = triangulate(source.k, rot, unit_t, pts_source[inliers], pts_target[inliers])
    if int(valid.sum()) < min_matches:
        return None
    inlier_source = pts_source[inliers][valid]
    unit_depths = points[valid, 2]
    disp_samples = sample_nearest(source.disparity, inlier_source)
    return calibrate_depth_affine(disp_samples, unit_depths)


def detect_loop_edges(
    keyframes: Sequence[Keyframe],
    affine: DepthAffine,
    *,
    cv2=None,
    matcher=None,
    min_index_gap: int = _MIN_INDEX_GAP,
    ratio: float = _RATIO,
    min_matches: int = _MIN_MATCHES,
    min_inliers: int = _MIN_INLIERS,
    min_parallax_px: float = _MIN_PARALLAX_PX,
    min_samples: int = _MIN_SCALE_SAMPLES,
    information: np.ndarray | None = None,
) -> list[LoopEdge]:
    """Verified, metric loop-closure edges over a keyframe sequence.

    Enumerates temporally distant pairs, verifies each, and emits a
    ``pose_graph.LoopEdge`` (target-from-source, metric translation) per surviving
    pair. cv2 and the matcher are built once and reused across pairs.
    """
    if cv2 is None:
        import cv2 as cv2  # noqa: PLC0414 - lazy
    if matcher is None:
        matcher = _bf_matcher(cv2)

    edges: list[LoopEdge] = []
    for source, target in candidate_pairs(len(keyframes), min_index_gap):
        result = verify_pair(
            keyframes[source],
            keyframes[target],
            affine,
            cv2=cv2,
            matcher=matcher,
            ratio=ratio,
            min_matches=min_matches,
            min_inliers=min_inliers,
            min_parallax_px=min_parallax_px,
            min_samples=min_samples,
        )
        if result is None:
            continue
        rot, metric_t = result
        edges.append(
            LoopEdge(
                source=keyframes[source].index,
                target=keyframes[target].index,
                transformation=rigid_transform(rot, metric_t),
                information=information,
            )
        )
    return edges
