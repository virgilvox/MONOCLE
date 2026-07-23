"""The live and offline gate sets are pinned and wired to their sites.

The numeric values are behavior tuned on real captures: a change must be a
deliberate edit to pose/gates.py, never drift at one of the consuming sites.
"""

from __future__ import annotations

import inspect

from monocle_sidecar.pose import loop_closure
from monocle_sidecar.pose.gates import LIVE_GATES, OFFLINE_GATES, GateSet
from monocle_sidecar.pose.orb_pgo import OrbPgoPoseEstimator


def test_gate_values_are_pinned() -> None:
    assert LIVE_GATES == GateSet(ratio=0.75, min_matches=20, min_parallax_px=2.5)
    assert OFFLINE_GATES == GateSet(
        ratio=0.75,
        min_matches=25,
        min_parallax_px=3.0,
        min_inliers=15,
        min_scale_samples=8,
    )


def test_loop_closure_constants_come_from_the_offline_set() -> None:
    assert loop_closure._RATIO == OFFLINE_GATES.ratio
    assert loop_closure._MIN_MATCHES == OFFLINE_GATES.min_matches
    assert loop_closure._MIN_INLIERS == OFFLINE_GATES.min_inliers
    assert loop_closure._MIN_PARALLAX_PX == OFFLINE_GATES.min_parallax_px
    assert loop_closure._MIN_SCALE_SAMPLES == OFFLINE_GATES.min_scale_samples


def test_orb_pgo_defaults_come_from_the_offline_set() -> None:
    signature = inspect.signature(OrbPgoPoseEstimator.__init__)
    assert signature.parameters["ratio"].default == OFFLINE_GATES.ratio
    assert signature.parameters["min_matches"].default == OFFLINE_GATES.min_matches
    assert signature.parameters["min_inliers"].default == OFFLINE_GATES.min_inliers
    assert signature.parameters["min_parallax_px"].default == OFFLINE_GATES.min_parallax_px


def test_live_fusion_defaults_come_from_the_live_set() -> None:
    from monocle_sidecar.live import LiveWalkFusion

    signature = inspect.signature(LiveWalkFusion.__init__)
    assert signature.parameters["ratio"].default == LIVE_GATES.ratio
    assert signature.parameters["min_matches"].default == LIVE_GATES.min_matches
    assert signature.parameters["min_parallax_px"].default == LIVE_GATES.min_parallax_px
