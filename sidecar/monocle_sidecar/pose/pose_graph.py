"""Global pose-graph optimization with loop closure over keyframe poses.

The default walk-around recovers camera poses greedily, frame to frame (ORB
visual odometry), so error accumulates and a path that returns to an earlier
viewpoint does not close. This module refines a set of world-from-camera
keyframe poses into a globally consistent set by expressing them as an Open3D
pose graph and running its Levenberg-Marquardt global optimization.

The graph has one node per keyframe (initialized at the odometry pose) and two
kinds of edges:

  - odometry edges between consecutive keyframes, marked certain, holding the
    locally reliable frame-to-frame motion, and
  - loop-closure edges between temporally distant keyframes that were matched and
    geometrically verified elsewhere, marked uncertain so Open3D's line process
    can down-weight a false match rather than warping the whole trajectory.

Optimization redistributes the accumulated drift so the loop constraints are
satisfied. Open3D is imported lazily: the pure edge math is usable and testable
without it, and a build without the reconstruct extra can still import this file.

Pose convention matches pose.base.PoseResult: (N, 4, 4) world-from-camera (T_wc),
one per keyframe. An edge transformation is target-from-source (it maps a point
in the source camera frame into the target camera frame), the same convention
Open3D's PoseGraphEdge expects, so node poses and edges stay consistent.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

# A geometrically verified loop closure is a strong, trusted constraint, so its
# edge is weighted well above a single odometry step. Without this the line
# process treats the loop as an outlier against accumulated drift and prunes it,
# leaving the trajectory open. Callers with a real match confidence can override
# it per edge via LoopEdge.information.
_DEFAULT_LOOP_WEIGHT = 30.0


@dataclass(frozen=True)
class LoopEdge:
    """A verified loop-closure constraint between two keyframes.

    Attributes:
        source: index of the source keyframe.
        target: index of the target keyframe; source != target and the pair is
            temporally distant (that is what makes it a loop, not odometry).
        transformation: (4, 4) target-from-source relative pose measured at the
            loop, mapping points in the source camera frame into the target
            camera frame. Its translation must already be metric, in the same
            units as the keyframe poses (scale it with pose.metric_scale first).
        information: optional (6, 6) information matrix weighting the edge;
            identity by default.
    """

    source: int
    target: int
    transformation: np.ndarray
    information: np.ndarray | None = None


def relative_transform(pose_source: np.ndarray, pose_target: np.ndarray) -> np.ndarray:
    """Target-from-source relative pose from two world-from-camera poses.

    Returns ``inv(T_wc_target) @ T_wc_source``, which maps a point in the source
    camera frame into the target camera frame. Pure, so the edge math is unit
    tested without Open3D.
    """
    source = np.asarray(pose_source, dtype=np.float64)
    target = np.asarray(pose_target, dtype=np.float64)
    return np.linalg.inv(target) @ source


def optimize_pose_graph(
    poses: np.ndarray,
    loop_edges: Sequence[LoopEdge] = (),
    *,
    max_correspondence_distance: float = 0.05,
    edge_prune_threshold: float = 0.25,
    preference_loop_closure: float = 10.0,
    reference_node: int = 0,
) -> np.ndarray:
    """Return globally optimized (N, 4, 4) world-from-camera poses.

    Builds a pose graph from the odometry poses (consecutive certain edges) plus
    any verified loop-closure edges (uncertain), runs Open3D's global
    optimization, and reads the corrected node poses back. With no loop edges the
    graph is a chain and the poses are returned essentially unchanged; a loop edge
    ties two distant keyframes and the optimizer redistributes the drift between
    them so the loop closes.

    Args:
        poses: (N, 4, 4) world-from-camera odometry poses, in capture order.
        loop_edges: verified loop-closure constraints.
        max_correspondence_distance: Open3D pruning distance for the line process.
        edge_prune_threshold: below-threshold uncertain edges are pruned.
        preference_loop_closure: how strongly to trust loop edges over drift.
        reference_node: the node held fixed as the world frame (usually 0).

    Raises:
        ImportError: if Open3D (the reconstruct extra) is not installed.
        ValueError: if poses is not (N, 4, 4) with N >= 1, or an edge index is
            out of range.
    """
    import open3d as o3d

    poses = np.asarray(poses, dtype=np.float64)
    if poses.ndim != 3 or poses.shape[1:] != (4, 4):
        raise ValueError(f"poses must have shape (N, 4, 4); got {poses.shape}.")
    count = poses.shape[0]
    if count == 0:
        raise ValueError("poses must have at least one frame.")

    graph = o3d.pipelines.registration.PoseGraph()
    for index in range(count):
        graph.nodes.append(o3d.pipelines.registration.PoseGraphNode(poses[index].copy()))

    identity_info = np.identity(6)
    for index in range(count - 1):
        graph.edges.append(
            o3d.pipelines.registration.PoseGraphEdge(
                index,
                index + 1,
                relative_transform(poses[index], poses[index + 1]),
                identity_info,
                uncertain=False,
            )
        )

    for edge in loop_edges:
        if not (0 <= edge.source < count and 0 <= edge.target < count):
            raise ValueError(
                f"loop edge ({edge.source}, {edge.target}) out of range for {count} frames."
            )
        info = (
            identity_info * _DEFAULT_LOOP_WEIGHT
            if edge.information is None
            else np.asarray(edge.information, dtype=np.float64)
        )
        graph.edges.append(
            o3d.pipelines.registration.PoseGraphEdge(
                edge.source,
                edge.target,
                np.asarray(edge.transformation, dtype=np.float64),
                info,
                uncertain=True,
            )
        )

    option = o3d.pipelines.registration.GlobalOptimizationOption(
        max_correspondence_distance=max_correspondence_distance,
        edge_prune_threshold=edge_prune_threshold,
        preference_loop_closure=preference_loop_closure,
        reference_node=reference_node,
    )
    o3d.pipelines.registration.global_optimization(
        graph,
        o3d.pipelines.registration.GlobalOptimizationLevenbergMarquardt(),
        o3d.pipelines.registration.GlobalOptimizationConvergenceCriteria(),
        option,
    )

    return np.array([np.asarray(node.pose, dtype=np.float64) for node in graph.nodes])
