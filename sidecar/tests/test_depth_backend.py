"""Tests for the Depth Anything V2 backend.

These never download a model. They cover the guard path (extras absent) and the
pure-numpy geometry helpers; the onnxruntime inference path is not exercised.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from monocle_sidecar.backends.depth_anything_v2 import (
    DepthAnythingV2Backend,
    _resolve_model_path,
    _to_metric_depth,
)
from monocle_sidecar.registry import Registry


def _noop_notify(method: str, params: dict) -> None:
    pass


def test_reconstruct_without_extras_raises(monkeypatch, tmp_path: Path) -> None:
    # Force the onnxruntime import to fail regardless of what is installed.
    monkeypatch.setitem(sys.modules, "onnxruntime", None)
    backend = Registry.load().instantiate("depth-anything-v2-small")
    with pytest.raises(RuntimeError, match="depth"):
        backend.reconstruct(
            {"framesDir": str(tmp_path), "outputDir": str(tmp_path)},
            _noop_notify,
            lambda: False,
        )


def test_registry_lists_depth_backend() -> None:
    backend = Registry.load().instantiate("depth-anything-v2-small")
    assert isinstance(backend, DepthAnythingV2Backend)


def test_resolve_model_path_missing_env(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MONOCLE_DA2_ONNX", str(tmp_path / "nope.onnx"))
    with pytest.raises(RuntimeError, match="MONOCLE_DA2_ONNX"):
        _resolve_model_path()


def test_metric_normalization_maps_disparity_to_window() -> None:
    np = pytest.importorskip("numpy")
    # Higher disparity means nearer, so the peak maps to near, the floor to far.
    disparity = np.array([[0.0, 1.0], [2.0, 4.0]], dtype=np.float32)
    depth = _to_metric_depth(np, disparity, near=0.2, far=0.6)
    assert depth.max() == pytest.approx(0.6)  # farthest pixel (min disparity)
    assert depth.min() == pytest.approx(0.2)  # nearest pixel (max disparity)


def test_metric_normalization_flat_input_uses_midpoint() -> None:
    np = pytest.importorskip("numpy")
    disparity = np.full((3, 3), 5.0, dtype=np.float32)
    depth = _to_metric_depth(np, disparity, near=0.2, far=0.6)
    assert np.allclose(depth, 0.4)


def test_grid_mesh_flat_depth_is_fully_connected() -> None:
    np = pytest.importorskip("numpy")
    from monocle_sidecar.backends import _depth_grid

    depth = np.full((4, 5), 0.4, dtype=np.float32)
    points = _depth_grid.backproject(depth, fx=100.0, fy=100.0, cx=2.0, cy=1.5)
    triangles = _depth_grid.build_grid_mesh(points, depth, edge_threshold=0.02)
    # (H-1) * (W-1) quads, two triangles each.
    assert len(triangles) == (4 - 1) * (5 - 1) * 2


def test_grid_mesh_drops_discontinuous_and_invalid_quads() -> None:
    np = pytest.importorskip("numpy")
    from monocle_sidecar.backends import _depth_grid

    depth = np.full((3, 3), 0.4, dtype=np.float32)
    depth[0, 0] = 0.0  # invalid: drops the single quad touching it
    depth[2, 2] = 5.0  # large jump: drops the quad touching it
    points = _depth_grid.backproject(depth, fx=100.0, fy=100.0, cx=1.0, cy=1.0)
    triangles = _depth_grid.build_grid_mesh(points, depth, edge_threshold=0.02)
    # 4 quads total, both corner quads dropped, 2 remain -> 4 triangles.
    assert len(triangles) == 2 * 2
