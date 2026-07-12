"""Tie monocular depth and monocular VO into one consistent metric scale.

Monocular visual odometry recovers each camera translation only up to an unknown
scale, and Depth Anything V2 predicts depth only up to an unknown affine in
inverse-depth. Fusing them naively gives an incoherent TSDF volume, which is the
root cause of garbled walk-around scans: the old engine renormalized each frame's
depth into a fixed window independently, so a fixed surface landed at a different
world position in every view and the volume never agreed with itself.

This module makes the two agree by pinning depth as the single metric anchor:

1. From the first well-conditioned frame pair, triangulate the matched features
   at a unit baseline and fit the disparity-to-inverse-depth affine that maps the
   dense prediction onto those sparse points (``fit_scale_shift``). The affine is
   normalized so the scene sits at a known target depth, then frozen and reused
   for every frame. A fixed surface therefore keeps a fixed metric depth in every
   view, which is exactly the invariant TSDF fusion requires.
2. For each later pair, the essential matrix gives the translation *direction*
   only. Triangulate the matches at a unit baseline, read the now-metric dense
   depth at the same pixels, and scale the unit translation by the median depth
   ratio. Camera motion is then expressed in the same metric as the depth maps,
   so baselines and parallax stay consistent.

Everything here is pure numpy: a linear DLT triangulation, medians, and the
affine fit in ``pose/scale_align.py``. That keeps it importable and unit-testable
without OpenCV or a depth model. The OpenCV feature matching and Open3D fusion
that surround it live in ``live.py``.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .scale_align import fit_scale_shift

# Where the calibrated scene is centered, in meters. The absolute scale of a
# monocular reconstruction is arbitrary (the first baseline defines the unit), so
# we normalize the whole system to this median depth. It keeps exports a sane size
# and matches the TSDF voxel/truncation constants tuned for a small tabletop
# object, rather than the arbitrary magnitude a raw unit-baseline triangulation
# would produce.
_TARGET_MEDIAN_DEPTH_M = 0.4
# Depths outside this window are treated as invalid (0) and skipped by fusion.
_MIN_DEPTH_M = 0.05
_MAX_DEPTH_M = 2.0


@dataclass(frozen=True)
class DepthAffine:
    """A frozen disparity-to-metric-depth map: ``depth = 1 / (a * disparity + b)``.

    Depth Anything V2 is affine-invariant in inverse depth, so the physically
    correct alignment is affine on the disparity (inverse depth), not on depth
    itself. ``a`` and ``b`` are fit once against pose-consistent sparse points and
    then reused for the whole capture, which is what gives every frame one shared
    metric scale.
    """

    a: float
    b: float

    def depth(
        self,
        disparity: np.ndarray,
        min_depth: float = _MIN_DEPTH_M,
        max_depth: float = _MAX_DEPTH_M,
    ) -> np.ndarray:
        """Map a dense disparity map to metric depth, zeroing invalid pixels.

        A pixel is invalid (returned as 0, which fusion ignores) when the inverse
        depth is non-positive or the resulting depth falls outside the window.
        """
        disparity = np.asarray(disparity, dtype=np.float64)
        inv = self.a * disparity + self.b
        with np.errstate(divide="ignore", invalid="ignore"):
            depth = np.where(inv > 1e-9, 1.0 / inv, 0.0)
        depth[(depth < min_depth) | (depth > max_depth)] = 0.0
        return depth.astype(np.float32)


def triangulate(
    k: np.ndarray, rot: np.ndarray, trans: np.ndarray, pts0: np.ndarray, pts1: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Linear-triangulate matched points into the first camera's frame.

    The first camera is ``P0 = K [I | 0]`` and the second is ``P1 = K [R | t]``,
    the current-from-previous transform ``recoverPose`` returns. Solves each
    correspondence with the standard 4-row DLT and a batched SVD.

    Args:
        k: (3, 3) pinhole intrinsics shared by both views.
        rot: (3, 3) rotation mapping a point from camera 0 into camera 1.
        trans: (3,) translation of that same transform (any scale; a unit
            direction gives points in unit-baseline scale).
        pts0: (N, 2) pixel coordinates in camera 0.
        pts1: (N, 2) matching pixel coordinates in camera 1.

    Returns:
        A tuple ``(points, valid)``: ``points`` is (N, 3) in camera 0's frame, and
        ``valid`` is an (N,) bool mask that is True only where the point lies in
        front of both cameras (positive depth), the cheirality test.
    """
    k = np.asarray(k, dtype=np.float64)
    rot = np.asarray(rot, dtype=np.float64)
    trans = np.asarray(trans, dtype=np.float64).reshape(3)
    pts0 = np.asarray(pts0, dtype=np.float64).reshape(-1, 2)
    pts1 = np.asarray(pts1, dtype=np.float64).reshape(-1, 2)

    p0 = k @ np.hstack([np.eye(3), np.zeros((3, 1))])
    p1 = k @ np.hstack([rot, trans.reshape(3, 1)])

    n = pts0.shape[0]
    if n == 0:
        return np.zeros((0, 3)), np.zeros((0,), dtype=bool)

    # Four DLT rows per correspondence: u * P[2] - P[0], v * P[2] - P[1] per view.
    a = np.empty((n, 4, 4), dtype=np.float64)
    a[:, 0] = pts0[:, 0:1] * p0[2] - p0[0]
    a[:, 1] = pts0[:, 1:2] * p0[2] - p0[1]
    a[:, 2] = pts1[:, 0:1] * p1[2] - p1[0]
    a[:, 3] = pts1[:, 1:2] * p1[2] - p1[1]

    _, _, vh = np.linalg.svd(a)
    xh = vh[:, -1, :]  # homogeneous solution per point
    w = xh[:, 3:4]
    safe = np.where(np.abs(w) < 1e-12, 1e-12, w)
    points = xh[:, :3] / safe

    z0 = points[:, 2]
    z1 = (points @ rot.T + trans)[:, 2]
    valid = np.isfinite(points).all(axis=1) & (z0 > 0) & (z1 > 0) & (np.abs(w[:, 0]) >= 1e-12)
    return points, valid


def sample_nearest(image: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Nearest-neighbour sample of a 2-D map at (x, y) pixel coordinates."""
    image = np.asarray(image)
    pts = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    h, w = image.shape[:2]
    cols = np.clip(np.round(pts[:, 0]).astype(int), 0, w - 1)
    rows = np.clip(np.round(pts[:, 1]).astype(int), 0, h - 1)
    return image[rows, cols]


def calibrate_depth_affine(
    disparity_samples: np.ndarray,
    sparse_depths: np.ndarray,
    target_median: float = _TARGET_MEDIAN_DEPTH_M,
    min_inliers: int = 12,
) -> DepthAffine | None:
    """Fit and normalize the disparity-to-depth affine from one frame pair.

    Fits ``inverse_depth ~= a * disparity + b`` against the triangulated sparse
    depths (robustly, via ``fit_scale_shift``), rejects a fit that is not a valid
    nearer-is-larger-disparity relationship, then rescales so the median sparse
    depth maps to ``target_median``. Returns None when the pair cannot be trusted
    to seed a global scale, so the caller waits for a better one.

    Args:
        disparity_samples: (M,) dense-model disparity at the matched pixels.
        sparse_depths: (M,) triangulated depths at those same pixels, in the
            arbitrary unit-baseline scale.
        target_median: meters the median depth is normalized to.
        min_inliers: reject a fit supported by fewer inliers than this.
    """
    disparity_samples = np.asarray(disparity_samples, dtype=np.float64).ravel()
    sparse_depths = np.asarray(sparse_depths, dtype=np.float64).ravel()
    good = np.isfinite(disparity_samples) & np.isfinite(sparse_depths) & (sparse_depths > 0)
    disparity_samples = disparity_samples[good]
    sparse_depths = sparse_depths[good]
    if disparity_samples.size < min_inliers:
        return None

    fit = fit_scale_shift(disparity_samples, 1.0 / sparse_depths)
    if int(fit.inliers.sum()) < min_inliers or not np.isfinite(fit.scale) or fit.scale <= 0:
        return None

    # Rescale so the median sparse depth sits at the target. Scaling metric depth
    # by G is the same as dividing the inverse-depth affine (a, b) by G.
    median_depth = float(np.median(sparse_depths))
    if not np.isfinite(median_depth) or median_depth <= 0:
        return None
    g = target_median / median_depth
    return DepthAffine(a=fit.scale / g, b=fit.shift / g)


def translation_scale(
    metric_depths: np.ndarray, unit_depths: np.ndarray, min_samples: int = 8
) -> float | None:
    """Recover a metric translation magnitude from depth, or None if untrustworthy.

    ``unit_depths`` are triangulated depths at a unit baseline; ``metric_depths``
    are the calibrated dense depths at the same pixels. Their robust median ratio
    is the factor that turns the unit-length translation into the depth maps'
    metric, which keeps camera motion and depth on one scale.
    """
    metric_depths = np.asarray(metric_depths, dtype=np.float64).ravel()
    unit_depths = np.asarray(unit_depths, dtype=np.float64).ravel()
    good = (
        np.isfinite(metric_depths)
        & np.isfinite(unit_depths)
        & (metric_depths > 0)
        & (unit_depths > 0)
    )
    if int(good.sum()) < min_samples:
        return None
    ratio = float(np.median(metric_depths[good] / unit_depths[good]))
    if not np.isfinite(ratio) or ratio <= 0:
        return None
    return ratio


def median_displacement(pts0: np.ndarray, pts1: np.ndarray) -> float:
    """Median pixel displacement between matched points, a parallax proxy.

    A near-pure-rotation or a barely-moved frame gives a small displacement, where
    essential-matrix pose is ill-conditioned; the caller gates on this so a
    low-parallax frame holds the pose instead of injecting a noisy translation.
    """
    pts0 = np.asarray(pts0, dtype=np.float64).reshape(-1, 2)
    pts1 = np.asarray(pts1, dtype=np.float64).reshape(-1, 2)
    if pts0.shape[0] == 0:
        return 0.0
    return float(np.median(np.linalg.norm(pts1 - pts0, axis=1)))
