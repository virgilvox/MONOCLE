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
from .gates import OFFLINE_GATES
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
    # True per keyframe that was geometrically located against the last placed
    # frame; a False frame holds its predecessor's pose and must NOT be fused (its
    # depth would land at a stale pose and smear). None means "no placement info",
    # treated as all-placed for backward compatibility.
    placed: list[bool] | None = None


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
        odometry: optional injected front end exposing ``estimate_with_features``
            (for tests); the ORB ``OrbVisualOdometry`` is constructed lazily when
            omitted. Symmetric to ``depth_runner``: injecting both drives the full
            loop-closure and pose-graph path on synthetic features without real
            ORB detection on pixels or the Depth Anything weights.
    """

    def __init__(
        self,
        n_features: int = 2000,
        # Gate defaults come from the shared offline set; see pose/gates.py for
        # why they are stricter than the live path's.
        ratio: float = OFFLINE_GATES.ratio,
        min_matches: int = OFFLINE_GATES.min_matches,
        min_inliers: int = OFFLINE_GATES.min_inliers,
        min_index_gap: int = 8,
        min_parallax_px: float = OFFLINE_GATES.min_parallax_px,
        loop_closure: bool = False,
        depth_runner=None,
        odometry=None,
    ) -> None:
        self.n_features = n_features
        self.ratio = ratio
        self.min_matches = min_matches
        self.min_inliers = min_inliers
        self.min_index_gap = min_index_gap
        self.min_parallax_px = min_parallax_px
        # Loop closure + pose-graph optimization is off by default. The greedy metric
        # chain is what verifiably fused a coherent body; global optimization helps
        # only a long path that truly revisits a viewpoint, and on a short, noisy
        # monocular object sweep a scale-drifted or false loop edge warps the whole
        # track. A caller whose capture closes a real loop opts in.
        self.loop_closure = loop_closure
        self._depth_runner = depth_runner
        self._odometry = odometry

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

        vo = self._odometry or OrbVisualOdometry(self.n_features, self.ratio, self.min_matches)
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

        metric_poses, placed = self._metric_chain(keyframes, affine, cv2, matcher, gates)

        # Default: the greedy metric chain that verifiably fuses a coherent body.
        # Loop closure is opt-in (see __init__), because on a short, noisy monocular
        # sweep global optimization tends to warp more than it corrects.
        if not self.loop_closure:
            return MetricPoseResult(PoseResult(poses=metric_poses), affine, keyframes, [], placed)

        gap = effective_index_gap(len(keyframes), self.min_index_gap)
        edges = detect_loop_edges(
            keyframes,
            affine,
            cv2=cv2,
            matcher=matcher,
            min_index_gap=gap,
            **gates,
        )

        final_poses = metric_poses
        if edges:
            optimized = optimize_pose_graph(np.asarray(metric_poses, dtype=np.float64), edges)
            # A degenerate graph can diverge; fall back to the greedy chain rather
            # than fuse at non-finite poses.
            if np.isfinite(optimized).all():
                final_poses = optimized

        # A frame is fusible when odometry placed it OR a loop edge locates it: the
        # return-to-start frame of a real loop typically fails odometry against its
        # far-side neighbour but is exactly what a loop edge pins, so it must not be
        # dropped. A frame with neither is unlocated and stays out of fusion.
        edge_nodes = {edge.source for edge in edges} | {edge.target for edge in edges}
        fusible = [placed[i] or i in edge_nodes for i in range(len(keyframes))]
        return MetricPoseResult(PoseResult(poses=final_poses), affine, keyframes, edges, fusible)

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
    def _metric_chain(keyframes, affine, cv2, matcher, gates) -> tuple[np.ndarray, list[bool]]:
        """Greedily re-chain world-from-camera poses, tracking against the last
        placed frame, and report which frames were located.

        This mirrors the online walk-around's reference-frame invariant
        (``live.py``), which is what the earlier greedy engine did when it fused
        a coherent body: each frame's metric motion is measured against the *last
        successfully placed* frame (not the immediate, possibly-stale
        predecessor), so ``cfw`` always equals the pose of the reference. Only
        the invariant is mirrored; each pair is verified with the stricter
        offline gate thresholds, not live.py's looser ones (see pose/gates.py). A frame that cannot be
        verified is held at the last good pose and marked unplaced, so the fuse
        pass skips it rather than integrating a different view at a stale pose (the
        layered-smear failure the two-pass rewrite reintroduced).

        Returns ``(poses, placed)``: ``poses[i]`` is world-from-camera and
        ``placed[i]`` is True only where frame ``i`` was geometrically located.
        """
        cfw = np.eye(4, dtype=np.float64)
        poses = [np.linalg.inv(cfw)]
        placed = [True]  # frame 0 anchors the world frame
        prev = 0
        for index in range(1, len(keyframes)):
            result = verify_pair(
                keyframes[prev], keyframes[index], affine, cv2=cv2, matcher=matcher, **gates
            )
            if result is None:
                # Unplaced: hold the last good pose, do not advance the reference,
                # and let the fuse pass skip this frame.
                poses.append(np.linalg.inv(cfw))
                placed.append(False)
                continue
            rot, trans = result
            cfw = _compose_camera_from_world(cfw, rot, trans)
            poses.append(np.linalg.inv(cfw))
            placed.append(True)
            prev = index
        return np.stack(poses), placed
