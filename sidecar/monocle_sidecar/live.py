"""Experimental live walk-around fusion: a mesh that forms as you scan.

This drives an incremental reconstruction so a preview can grow frame by frame
while the user moves the camera. For each new keyframe it estimates the camera
pose with ORB visual odometry, predicts up-to-scale depth with Depth Anything V2,
ties both onto a single metric scale, and integrates the posed depth into a
persistent TSDF volume, then extracts the current mesh.

The scale tie is the whole game. Monocular VO recovers translation only up to an
unknown scale, and monocular depth is affine-invariant, so fusing them naively
gives an incoherent volume (the cause of the old garbled scans). The engine now
calibrates one disparity-to-depth affine from the first well-conditioned pair and
freezes it, so every frame shares one metric, then derives each camera baseline
from that depth. See ``pose/metric_scale.py`` for the geometry.

It is honest about what it is: a preview, not metrology. VO has no loop closure,
so error still accumulates over a long path, and the absolute scale is arbitrary
(the first baseline defines the unit). But a fixed surface now lands in the same
place from every view, which is what lets the volume converge instead of smear.

The heavy dependencies (OpenCV, Open3D, onnxruntime) load lazily so the module
import stays cheap.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from .fusion.frames import PosedDepthFrame
from .pose.metric_scale import (
    calibrate_depth_affine,
    median_displacement,
    sample_nearest,
    translation_scale,
    triangulate,
)
from .pose.visual_odometry import _compose_camera_from_world


class DepthRunner:
    """Per-frame Depth Anything V2 disparity at a bounded working resolution.

    Wraps the single-view backend's proven inference and downsampling so live
    fusion reuses exactly the same depth pipeline, loading the ONNX session once.
    It returns the model's raw up-to-scale disparity (inverse depth), NOT a metric
    depth: the walk-around calibrates one global disparity-to-depth mapping across
    the whole capture, so mapping per frame here would be the very inconsistency
    that garbled fusion.
    """

    def __init__(self, frames_dir: Path | None = None, mesh_max_dim: int = 224) -> None:
        from .backends import depth_anything_v2 as da2

        self._da2 = da2
        self._np, self._ort, self._Image = da2._require_deps()
        self._session = da2._load_session(self._ort)
        self._mesh_max_dim = mesh_max_dim
        # Real intrinsics live in framesDir/intrinsics.json; fall back to a guess
        # only when the capture did not write them.
        self._frames_dir = Path(frames_dir) if frames_dir is not None else Path(".")

    def run(self, image: Any) -> tuple[Any, Any, dict]:
        """Return (disparity, rgb, intrinsics) downsampled and aligned for fusion."""
        da2, np = self._da2, self._np
        width, height = image.size
        rgb = np.asarray(image, dtype=np.uint8)
        intrinsics = da2._load_intrinsics(np, self._frames_dir, width, height)
        disparity = da2._infer_disparity(np, self._Image, self._session, image, width, height)
        disp_ds, rgb_ds, fx, fy, cx, cy = da2._downsample(
            np, disparity, rgb, intrinsics, self._mesh_max_dim
        )
        h, w = disp_ds.shape[:2]
        intr = {"fx": fx, "fy": fy, "cx": cx, "cy": cy, "width": float(w), "height": float(h)}
        return disp_ds.astype(np.float32), rgb_ds, intr


class LiveWalkFusion:
    """Incremental TSDF fusion of a monocular walk-around, one keyframe at a time.

    Call ``add_frame`` per keyframe; it returns the current fused mesh, or None
    until the pose track calibrates a metric scale (which needs one pair with real
    parallax) and the first geometry integrates. Experimental.
    """

    def __init__(
        self,
        depth_runner: DepthRunner | None = None,
        frames_dir: Path | None = None,
        voxel_size: float = 0.006,
        sdf_trunc: float = 0.03,
        depth_trunc: float = 3.0,
        n_features: int = 1500,
        ratio: float = 0.75,
        min_matches: int = 20,
        min_parallax_px: float = 2.5,
    ) -> None:
        import os

        # OpenMP coexistence. OpenCV, Open3D, and onnxruntime each ship their own
        # libomp; a bad init order can segfault Open3D's TSDF integration (OMP
        # #179) and a duplicate load can abort the process (OMP #15), either of
        # which kills the sidecar with no traceback. The real fix lives at the
        # sidecar entry point (__main__._pin_openmp_runtime imports Open3D before
        # any request can load cv2, and sets KMP_DUPLICATE_LIB_OK first). These
        # setdefaults and the Open3D-before-cv2 order below are a fallback for when
        # LiveWalkFusion is constructed directly (tests, embedding) without going
        # through that entry point.
        os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

        from .fusion import tsdf as tsdf_mod

        o3d = tsdf_mod._require_open3d()  # pin Open3D's OpenMP before cv2 loads
        import cv2

        self._cv2 = cv2
        self._o3d = o3d
        self._tsdf = tsdf_mod
        self._volume = o3d.pipelines.integration.ScalableTSDFVolume(
            voxel_length=voxel_size,
            sdf_trunc=sdf_trunc,
            color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8,
        )
        self._depth_trunc = depth_trunc
        self._depth = depth_runner or DepthRunner(frames_dir=frames_dir)
        self._orb = cv2.ORB_create(n_features)
        self._matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
        self._ratio = ratio
        self._min_matches = min_matches
        self._min_parallax_px = min_parallax_px

        # One disparity-to-metric-depth affine, frozen once calibrated, shared by
        # every frame. Until it exists no frame can be placed in a common metric.
        self._affine = None
        # The first camera to integrate defines the world frame.
        self._cfw = np.eye(4, dtype=np.float64)
        self._prev: dict | None = None
        self._integrated = 0
        self.frame_count = 0

    def add_frame(self, image_path: Path) -> Any:
        """Integrate one keyframe and return the current mesh (None until it forms)."""
        from PIL import Image

        with Image.open(image_path) as handle:
            image = handle.convert("RGB")
        disparity, rgb, intr = self._depth.run(image)

        gray = self._cv2.cvtColor(rgb, self._cv2.COLOR_RGB2GRAY)
        keypoints, descriptors = self._orb.detectAndCompute(gray, None)
        k = _intrinsics_matrix(intr)
        curr = {
            "kp": keypoints,
            "desc": descriptors,
            "k": k,
            "disparity": disparity,
            "rgb": rgb,
            "intr": intr,
        }
        self.frame_count += 1

        if self._prev is None:
            # Seed the track; the first frame integrates once the scale is known.
            self._prev = curr
            return self._current_mesh()

        # Advance the reference frame only when this one was placed. Keeping the
        # last successfully-tracked frame as the reference preserves the invariant
        # that self._cfw is exactly the pose of self._prev, so a dropped frame
        # never leaves the next motion composed onto a stale pose.
        if self._track_and_integrate(curr):
            self._prev = curr
        return self._current_mesh()

    def _track_and_integrate(self, curr: dict) -> bool:
        """Recover this frame's metric pose against the previous one and fuse it.

        Returns True when the frame was placed and integrated. On any failure (too
        few matches, too little parallax, degenerate pose, no trustworthy scale) it
        integrates nothing and returns False: dumping depth at a stale pose is what
        layered misaligned surfaces into the old scans.
        """
        prev = self._prev
        assert prev is not None
        match = self._match(prev, curr)
        if match is None:
            return False
        prev_pts, curr_pts = match
        if median_displacement(prev_pts, curr_pts) < self._min_parallax_px:
            return False

        pose = self._recover_pose(prev_pts, curr_pts, curr["k"])
        if pose is None:
            return False
        rot, unit_t, inliers = pose
        prev_pts, curr_pts = prev_pts[inliers], curr_pts[inliers]

        points, valid = triangulate(curr["k"], rot, unit_t, prev_pts, curr_pts)
        if int(valid.sum()) < self._min_matches:
            return False
        prev_pts = prev_pts[valid]
        unit_depths = points[valid, 2]

        anchor_pending = self._affine is None
        if anchor_pending:
            disp_samples = sample_nearest(prev["disparity"], prev_pts)
            affine = calibrate_depth_affine(disp_samples, unit_depths)
            if affine is None:
                return False
            self._affine = affine

        prev_metric = self._affine.depth(prev["disparity"])
        metric_depths = sample_nearest(prev_metric, prev_pts)
        scale = translation_scale(metric_depths, unit_depths)
        if scale is None:
            # Roll back a just-set affine so a later, better pair can calibrate.
            if anchor_pending:
                self._affine = None
            return False

        if anchor_pending:
            # The previous frame is the anchor: integrate it at the world origin.
            self._integrate_frame(prev, np.eye(4, dtype=np.float64))

        self._cfw = _compose_camera_from_world(self._cfw, rot, unit_t * scale)
        self._integrate_frame(curr, self._cfw)
        return True

    def _match(self, prev: dict, curr: dict) -> tuple[np.ndarray, np.ndarray] | None:
        """Ratio-tested ORB correspondences as (prev_pts, curr_pts), or None."""
        prev_desc, curr_desc = prev["desc"], curr["desc"]
        if prev_desc is None or curr_desc is None or len(prev_desc) < 2 or len(curr_desc) < 2:
            return None
        pairs = [p for p in self._matcher.knnMatch(prev_desc, curr_desc, k=2) if len(p) == 2]
        good = [m for m, n in pairs if m.distance < self._ratio * n.distance]
        if len(good) < self._min_matches:
            return None
        prev_pts = np.float64([prev["kp"][m.queryIdx].pt for m in good])
        curr_pts = np.float64([curr["kp"][m.trainIdx].pt for m in good])
        return prev_pts, curr_pts

    def _recover_pose(
        self, prev_pts: np.ndarray, curr_pts: np.ndarray, k: np.ndarray
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
        """(R, unit_t, inlier_mask) for the current-from-previous motion, or None."""
        cv2 = self._cv2
        essential, mask = cv2.findEssentialMat(
            prev_pts, curr_pts, k, method=cv2.RANSAC, prob=0.999, threshold=1.0
        )
        if essential is None or essential.shape != (3, 3):
            return None
        count, rot, trans, mask = cv2.recoverPose(essential, prev_pts, curr_pts, k, mask=mask)
        if count < self._min_matches:
            return None
        inliers = mask.ravel() > 0
        return rot.astype(np.float64), trans.reshape(3).astype(np.float64), inliers

    def _integrate_frame(self, frame: dict, cfw: np.ndarray) -> None:
        """Build a metric PosedDepthFrame from a stored frame and integrate it."""
        assert self._affine is not None
        depth = self._affine.depth(frame["disparity"])
        posed = PosedDepthFrame(
            depth=depth, intrinsics=frame["intr"], pose=cfw, color=frame["rgb"]
        )
        self._integrate(posed)
        self._integrated += 1

    def _integrate(self, frame: PosedDepthFrame) -> None:
        intrinsic = self._tsdf._to_pinhole(self._o3d, frame.intrinsics)
        rgbd = self._tsdf._to_rgbd(self._o3d, np, frame, True, self._depth_trunc)
        extrinsic = np.ascontiguousarray(frame.pose, dtype=np.float64)
        self._volume.integrate(rgbd, intrinsic, extrinsic)

    def _current_mesh(self) -> Any:
        """The mesh so far, or None until at least one frame has been fused."""
        if self._integrated == 0:
            return None
        mesh = self._volume.extract_triangle_mesh()
        mesh.compute_vertex_normals()
        return mesh


def _intrinsics_matrix(intr: dict) -> np.ndarray:
    return np.array(
        [[intr["fx"], 0.0, intr["cx"]], [0.0, intr["fy"], intr["cy"]], [0.0, 0.0, 1.0]],
        dtype=np.float64,
    )
