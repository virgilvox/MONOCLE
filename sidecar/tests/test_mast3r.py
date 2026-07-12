"""Tests for the MASt3R-SLAM estimator's not-installed behavior.

The tracker package is not installed in dev or CI, so the estimator must fail
with one clear, actionable error rather than a bare ImportError, and it must not
import torch or the tracker just to be constructed or listed.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from monocle_sidecar.pose import MASt3RSlamPoseEstimator
from monocle_sidecar.pose.base import FrameRef


def test_construction_is_cheap():
    # Constructing (for listing or selection) must not raise or import the stack.
    estimator = MASt3RSlamPoseEstimator()
    assert estimator.checkpoint is None


def test_empty_frames_raises_value_error():
    with pytest.raises(ValueError):
        MASt3RSlamPoseEstimator().estimate([])


def test_missing_tracker_raises_actionable_error():
    frames = [FrameRef(image=Path("frame_00000.png"))]
    with pytest.raises(RuntimeError) as excinfo:
        MASt3RSlamPoseEstimator().estimate(frames)
    # The message points at the extra so the user knows how to proceed.
    assert "slam" in str(excinfo.value)
