"""MASt3R-SLAM pose estimator, behind the optional ``slam`` extra.

MASt3R-SLAM is the reference dense monocular SLAM tracker from docs/SLAM.md: it
maps a walk-around into a globally consistent per-frame pose track with loop
closure, which visual odometry cannot reach. It is a heavy, GPU-first stack, so
this module follows the same posture as the Depth Anything 3 backend: the class
and its metadata exist unconditionally so the pipeline can offer it, but the
heavy path raises one clear, actionable error until the ``slam`` extra and the
tracker package are installed. Nothing here imports torch or the tracker at
module load, so the pose package stays importable on the plain CI environment.

Its checkpoints are non-commercial; gate them for a shippable build the way
``multiview.py`` gates the DA3-LARGE and DA3-GIANT weights.
"""

from __future__ import annotations

from collections.abc import Sequence

from .base import FrameRef, PoseEstimator, PoseResult

_EXTRA_HINT = (
    "MASt3R-SLAM is unavailable: install the 'slam' extra "
    "(pip install -e '.[slam]') for torch, then install the tracker package "
    "per docs/SLAM.md (it is not on PyPI and is installed separately, like "
    "Depth Anything 3)."
)


class MASt3RSlamPoseEstimator(PoseEstimator):
    """Recover poses with MASt3R-SLAM. Requires the ``slam`` extra and tracker."""

    def __init__(self, checkpoint: str | None = None) -> None:
        # Deferred to estimate() so constructing the object (for listing or
        # selection) never triggers the heavy import.
        self.checkpoint = checkpoint

    def estimate(self, frames: Sequence[FrameRef]) -> PoseResult:
        if not frames:
            raise ValueError("estimate needs at least one frame.")
        tracker = _require_tracker()
        return _run_tracker(tracker, frames, self.checkpoint)


def _require_tracker():
    """Import the tracker stack, or explain how to install it.

    torch is the floor dependency, so its absence is the clearest signal the
    ``slam`` extra is off; the tracker package is checked after it.
    """
    try:
        import torch  # noqa: F401
    except ImportError as error:
        raise RuntimeError(_EXTRA_HINT) from error
    try:
        import mast3r_slam  # type: ignore  # noqa: F401
    except ImportError as error:
        raise RuntimeError(_EXTRA_HINT) from error
    return mast3r_slam


def _run_tracker(tracker, frames: Sequence[FrameRef], checkpoint: str | None) -> PoseResult:
    """Run the MASt3R-SLAM tracker over the frames and return world-from-camera poses.

    Isolated and flagged for verification against the pinned tracker release, in
    the same way ``multiview._run_da3`` isolates the Depth Anything 3 call. The
    concrete tracker API is intentionally not guessed here: wiring it to the
    installed package's real entry point, and validating the recovered poses on a
    known sequence, is the remaining Phase 2 integration in docs/SLAM.md.
    """
    raise NotImplementedError(
        "MASt3R-SLAM is installed but not yet wired to its tracker API. "
        "See docs/SLAM.md for the remaining integration; until then use the "
        "'orb' visual-odometry estimator for a real CPU pose track."
    )
