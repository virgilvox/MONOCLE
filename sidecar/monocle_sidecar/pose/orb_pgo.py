"""ORB visual odometry with loop closure and global pose-graph optimization.

``OrbVisualOdometry`` chains motion frame to frame, so a long walk-around drifts
and never closes when the camera returns to an earlier viewpoint. This estimator
adds the two pieces that fix that:

  1. loop closure (``loop_closure.detect_loop_edges``): find temporally distant
     keyframes that see the same place and measure a metric relative pose between
     them, and
  2. global optimization (``pose_graph.optimize_pose_graph``): redistribute the
     accumulated drift so those loop constraints are satisfied.

It reuses the online walk-around's machinery rather than reinventing it: ORB
features and the up-to-scale pose chain come from ``OrbVisualOdometry``; a Depth
Anything V2 disparity per keyframe (the same model live fusion uses) plus the
frozen depth affine put every baseline and every loop edge on one metric scale,
exactly the way ``live.py`` and ``metric_scale.py`` do it online.

The refinement core (``refine_poses``) is a pure function of poses, keyframes,
and the frozen affine, so it is unit-tested without a depth model. The estimator
wraps it with the ORB and Depth Anything I/O, which load lazily and are skipped
by the tests that lack those extras.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .base import FrameRef, PoseEstimator, PoseResult
from .loop_closure import (
    Keyframe,
    LoopEdge,
    calibrate_pair,
    detect_loop_edges,
    effective_index_gap,
    verify_pair,
)
from .metric_scale import DepthAffine
from .pose_graph import optimize_pose_graph
from .visual_odometry import KeyframeFeatures, OrbVisualOdometry, _compose_camera_from_world


@dataclass(frozen=True)
class MetricPoseResult:
    """The loop-closed pose track plus the metric context fusion needs.

    ``estimate`` returns only ``poses`` (the PoseEstimator contract). A batch
    reconstruction backend needs more than the extrinsics: to fuse depth on the
    same scale the poses were built on, it needs the frozen disparity-to-metric
    affine and the per-keyframe disparities, which ``poses.json`` cannot carry.
    ``estimate_with_scale`` returns this so the fuse pass reuses exactly the
    affine and depths the pose pass already computed, in one Depth Anything pass.

    Attributes:
        poses: the optimized world-from-camera PoseResult (loop-closed when a
            revisit was found, the metric or raw VO chain otherwise).
        affine: the frozen disparity-to-metric-depth affine, or None when no pair
            could seed a metric scale (then ``poses`` is the raw up-to-scale VO).
        keyframes: one per frame, each carrying the disparity and intrinsics used,
            so the fuse pass maps disparity to metric depth without re-inferring.
        loop_edges: the verified loop-closure edges the optimizer consumed; its
            length is how many revisits actually closed the track.
    """

    poses: PoseResult
    affine: DepthAffine | None
    keyframes: list[Keyframe]
    loop_edges: list[LoopEdge]


def refine_poses(
    poses: np.ndarray,
    keyframes: Sequence[Keyframe],
    affine: DepthAffine,
    **loop_kwargs,
) -> np.ndarray:
    """Detect loop closures and return globally optimized poses.

    Pure with respect to the geometry: given the odometry poses, the keyframe
    features, and the frozen depth affine, it finds the metric loop edges and runs
    the pose-graph optimizer. Extra keyword arguments are forwarded to
    ``detect_loop_edges`` (gap, ratios, inlier and parallax thresholds).

    ``detect_loop_edges`` needs cv2 and ``optimize_pose_graph`` needs Open3D, so
    this is exercised only where those extras are installed.
    """
    edges = detect_loop_edges(keyframes, affine, **loop_kwargs)
    return optimize_pose_graph(np.asarray(poses, dtype=np.float64), edges)


class OrbPgoPoseEstimator(PoseEstimator):
    """ORB visual odometry refined by loop closure and pose-graph optimization.

    Args:
        n_features: ORB keypoint budget per frame.
        ratio: Lowe ratio-test threshold for a descriptor match.
        min_matches: minimum good matches to trust a pair.
        min_inliers: minimum geometric inliers to accept a recovered pose.
        min_index_gap: minimum keyframe distance for a pair to count as a loop
            rather than odometry.
        min_parallax_px: minimum median pixel displacement to trust a pose.
        depth_runner: optional injected disparity source (for tests); the live
            ``DepthRunner`` is constructed lazily when omitted.
    """

    def __init__(
        self,
        n_features: int = 2000,
        ratio: float = 0.75,
        min_matches: int = 25,
        min_inliers: int = 15,
        min_index_gap: int = 8,
        min_parallax_px: float = 3.0,
        depth_runner=None,
    ) -> None:
        self.n_features = n_features
        self.ratio = ratio
        self.min_matches = min_matches
        self.min_inliers = min_inliers
        self.min_index_gap = min_index_gap
        self.min_parallax_px = min_parallax_px
        self._depth_runner = depth_runner

    def estimate(self, frames: Sequence[FrameRef]) -> PoseResult:
        """Loop-closed world-from-camera poses; the PoseEstimator contract.

        Delegates to ``estimate_with_scale`` and drops the metric context, so the
        pose-only seam (``pipeline.run_pose_stage`` -> ``poses.json``) is unchanged.
        """
        return self.estimate_with_scale(frames).poses

    def estimate_with_scale(self, frames: Sequence[FrameRef]) -> MetricPoseResult:
        """Estimate poses and return the frozen affine, keyframes, and loop edges.

        The full pose pass: ORB VO for the initial chain and features, one Depth
        Anything V2 disparity per keyframe, a frozen metric affine from the first
        pair that calibrates, a metric-baseline re-chain, loop detection over
        temporally distant pairs (with the gap adapted to the sequence length),
        and a global pose-graph optimization. Returns everything a batch fuse pass
        needs to integrate depth on the very scale the poses were built on.
        """
        if not frames:
            raise ValueError("estimate needs at least one frame.")

        vo = OrbVisualOdometry(self.n_features, self.ratio, self.min_matches)
        vo_result, features = vo.estimate_with_features(frames)
        if len(frames) < 2:
            return MetricPoseResult(vo_result, None, [], [])

        import cv2

        disparities = self._disparities(frames, features)
        keyframes = self._keyframes(features, disparities)
        matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
        gates = dict(
            ratio=self.ratio,
            min_matches=self.min_matches,
            min_inliers=self.min_inliers,
            min_parallax_px=self.min_parallax_px,
        )

        affine = self._calibrate(keyframes, cv2, matcher, gates)
        if affine is None:
            # No pair could seed a metric scale; the raw VO track is the best we
            # can honestly return rather than a graph built on an unknown scale.
            return MetricPoseResult(vo_result, None, keyframes, [])

        metric_poses = self._metric_chain(keyframes, affine, cv2, matcher, gates)
        gap = effective_index_gap(len(keyframes), self.min_index_gap)
        edges = detect_loop_edges(
            keyframes,
            affine,
            cv2=cv2,
            matcher=matcher,
            min_index_gap=gap,
            **gates,
        )
        optimized = optimize_pose_graph(np.asarray(metric_poses, dtype=np.float64), edges)
        return MetricPoseResult(PoseResult(poses=optimized), affine, keyframes, edges)

    def _disparities(
        self, frames: Sequence[FrameRef], features: Sequence[KeyframeFeatures]
    ) -> list[np.ndarray]:
        """Depth Anything V2 disparity per frame, resized to the keypoint frame.

        The depth model runs at its own working resolution; the disparity is
        nearest-neighbour resized to each frame's native size so it shares the
        pixel space of the ORB keypoints and intrinsics, which is what lets the
        frozen affine be sampled at those keypoints.
        """
        import cv2

        runner = self._depth_runner or self._make_depth_runner(frames)
        from PIL import Image

        disparities = []
        for ref, feature in zip(frames, features):
            with Image.open(ref.image) as handle:
                image = handle.convert("RGB")
            disparity, _rgb, _intr = runner.run(image)
            resized = cv2.resize(
                np.asarray(disparity, dtype=np.float32),
                (feature.width, feature.height),
                interpolation=cv2.INTER_NEAREST,
            )
            disparities.append(resized)
        return disparities

    def _make_depth_runner(self, frames: Sequence[FrameRef]):
        from ..live import DepthRunner

        frames_dir = Path(frames[0].image).parent
        return DepthRunner(frames_dir=frames_dir)

    @staticmethod
    def _keyframes(
        features: Sequence[KeyframeFeatures], disparities: Sequence[np.ndarray]
    ) -> list[Keyframe]:
        return [
            Keyframe(
                index=index,
                keypoints=feature.keypoints,
                descriptors=feature.descriptors,
                k=feature.k,
                disparity=disparity,
            )
            for index, (feature, disparity) in enumerate(zip(features, disparities))
        ]

    @staticmethod
    def _calibrate(keyframes, cv2, matcher, gates) -> DepthAffine | None:
        """Freeze the depth affine from the first consecutive pair that calibrates."""
        for index in range(len(keyframes) - 1):
            affine = calibrate_pair(
                keyframes[index], keyframes[index + 1], cv2=cv2, matcher=matcher, **gates
            )
            if affine is not None:
                return affine
        return None

    @staticmethod
    def _metric_chain(keyframes, affine, cv2, matcher, gates) -> np.ndarray:
        """Re-chain world-from-camera poses with metric consecutive baselines.

        Mirrors the online step: each consecutive pair's translation is scaled to
        metric via the frozen affine, so the nodes are in the same units as the
        loop edges. A pair that cannot be verified holds the pose steady, exactly
        as the VO front end does on a weak frame.
        """
        cfw = np.eye(4, dtype=np.float64)
        poses = [np.linalg.inv(cfw)]
        for index in range(len(keyframes) - 1):
            result = verify_pair(
                keyframes[index], keyframes[index + 1], affine, cv2=cv2, matcher=matcher, **gates
            )
            if result is None:
                rot, trans = np.eye(3, dtype=np.float64), np.zeros(3, dtype=np.float64)
            else:
                rot, trans = result
            cfw = _compose_camera_from_world(cfw, rot, trans)
            poses.append(np.linalg.inv(cfw))
        return np.stack(poses)
