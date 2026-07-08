"""Tests for the write_all export matrix and the shared mesh cleanup.

The write_all tests run on the pure-numpy floor: they force the optional libs
(Open3D, trimesh, lib3mf) to look absent so only the stdlib STL + PLY writers are
exercised, which is the guaranteed-present path. clean_mesh needs Open3D and is
skipped when it is not installed.
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

import pytest

from monocle_sidecar.fusion import export


def _square(np):
    """A unit square (two triangles) with distinct per-vertex colors."""
    vertices = np.array(
        [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]],
        dtype=np.float64,
    )
    faces = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int64)
    colors = np.array(
        [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]], dtype=np.uint8
    )
    return vertices, faces, colors


def _force_libs_absent(monkeypatch) -> None:
    """Make the optional exporters see their libraries as missing."""
    for name in ("open3d", "trimesh", "lib3mf"):
        monkeypatch.setitem(sys.modules, name, None)


def test_write_all_numpy_path_writes_stl_and_colored_ply(monkeypatch, tmp_path: Path) -> None:
    np = pytest.importorskip("numpy")
    _force_libs_absent(monkeypatch)
    vertices, faces, colors = _square(np)

    result = export.write_all(tmp_path, "scan", vertices, faces, colors=colors)

    # STL: valid binary header with a triangle count matching the input faces.
    stl = Path(result["meshPath"])
    assert stl.exists()
    data = stl.read_bytes()
    triangle_count = struct.unpack_from("<I", data, 80)[0]
    assert triangle_count == 2
    assert len(data) == 84 + triangle_count * 50

    # PLY: the stdlib fallback carries per-vertex color.
    ply = Path(result["pointCloudPath"])
    assert ply.exists()
    text = ply.read_text(encoding="utf-8")
    assert "property uchar red" in text
    assert "255 0 0" in text

    assert result["vertexCount"] == 4
    assert result["triangleCount"] == 2
    assert result["hasColor"] is True
    # No trimesh -> no GLB -> preview falls back to the STL.
    assert result["previewPath"] == result["meshPath"]
    assert set(result["artifacts"]) == {"stl", "ply"}


def test_write_all_without_color_reports_no_color(monkeypatch, tmp_path: Path) -> None:
    np = pytest.importorskip("numpy")
    _force_libs_absent(monkeypatch)
    vertices, faces, _ = _square(np)

    result = export.write_all(tmp_path, "scan", vertices, faces)

    assert result["hasColor"] is False
    assert result["previewPath"] == result["meshPath"]
    ply = Path(result["pointCloudPath"])
    assert "property uchar red" not in ply.read_text(encoding="utf-8")


def test_clean_mesh_keeps_largest_component() -> None:
    o3d = pytest.importorskip("open3d")
    from monocle_sidecar.fusion.cleanup import clean_mesh

    # A big sphere plus a tiny far-away sphere: cleanup should discard the speck.
    big = o3d.geometry.TriangleMesh.create_sphere(radius=1.0, resolution=20)
    small = o3d.geometry.TriangleMesh.create_sphere(radius=0.1, resolution=6)
    small.translate((10.0, 0.0, 0.0))
    combined = big + small
    big_triangles = len(big.triangles)

    cleaned = clean_mesh(combined, keep_largest=True)

    assert cleaned.has_vertex_normals()
    # Only the big sphere's component survives (repair may drop a few triangles).
    assert len(cleaned.triangles) <= big_triangles
    assert len(cleaned.triangles) > len(small.triangles)


def test_clean_mesh_decimates_to_budget() -> None:
    o3d = pytest.importorskip("open3d")
    from monocle_sidecar.fusion.cleanup import clean_mesh

    sphere = o3d.geometry.TriangleMesh.create_sphere(radius=1.0, resolution=40)
    target = 200
    cleaned = clean_mesh(sphere, target_triangles=target)

    # Quadric decimation lands near the budget, never far above it.
    assert len(cleaned.triangles) <= target * 1.2


def test_srgb_to_linear_u8_matches_the_spec() -> None:
    np = pytest.importorskip("numpy")
    from monocle_sidecar.fusion.export import _srgb_to_linear_u8

    out = _srgb_to_linear_u8(np.array([[0, 0, 0], [255, 255, 255], [188, 188, 188]], dtype=np.uint8))
    assert out[0].tolist() == [0, 0, 0]
    assert out[1].tolist() == [255, 255, 255]
    # sRGB 188 is ~0.737, which maps to ~0.5 linear, i.e. ~128 back in uint8.
    assert 120 <= int(out[2][0]) <= 136
