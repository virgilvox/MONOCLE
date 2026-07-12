"""Camera pose / SLAM stage that feeds posed frames into fusion.

A PoseEstimator turns captured frames into one world-from-camera pose per frame,
so a depth-only backend or a longer walk-around can supply the posed input the
TSDF fuser needs. The public surface is:

- base.FrameRef: an input frame (image path plus optional intrinsics).
- base.PoseResult: the (N, 4, 4) world-from-camera poses, with `extrinsics()` to
  invert them into the camera-from-world form fusion.frames expects.
- base.PoseEstimator: the interface a tracker implements.
- identity.IdentityPoseEstimator: a placeholder static-camera estimator, the
  only concrete implementation today.

Everything here runs on numpy alone. Real SLAM (MASt3R-SLAM, VGGT-SLAM) is future
work, planned in docs/SLAM.md to land behind this same interface.
"""

from .base import FrameRef, PoseEstimator, PoseResult
from .identity import IdentityPoseEstimator

__all__ = [
    "FrameRef",
    "PoseEstimator",
    "PoseResult",
    "IdentityPoseEstimator",
]
