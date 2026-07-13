"""Classical monocular visual-odometry pose estimator (CPU, OpenCV).

Recovers a world-from-camera pose per frame from a walk-around sequence with ORB
features, essential-matrix estimation, and pose recovery between consecutive
frames, chained into one world frame. It is a lightweight, GPU-free front end
that runs anywhere the `depth` extra is installed, since OpenCV ships with it, so
it is a real alternative to the identity estimator on this CPU-only box where the
foundation-model SLAM systems in docs/SLAM.md are impractical.

Honest scope: this is visual odometry, not SLAM. Translation is recovered only up
to an unknown global scale (monocular essential-matrix decomposition cannot fix
metric scale), there is no loop closure, and drift accumulates over a long path.
It is most useful as the pose stage for a short, textured object sweep whose
depth is supplied separately. See docs/SLAM.md for the loop-closing SLAM methods
this same seam is shaped to accept later.

cv2 is imported lazily so this module does not add an import-time dependency to
the pose package, which stays numpy-only for the plain CI environment.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from .base import FrameRef, PoseEstimator, PoseResult


@dataclass(frozen=True)
class KeyframeFeatures:
    """The per-keyframe features a loop detector needs, in image pixel space.

    Emitted alongside the poses by ``OrbVisualOdometry.estimate_with_features`` so
    a downstream stage (loop closure, a pose graph) can match distant keyframes
    without re-detecting features. Additive: the plain ``estimate`` path does not
    expose it and is unchanged.

    Attributes:
        keypoints: (M, 2) float64 pixel coordinates of the detected keypoints.
        descriptors: (M, 32) uint8 ORB descriptors, or None if the frame had none.
        k: (3, 3) pinhole intrinsics for this frame's pixel space.
        width: frame width in pixels.
        height: frame height in pixels.
    """

    keypoints: np.ndarray
    descriptors: np.ndarray | None
    k: np.ndarray
    width: int
    height: int


def _default_intrinsics(width: int, height: int) -> dict:
    """A neutral pinhole guess when a frame carries no intrinsics.

    Uses a focal length equal to the larger image side (roughly a 53 degree
    horizontal field of view on a landscape frame) and a centered principal
    point. Approximate by design: essential-matrix pose is not very sensitive to
    a modest focal error, and a real capture should supply true intrinsics.
    """
    focal = float(max(width, height))
    return {
        "fx": focal,
        "fy": focal,
        "cx": width / 2.0,
        "cy": height / 2.0,
        "width": float(width),
        "height": float(height),
    }


def _camera_matrix(intrinsics: dict) -> np.ndarray:
    """Build the 3x3 pinhole matrix K from an intrinsics dict."""
    return np.array(
        [
            [intrinsics["fx"], 0.0, intrinsics["cx"]],
            [0.0, intrinsics["fy"], intrinsics["cy"]],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )


def _compose_camera_from_world(
    prev_cfw: np.ndarray, rel_r: np.ndarray, rel_t: np.ndarray
) -> np.ndarray:
    """Chain a relative motion onto the running camera-from-world pose.

    recoverPose returns (R, t) mapping a point from the previous camera frame
    into the current one, which is the current-from-previous rigid transform. The
    running pose is camera-from-world (world->camera); left-multiplying by the
    relative transform advances it to the new frame. Kept pure so the chaining
    math is unit-tested without OpenCV.
    """
    rel = np.eye(4, dtype=np.float64)
    rel[:3, :3] = rel_r
    rel[:3, 3] = np.asarray(rel_t, dtype=np.float64).reshape(3)
    return rel @ prev_cfw


class OrbVisualOdometry(PoseEstimator):
    """Recover world-from-camera poses from a monocular sequence with ORB VO.

    Args:
        n_features: ORB keypoint budget per frame.
        ratio: Lowe ratio-test threshold for accepting a descriptor match.
        min_matches: minimum good matches to trust an essential-matrix estimate;
            below it the pair is treated as no motion so the chain never jumps on
            a weak, textureless frame.
    """

    def __init__(self, n_features: int = 2000, ratio: float = 0.75, min_matches: int = 20) -> None:
        self.n_features = n_features
        self.ratio = ratio
        self.min_matches = min_matches

    def estimate(self, frames: Sequence[FrameRef]) -> PoseResult:
        return self.estimate_with_features(frames)[0]

    def estimate_with_features(
        self, frames: Sequence[FrameRef]
    ) -> tuple[PoseResult, list[KeyframeFeatures]]:
        """Estimate poses and also return each keyframe's ORB features.

        Same pose chain as ``estimate`` (which delegates here and drops the
        features), plus the per-keyframe keypoints, descriptors, and intrinsics a
        loop detector needs. Additive: no existing caller of ``estimate`` sees a
        behaviour change.
        """
        if not frames:
            raise ValueError("estimate needs at least one frame.")

        import cv2  # lazy: keeps the pose package numpy-only until VO is used

        orb = cv2.ORB_create(self.n_features)
        matcher = cv2.BFMatcher(cv2.NORM_HAMMING)

        # The first camera defines the world frame: its camera-from-world is
        # identity, so its world-from-camera is identity too.
        cfw = np.eye(4, dtype=np.float64)
        poses = [np.linalg.inv(cfw)]

        prev = self._features(cv2, orb, frames[0])
        features = [_to_keyframe_features(prev)]
        for ref in frames[1:]:
            curr = self._features(cv2, orb, ref)
            rel_r, rel_t = self._relative_motion(cv2, matcher, prev, curr, ref)
            cfw = _compose_camera_from_world(cfw, rel_r, rel_t)
            poses.append(np.linalg.inv(cfw))
            features.append(_to_keyframe_features(curr))
            prev = curr

        return PoseResult(poses=np.stack(poses)), features

    def _features(self, cv2, orb, ref: FrameRef):
        """Read a frame in grayscale and detect ORB keypoints and descriptors."""
        image = cv2.imread(str(ref.image), cv2.IMREAD_GRAYSCALE)
        if image is None:
            raise ValueError(f"could not read frame image: {ref.image}")
        height, width = image.shape[:2]
        keypoints, descriptors = orb.detectAndCompute(image, None)
        intrinsics = ref.intrinsics or _default_intrinsics(width, height)
        return keypoints, descriptors, _camera_matrix(intrinsics), width, height

    def _relative_motion(self, cv2, matcher, prev, curr, ref: FrameRef):
        """Return (R, t) mapping the previous camera frame into the current one.

        Falls back to no motion (identity, zero translation) when there are too
        few reliable matches to estimate an essential matrix, so a weak frame
        holds the pose steady instead of corrupting the chain.
        """
        prev_kp, prev_desc, *_ = prev
        curr_kp, curr_desc, k, *_ = curr
        identity = (np.eye(3, dtype=np.float64), np.zeros(3, dtype=np.float64))
        if prev_desc is None or curr_desc is None or len(prev_desc) < 2 or len(curr_desc) < 2:
            return identity

        pairs = [p for p in matcher.knnMatch(prev_desc, curr_desc, k=2) if len(p) == 2]
        good = [m for m, n in pairs if m.distance < self.ratio * n.distance]
        if len(good) < self.min_matches:
            return identity

        prev_pts = np.float64([prev_kp[m.queryIdx].pt for m in good])
        curr_pts = np.float64([curr_kp[m.trainIdx].pt for m in good])
        essential, mask = cv2.findEssentialMat(
            prev_pts, curr_pts, k, method=cv2.RANSAC, prob=0.999, threshold=1.0
        )
        if essential is None or essential.shape != (3, 3):
            return identity

        _, rot, trans, _ = cv2.recoverPose(essential, prev_pts, curr_pts, k, mask=mask)
        return rot.astype(np.float64), trans.reshape(3).astype(np.float64)


def _to_keyframe_features(feature) -> KeyframeFeatures:
    """Pack a raw ``_features`` tuple into a KeyframeFeatures record.

    Converts the cv2 KeyPoint list into an (M, 2) pixel array so the result is
    plain numpy with no cv2 objects held past extraction.
    """
    keypoints, descriptors, k, width, height = feature
    coords = (
        np.array([kp.pt for kp in keypoints], dtype=np.float64)
        if keypoints
        else np.zeros((0, 2), dtype=np.float64)
    )
    return KeyframeFeatures(
        keypoints=coords, descriptors=descriptors, k=k, width=int(width), height=int(height)
    )
