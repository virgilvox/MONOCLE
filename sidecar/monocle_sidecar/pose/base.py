"""The narrow interface an upstream pose / SLAM stage implements.

Feed-forward multi-view backends (Depth Anything 3) recover pose implicitly and
per batch, so there is no persistent map or drift correction. A real camera
tracker (SLAM) is a separate concern: given the captured frames, produce one
world-space camera pose per frame. That posed sequence is what lets any depth
backend that only predicts depth (not pose) still feed the TSDF fuser, and what
lets a longer walk-around stay globally consistent.

This module defines that seam. A PoseEstimator turns a sequence of frame
references (image path plus optional intrinsics) into one 4x4 pose per frame.
Keeping the surface this small is deliberate: a SLAM method becomes a new
estimator plus a backend that sets needs_poses, never a change to fusion.

Pose convention
---------------
`estimate` returns **world-from-camera** matrices (T_wc): each 4x4 places the
camera in world space, so its translation column is the camera position and its
rotation maps camera axes into world axes. This is the natural "camera pose" a
SLAM system reports.

Fusion wants the other direction. `fusion.frames.PosedDepthFrame.pose` is the
**camera-from-world** extrinsic (T_cw = world->camera) that Open3D's TSDF
integrate expects, which is the inverse of a world-from-camera pose. `PoseResult`
carries the inversion (`extrinsics`) so a future SLAM backend converts once, at
the seam, rather than every call site guessing which direction it holds.

See docs/SLAM.md for the landscape (MASt3R-SLAM, VGGT-SLAM, DUSt3R/MASt3R) and
the phased plan this seam is shaped for.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass(frozen=True)
class FrameRef:
    """One input frame for pose estimation.

    Attributes:
        image: path to the RGB keyframe on disk. Estimators read pixels lazily so
            a long capture is not held in memory at once.
        intrinsics: optional pinhole intrinsics in pixels with keys fx, fy, cx,
            cy, width, height (the fusion.frames intrinsics shape, mirroring the
            protocol Intrinsics type). None means the estimator must assume or
            self-calibrate a camera model.
    """

    image: Path
    intrinsics: dict | None = None


@dataclass(frozen=True)
class PoseResult:
    """Per-frame camera poses recovered for a capture.

    Attributes:
        poses: (N, 4, 4) float64 world-from-camera matrices (T_wc), one per input
            frame in input order. Element [i] places camera i in the shared world
            frame; identity means the camera sits at the world origin looking
            down its own +Z.

    The array is the whole contract: N matches the input frame count, and the
    order matches the input order, so a caller can zip poses back onto frames.
    """

    poses: np.ndarray

    def __post_init__(self) -> None:
        poses = np.asarray(self.poses, dtype=np.float64)
        if poses.ndim != 3 or poses.shape[1:] != (4, 4):
            raise ValueError(
                f"poses must have shape (N, 4, 4); got {poses.shape}."
            )
        object.__setattr__(self, "poses", poses)

    def __len__(self) -> int:
        return int(self.poses.shape[0])

    def extrinsics(self) -> np.ndarray:
        """Return (N, 4, 4) camera-from-world extrinsics (T_cw) for fusion.

        This inverts each world-from-camera pose into the world->camera extrinsic
        that fusion.frames.PosedDepthFrame.pose and Open3D's TSDF integrate
        expect. Doing the inversion here keeps the direction mismatch in one
        place instead of scattering np.linalg.inv across backends.
        """
        return np.linalg.inv(self.poses)


class PoseEstimator(ABC):
    """Recover one world-from-camera pose per frame for a capture.

    Concrete estimators range from the trivial (IdentityPoseEstimator, a
    static-camera assumption) to a full SLAM tracker with loop closure. The
    method is intentionally batch-shaped: it takes the whole ordered sequence so
    an estimator that maintains a map across frames (every real SLAM method) has
    the context it needs, while a per-frame estimator can simply loop.
    """

    @abstractmethod
    def estimate(self, frames: Sequence[FrameRef]) -> PoseResult:
        """Estimate a world-from-camera pose for each frame, in input order.

        Args:
            frames: ordered frame references. The order is the capture order and
                is preserved in the result.

        Returns:
            A PoseResult whose `poses` is (N, 4, 4) with N == len(frames).

        Raises:
            ValueError: if frames is empty.
        """
        raise NotImplementedError
