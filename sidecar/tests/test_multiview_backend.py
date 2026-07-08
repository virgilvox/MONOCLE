"""Tests for the Depth Anything 3 multi-view backend and its registry entry.

These run without any model weights or the 'reconstruct' extra installed: the
backend must still be listable and must fail with a clear, actionable error.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from monocle_sidecar.registry import Registry


def _noop_notify(method: str, params: dict) -> None:
    pass


def test_reconstruct_without_extras_raises_helpful_error(tmp_path: Path) -> None:
    backend = Registry.load().instantiate("depth-anything-3")
    params = {"framesDir": str(tmp_path), "outputDir": str(tmp_path / "out")}

    with pytest.raises(RuntimeError, match="reconstruct"):
        backend.reconstruct(params, _noop_notify, lambda: False)


def test_registry_lists_depth_anything_3_multiview() -> None:
    infos = {info["id"]: info for info in Registry.load().describe_all()}

    assert "depth-anything-3" in infos
    entry = infos["depth-anything-3"]
    assert entry["capabilities"]["multiview"] is True
    # Default checkpoint is Apache-2.0 (DA3-BASE); CC-BY-NC weights are opt-in.
    assert entry["commercialUse"] is True

    # The other backends must still be registered.
    assert "synthetic" in infos
    assert "depth-anything-v2-small" in infos


def test_pad_extrinsic_promotes_3x4_to_4x4() -> None:
    np = pytest.importorskip("numpy")
    from monocle_sidecar.backends.multiview import _pad_extrinsic

    # DA3 hands back a (3, 4) [R | t] world->camera matrix.
    pose_3x4 = np.arange(12, dtype=np.float64).reshape(3, 4)
    result = _pad_extrinsic(pose_3x4)

    assert result.shape == (4, 4)
    # Top three rows are preserved verbatim; the added row is the homogeneous one.
    assert np.array_equal(result[:3], pose_3x4)
    assert np.array_equal(result[3], np.array([0.0, 0.0, 0.0, 1.0]))


def test_pad_extrinsic_passes_4x4_through() -> None:
    np = pytest.importorskip("numpy")
    from monocle_sidecar.backends.multiview import _pad_extrinsic

    pose = np.eye(4, dtype=np.float64)
    assert np.array_equal(_pad_extrinsic(pose), pose)


def test_pad_extrinsic_rejects_unexpected_shape() -> None:
    np = pytest.importorskip("numpy")
    from monocle_sidecar.backends.multiview import _pad_extrinsic

    with pytest.raises(RuntimeError, match="unexpected shape"):
        _pad_extrinsic(np.zeros((2, 2), dtype=np.float64))
