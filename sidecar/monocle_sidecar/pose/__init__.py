"""Camera pose / SLAM stage that feeds posed frames into fusion.

A PoseEstimator turns captured frames into one world-from-camera pose per frame,
so a depth-only backend or a longer walk-around can supply the posed input the
TSDF fuser needs. The public surface is:

- base.FrameRef: an input frame (image path plus optional intrinsics).
- base.PoseResult: the (N, 4, 4) world-from-camera poses, with `extrinsics()` to
  invert them into the camera-from-world form fusion.frames expects.
- base.PoseEstimator: the interface a tracker implements.
- identity.IdentityPoseEstimator: a placeholder static-camera estimator.
- visual_odometry.OrbVisualOdometry: a classical CPU visual-odometry estimator
  (ORB features plus essential-matrix pose), a real GPU-free tracker up to an
  unknown global scale.
- orb_pgo.OrbPgoPoseEstimator: the same ORB VO with loop closure and global
  pose-graph optimization, so a walk-around that revisits a viewpoint closes
  instead of drifting.
- mast3r.MASt3RSlamPoseEstimator: the loop-closing SLAM tracker, behind the
  optional ``slam`` extra (heavy, GPU-first; errors clearly until installed).
- pipeline.run_pose_stage: run a chosen estimator over a frames directory and
  write ``poses.json`` (camera-from-world) for a ``needs_poses`` backend to read.

The package imports on numpy alone; OrbVisualOdometry imports OpenCV lazily and
MASt3RSlamPoseEstimator imports torch and its tracker lazily, only when they run,
so import stays light on the plain CI environment. See docs/SLAM.md for the
phased plan.
"""

from .base import FrameRef, PoseEstimator, PoseResult
from .identity import IdentityPoseEstimator
from .mast3r import MASt3RSlamPoseEstimator
from .orb_pgo import OrbPgoPoseEstimator
from .pipeline import load_poses, make_estimator, run_pose_stage, write_poses_json
from .visual_odometry import OrbVisualOdometry

__all__ = [
    "FrameRef",
    "PoseEstimator",
    "PoseResult",
    "IdentityPoseEstimator",
    "OrbVisualOdometry",
    "OrbPgoPoseEstimator",
    "MASt3RSlamPoseEstimator",
    "make_estimator",
    "run_pose_stage",
    "write_poses_json",
    "load_poses",
]
