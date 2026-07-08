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
    assert entry["commercialUse"] is False

    # The other backends must still be registered.
    assert "synthetic" in infos
    assert "depth-anything-v2-small" in infos
