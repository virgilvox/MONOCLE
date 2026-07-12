"""A placeholder pose estimator that assumes a static camera.

IdentityPoseEstimator returns an identity world-from-camera pose for every frame,
which is the correct answer only when the camera never moves (a turntable where
the object rotates, or a single fixed viewpoint). It exists to exercise and test
the PoseEstimator seam without pulling in any model weights, torch, or a SLAM
runtime, so it stays importable on the plain CI environment.

This is a seam, not a tracker. Real camera pose for a markerless walk-around
needs an actual SLAM method; see docs/SLAM.md for the landscape and the phased
plan that lands one behind this same interface.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

from .base import FrameRef, PoseEstimator, PoseResult


class IdentityPoseEstimator(PoseEstimator):
    """Return an identity pose per frame (a static-camera assumption)."""

    def estimate(self, frames: Sequence[FrameRef]) -> PoseResult:
        if not frames:
            raise ValueError("estimate needs at least one frame.")
        poses = np.stack([np.eye(4, dtype=np.float64) for _ in frames])
        return PoseResult(poses=poses)
