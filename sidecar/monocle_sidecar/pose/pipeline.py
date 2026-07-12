"""Run a pose estimator over a capture and persist the result for fusion.

This is the bridge from the PoseEstimator seam to the reconstruction pipeline.
For a backend that declares ``needs_poses``, the server runs a configured
estimator over the frames directory and writes ``poses.json`` next to the
frames; a depth backend then reads those poses and builds ``PosedDepthFrame``s
without re-deriving pose. Keeping the stage here, rather than inside any one
backend, is what lets a SLAM method be swapped in as a module choice instead of
a fork of the reconstruction code.

``poses.json`` stores one camera-from-world (world->camera) 4x4 per frame in
column-major order, the extrinsic form fusion consumes, so an external pose
source (a turntable's known angles, a marker rig, or a real SLAM tracker) can
write the same file and drive the same backend.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from .base import FrameRef, PoseEstimator
from .identity import IdentityPoseEstimator
from .visual_odometry import OrbVisualOdometry

# Estimator id (a reconstruct param) to its class. Classes are cheap to import;
# each defers its heavy dependency (OpenCV, torch, a tracker) until it runs.
_ESTIMATORS: dict[str, type[PoseEstimator]] = {
    "identity": IdentityPoseEstimator,
    "orb": OrbVisualOdometry,
}


def make_estimator(name: str) -> PoseEstimator:
    """Construct a pose estimator by id, or raise a clear error for an unknown one.

    ``mast3r`` is resolved lazily so its module (and its heavy optional extra) is
    only imported when explicitly requested.
    """
    if name == "mast3r":
        from .mast3r import MASt3RSlamPoseEstimator

        return MASt3RSlamPoseEstimator()
    estimator = _ESTIMATORS.get(name)
    if estimator is None:
        known = ", ".join([*sorted(_ESTIMATORS), "mast3r"])
        raise ValueError(f"unknown pose estimator '{name}'; known: {known}")
    return estimator()


def list_frames(frames_dir: Path) -> list[Path]:
    """The sorted RGB keyframes of a capture."""
    return sorted(frames_dir.glob("frame_*.png"))


def _load_intrinsics(frames_dir: Path) -> dict | None:
    """Read framesDir/intrinsics.json if present, else None (estimator assumes)."""
    path = frames_dir / "intrinsics.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    return {key: float(data[key]) for key in ("fx", "fy", "cx", "cy") if key in data}


def run_pose_stage(
    frames_dir: Path,
    estimator: str = "orb",
    notify: Callable[[str, dict[str, Any]], None] | None = None,
) -> Path:
    """Estimate a pose per frame and write ``poses.json`` into ``frames_dir``.

    Returns the path written. Raises if the capture has no frames.
    """
    frames_dir = Path(frames_dir)
    paths = list_frames(frames_dir)
    if not paths:
        raise RuntimeError(f"no frames found in {frames_dir} (expected frame_00000.png ...)")

    if notify is not None:
        notify(
            "progress",
            {"stage": "pose", "ratio": 0.0, "message": f"estimating pose ({estimator})"},
        )

    intrinsics = _load_intrinsics(frames_dir)
    refs = [FrameRef(image=path, intrinsics=intrinsics) for path in paths]
    result = make_estimator(estimator).estimate(refs)

    out_path = write_poses_json(frames_dir, result.extrinsics())
    if notify is not None:
        notify("progress", {"stage": "pose", "ratio": 1.0, "message": "pose estimated"})
    return out_path


def write_poses_json(frames_dir: Path, extrinsics: np.ndarray) -> Path:
    """Write (N, 4, 4) camera-from-world matrices as column-major flat lists."""
    extrinsics = np.asarray(extrinsics, dtype=np.float64)
    if extrinsics.ndim != 3 or extrinsics.shape[1:] != (4, 4):
        raise ValueError(f"extrinsics must be (N, 4, 4); got {extrinsics.shape}.")
    payload = {"poses": [pose.flatten(order="F").tolist() for pose in extrinsics]}
    out_path = Path(frames_dir) / "poses.json"
    out_path.write_text(json.dumps(payload), encoding="utf-8")
    return out_path


def load_poses(frames_dir: Path) -> np.ndarray:
    """Read ``poses.json`` back into (N, 4, 4) camera-from-world matrices."""
    path = Path(frames_dir) / "poses.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    flats = data["poses"]
    return np.array(
        [np.asarray(flat, dtype=np.float64).reshape(4, 4, order="F") for flat in flats]
    )
