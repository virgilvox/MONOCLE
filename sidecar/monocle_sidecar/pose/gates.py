"""Named feature-matching gate sets for the live and offline pose paths.

Both paths run the same pipeline shape (ratio-tested ORB matches, a parallax
gate, essential-matrix verification, metric scaling against the frozen depth
affine) but they deliberately do not share thresholds. The live walk-around
(``live.py``) gates loosely: it sees one handheld frame at a time, a rejected
pair simply waits for the next frame, and a preview that never forms is worse
than one that occasionally accepts a marginal pair. The offline path
(``pose/loop_closure.py``, ``pose/orb_pgo.py``) gates strictly: a batch job sees
the whole capture and can afford to drop a weak pair, and a bad loop edge warps
the entire optimized track, so it demands more matches, more parallax, and a
separate geometric inlier floor.

Both sites import their set from here so the divergence stays explicit and
pinned rather than drifting apart silently. Do not nudge these numbers casually;
they are tuned against real captures (see the scan-quality history in git).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class GateSet:
    """Thresholds gating whether a keyframe pair yields a trusted relative pose.

    Attributes:
        ratio: Lowe ratio-test threshold for a descriptor match.
        min_matches: minimum ratio-tested matches to trust a pair.
        min_parallax_px: minimum median pixel displacement; below it the
            essential-matrix pose is ill-conditioned.
        min_inliers: minimum recoverPose inliers to accept a pose. None means
            the site reuses ``min_matches`` as its inlier floor (the live path).
        min_scale_samples: minimum triangulated points to trust a metric scale.
            None means the site relies on ``translation_scale``'s default floor
            (which is the same 8 the offline set pins explicitly).
    """

    ratio: float
    min_matches: int
    min_parallax_px: float
    min_inliers: int | None = None
    min_scale_samples: int | None = None


# Online preview: loose. A rejected pair costs one skipped frame, not the scan.
LIVE_GATES = GateSet(ratio=0.75, min_matches=20, min_parallax_px=2.5)

# Offline batch: strict. A weak pair is dropped outright, and a bad loop edge
# would warp the whole optimized track.
OFFLINE_GATES = GateSet(
    ratio=0.75,
    min_matches=25,
    min_parallax_px=3.0,
    min_inliers=15,
    min_scale_samples=8,
)
