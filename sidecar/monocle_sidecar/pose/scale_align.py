"""Align up-to-scale monocular depth to sparse pose-consistent depth.

Visual odometry recovers camera motion only up to an unknown global scale, and a
monocular depth model (Depth Anything V2) predicts depth only up to an unknown
affine transform. Fusing the two directly gives an incoherent volume because
their scales disagree. The standard fix, used by SfM-guided reconstruction work
(for example Murre, arXiv:2503.14483, which aligns predicted depth to sparse SfM
points with a robust linear regressor), is to fit a per-frame scale and shift
that maps the predicted depth onto sparse depths that ARE in the VO frame, namely
the depths of triangulated feature points.

This module is the pure numeric core of that step: a deterministic robust fit of
``target ~= scale * predicted + shift`` over sparse samples, and applying it to a
dense map. It is numpy-only, so it stays importable and testable without OpenCV,
torch, or a depth model. The triangulation that produces the sparse targets, and
the backend that ties this to fusion, are the remaining Phase 3 work in
docs/SLAM.md.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class ScaleShift:
    """An affine depth alignment ``aligned = scale * predicted + shift``."""

    scale: float
    shift: float
    inliers: np.ndarray

    def apply(self, depth: np.ndarray) -> np.ndarray:
        """Map a predicted depth map into the aligned (pose-consistent) scale."""
        return (self.scale * np.asarray(depth, dtype=np.float64) + self.shift).astype(np.float32)


# Cap on points used for the pairwise Theil-Sen estimate; it is O(m^2) in memory,
# so a large sparse set is evenly subsampled for the robust initialization only
# (the final least-squares refit still uses every inlier).
_THEIL_SEN_CAP = 800


def fit_scale_shift(
    predicted: np.ndarray,
    target: np.ndarray,
    inlier_sigma: float = 2.5,
    min_inliers: int = 8,
) -> ScaleShift:
    """Robustly fit ``target ~= scale * predicted + shift`` over sparse samples.

    Deterministic and seed-free: a Theil-Sen estimate (the median of pairwise
    slopes, which tolerates roughly a quarter of the points being outliers) seeds
    the fit, then points whose residual exceeds ``inlier_sigma`` robust sigmas are
    dropped and a least-squares refit runs on the survivors for precision. This
    resists the mismatched correspondences and depth outliers a raw least-squares
    fit would chase, without RANSAC's randomness.

    Args:
        predicted: 1-D up-to-scale predicted depths at the sparse pixels.
        target: 1-D pose-consistent depths (from triangulated points) at the same
            pixels, same length as ``predicted``.
        inlier_sigma: residual threshold in robust sigmas.
        min_inliers: keep the robust estimate rather than refit below this count.

    Returns:
        A ScaleShift with the fit and the boolean inlier mask over the inputs.

    Raises:
        ValueError: if the inputs differ in length or have fewer than 2 points.
    """
    predicted = np.asarray(predicted, dtype=np.float64).ravel()
    target = np.asarray(target, dtype=np.float64).ravel()
    if predicted.shape != target.shape:
        raise ValueError(
            f"predicted and target must match; got {predicted.shape} vs {target.shape}."
        )
    if predicted.size < 2:
        raise ValueError("need at least 2 points to fit a scale and shift.")

    scale, shift = _theil_sen(predicted, target)
    residual = target - (scale * predicted + shift)
    sigma = _robust_sigma(residual)
    inliers = np.ones(predicted.size, dtype=bool)
    if sigma > 0:
        candidate = np.abs(residual) <= inlier_sigma * sigma
        if candidate.sum() >= min_inliers:
            inliers = candidate
            scale, shift = _least_squares(predicted, target, inliers)

    return ScaleShift(scale=float(scale), shift=float(shift), inliers=inliers)


def _theil_sen(predicted: np.ndarray, target: np.ndarray) -> tuple[float, float]:
    """Median-of-pairwise-slopes fit, subsampled to bound the O(m^2) pair cost."""
    if predicted.size > _THEIL_SEN_CAP:
        idx = np.linspace(0, predicted.size - 1, _THEIL_SEN_CAP).round().astype(int)
        x, y = predicted[idx], target[idx]
    else:
        x, y = predicted, target
    dx = x[:, None] - x[None, :]
    dy = y[:, None] - y[None, :]
    valid = np.abs(dx) > 1e-12
    if not valid.any():
        return 0.0, float(np.median(target))
    slope = float(np.median(dy[valid] / dx[valid]))
    # The shift deliberately comes from the full set, not the subsample: the
    # median intercept is O(m), so every point can sharpen it even when the
    # O(m^2) slope estimate had to be subsampled.
    shift = float(np.median(target - slope * predicted))
    return slope, shift


def _least_squares(
    predicted: np.ndarray, target: np.ndarray, mask: np.ndarray
) -> tuple[float, float]:
    """Closed-form least-squares scale and shift over the masked points."""
    x = predicted[mask]
    y = target[mask]
    design = np.stack([x, np.ones_like(x)], axis=1)
    (scale, shift), *_ = np.linalg.lstsq(design, y, rcond=None)
    return float(scale), float(shift)


def _robust_sigma(residual: np.ndarray) -> float:
    """A median-absolute-deviation estimate of the residual spread."""
    if residual.size == 0:
        return 0.0
    mad = float(np.median(np.abs(residual - np.median(residual))))
    return 1.4826 * mad
