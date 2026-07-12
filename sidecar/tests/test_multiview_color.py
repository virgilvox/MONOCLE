"""The multi-view color path must keep color by resizing RGB to the depth map.

DA3 predicts depth at its own resolution, which rarely matches the source frame,
so the old equality check dropped color on nearly every real scan (M7). These
tests pin the resize behavior; they need numpy and OpenCV but not the DA3 model.
"""

from __future__ import annotations

import numpy as np
import pytest

from monocle_sidecar.backends.multiview import _resize_rgb


def test_matching_size_returns_input_unchanged():
    image = np.zeros((32, 48, 3), dtype=np.uint8)
    assert _resize_rgb(image, (32, 48)) is image


def test_shrinks_to_depth_resolution():
    pytest.importorskip("cv2")
    image = np.random.default_rng(0).integers(0, 255, size=(200, 320, 3), dtype=np.uint8)
    out = _resize_rgb(image, (100, 160))
    assert out.shape == (100, 160, 3)
    assert out.dtype == np.uint8


def test_grows_to_depth_resolution():
    pytest.importorskip("cv2")
    image = np.random.default_rng(1).integers(0, 255, size=(40, 60, 3), dtype=np.uint8)
    out = _resize_rgb(image, (80, 120))
    assert out.shape == (80, 120, 3)
    assert out.dtype == np.uint8


def test_numpy_fallback_without_cv2(monkeypatch):
    # Force the ImportError branch so color survives even without OpenCV.
    import builtins

    real_import = builtins.__import__

    def no_cv2(name, *args, **kwargs):
        if name == "cv2":
            raise ImportError("cv2 blocked for test")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_cv2)
    image = np.arange(20 * 30 * 3, dtype=np.uint8).reshape(20, 30, 3)
    out = _resize_rgb(image, (10, 15))
    assert out.shape == (10, 15, 3)
    assert out.dtype == np.uint8
