"""Tests for the robust depth scale-and-shift alignment.

Pure numpy, deterministic: a fixed generator builds the sample data, and the fit
itself uses no randomness, so recovery of a known scale/shift and rejection of
injected outliers are exact enough to assert tightly.
"""

from __future__ import annotations

import numpy as np
import pytest

from monocle_sidecar.pose.scale_align import ScaleShift, fit_scale_shift


def test_recovers_known_scale_and_shift_on_clean_data():
    rng = np.random.default_rng(0)
    predicted = rng.uniform(0.1, 1.0, size=200)
    target = 2.5 * predicted + 0.3
    fit = fit_scale_shift(predicted, target)
    assert fit.scale == pytest.approx(2.5, abs=1e-6)
    assert fit.shift == pytest.approx(0.3, abs=1e-6)
    assert fit.inliers.all()


def test_rejects_outliers():
    rng = np.random.default_rng(1)
    predicted = rng.uniform(0.1, 1.0, size=300)
    # Realistic sparse depths carry small measurement noise; a fifth of the points
    # are then corrupted with large, arbitrary errors (mismatched correspondences).
    target = 1.8 * predicted + 0.05 + rng.normal(0.0, 0.01, size=predicted.size)
    bad = rng.choice(predicted.size, size=60, replace=False)
    target[bad] += rng.uniform(2.0, 5.0, size=bad.size)

    fit = fit_scale_shift(predicted, target)
    # The clean model is recovered despite the outliers...
    assert fit.scale == pytest.approx(1.8, abs=0.05)
    assert fit.shift == pytest.approx(0.05, abs=0.05)
    # ...and the corrupted points are flagged as non-inliers.
    assert not fit.inliers[bad].any()


def test_apply_maps_a_dense_map():
    fit = ScaleShift(scale=2.0, shift=1.0, inliers=np.array([True]))
    dense = np.array([[0.0, 0.5], [1.0, 2.0]], dtype=np.float32)
    out = fit.apply(dense)
    assert out.dtype == np.float32
    assert np.allclose(out, np.array([[1.0, 2.0], [3.0, 5.0]]))


def test_rejects_bad_input():
    with pytest.raises(ValueError):
        fit_scale_shift(np.zeros(5), np.zeros(4))
    with pytest.raises(ValueError):
        fit_scale_shift(np.zeros(1), np.zeros(1))
