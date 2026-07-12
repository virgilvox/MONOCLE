"""Experimental live walk-around fusion: a mesh that forms as you scan.

This drives an incremental reconstruction so a preview can grow frame by frame
while the user moves the camera. For each new keyframe it estimates the camera
pose with ORB visual odometry, predicts depth with Depth Anything V2, ties the
depth to the pose track's scale, and integrates it into a persistent TSDF volume,
then extracts the current mesh.

It is honest about what it is: a preview, not metrology. Monocular VO recovers
pose only up to scale and drifts, and monocular depth is relative, so the fused
geometry is approximate and gets rougher the longer the path. The scale between
the two is tied with a scene-depth heuristic rather than the full sparse-point
alignment in pose/scale_align.py, which is the accuracy upgrade path. The heavy
dependencies (OpenCV, Open3D, onnxruntime) load lazily so the module import stays
cheap.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from .fusion.frames import PosedDepthFrame
from .pose.visual_odometry import _compose_camera_from_world


class DepthRunner:
    """Per-frame Depth Anything V2 depth at a bounded working resolution.

    Wraps the single-view backend's proven inference and downsampling so live
    fusion reuses exactly the same depth pipeline, loading the ONNX session once.
    """

    def __init__(self, mesh_max_dim: int = 224, near: float = 0.2, far: float = 0.6) -> None:
        from .backends import depth_anything_v2 as da2

        self._da2 = da2
        self._np, self._ort, self._Image = da2._require_deps()
        self._session = da2._load_session(self._ort)
        self._mesh_max_dim = mesh_max_dim
        self._near = near
        self._far = far

    def run(self, image: Any) -> tuple[Any, Any, dict]:
        """Return (depth, rgb, intrinsics) downsampled and aligned for fusion."""
        da2, np = self._da2, self._np
        width, height = image.size
        rgb = np.asarray(image, dtype=np.uint8)
        intrinsics = da2._load_intrinsics(np, Path("."), width, height)
        disparity = da2._infer_disparity(np, self._Image, self._session, image, width, height)
        depth = da2._to_metric_depth(np, disparity, self._near, self._far)
        depth_ds, rgb_ds, fx, fy, cx, cy = da2._downsample(
            np, depth, rgb, intrinsics, self._mesh_max_dim
        )
        h, w = depth_ds.shape[:2]
        intr = {"fx": fx, "fy": fy, "cx": cx, "cy": cy, "width": float(w), "height": float(h)}
        return depth_ds.astype(np.float32), rgb_ds, intr


class LiveWalkFusion:
    """Incremental TSDF fusion of a monocular walk-around, one keyframe at a time.

    Call ``add_frame`` per keyframe; it returns the current fused mesh (or None
    for the very first frame, which only seeds the pose track). Experimental.
    """

    def __init__(
        self,
        depth_runner: DepthRunner | None = None,
        voxel_size: float = 0.006,
        sdf_trunc: float = 0.03,
        depth_trunc: float = 3.0,
        n_features: int = 1500,
        ratio: float = 0.75,
        min_matches: int = 20,
        motion_fraction: float = 0.08,
    ) -> None:
        import cv2

        from .fusion import tsdf as tsdf_mod

        o3d = tsdf_mod._require_open3d()
        self._cv2 = cv2
        self._o3d = o3d
        self._tsdf = tsdf_mod
        self._volume = o3d.pipelines.integration.ScalableTSDFVolume(
            voxel_length=voxel_size,
            sdf_trunc=sdf_trunc,
            color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8,
        )
        self._depth_trunc = depth_trunc
        self._depth = depth_runner or DepthRunner()
        self._orb = cv2.ORB_create(n_features)
        self._matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
        self._ratio = ratio
        self._min_matches = min_matches
        self._motion_fraction = motion_fraction

        # The first camera defines the world frame.
        self._cfw = np.eye(4, dtype=np.float64)
        self._prev: tuple[Any, Any, np.ndarray] | None = None
        self.frame_count = 0

    def add_frame(self, image_path: Path) -> Any:
        """Integrate one keyframe and return the current mesh (None on frame 1)."""
        from PIL import Image

        with Image.open(image_path) as handle:
            image = handle.convert("RGB")
        depth, rgb, intr = self._depth.run(image)

        gray = self._cv2.cvtColor(rgb, self._cv2.COLOR_RGB2GRAY)
        keypoints, descriptors = self._orb.detectAndCompute(gray, None)
        k = _intrinsics_matrix(intr)

        if self._prev is not None:
            median_depth = float(np.median(depth[depth > 0])) if np.any(depth > 0) else 0.4
            rel_r, rel_t = self._relative_motion(self._prev, (keypoints, descriptors, k))
            # Tie VO's unit translation to scene scale so motion and depth agree.
            self._cfw = _compose_camera_from_world(
                self._cfw, rel_r, rel_t * (median_depth * self._motion_fraction)
            )
        self._prev = (keypoints, descriptors, k)

        frame = PosedDepthFrame(depth=depth, intrinsics=intr, pose=self._cfw, color=rgb)
        self._integrate(frame)
        self.frame_count += 1

        if self.frame_count < 2:
            return None
        mesh = self._volume.extract_triangle_mesh()
        mesh.compute_vertex_normals()
        return mesh

    def _integrate(self, frame: PosedDepthFrame) -> None:
        intrinsic = self._tsdf._to_pinhole(self._o3d, frame.intrinsics)
        rgbd = self._tsdf._to_rgbd(self._o3d, np, frame, True, self._depth_trunc)
        extrinsic = np.ascontiguousarray(frame.pose, dtype=np.float64)
        self._volume.integrate(rgbd, intrinsic, extrinsic)

    def _relative_motion(self, prev, curr) -> tuple[np.ndarray, np.ndarray]:
        """(R, t) mapping the previous camera into the current, or no motion."""
        cv2 = self._cv2
        prev_kp, prev_desc, _ = prev
        curr_kp, curr_desc, k = curr
        identity = (np.eye(3, dtype=np.float64), np.zeros(3, dtype=np.float64))
        if prev_desc is None or curr_desc is None or len(prev_desc) < 2 or len(curr_desc) < 2:
            return identity

        pairs = [p for p in self._matcher.knnMatch(prev_desc, curr_desc, k=2) if len(p) == 2]
        good = [m for m, n in pairs if m.distance < self._ratio * n.distance]
        if len(good) < self._min_matches:
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


def _intrinsics_matrix(intr: dict) -> np.ndarray:
    return np.array(
        [[intr["fx"], 0.0, intr["cx"]], [0.0, intr["fy"], intr["cy"]], [0.0, 0.0, 1.0]],
        dtype=np.float64,
    )
