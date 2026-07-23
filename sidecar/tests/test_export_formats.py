"""Tests for the standalone OBJ and USDZ export writers.

Both writers are dependency-free (standard library only), so these tests build a
tiny colored mesh by hand and assert on the bytes produced. A mid-gray color
channel (128) is used so the per-vertex color clearly serializes as a float.
"""

from __future__ import annotations

import logging
import zipfile
from pathlib import Path

from monocle_sidecar.fusion.export_obj import write_obj
from monocle_sidecar.fusion.export_usdz import write_usdz

# A quad (two triangles). Vertex 3 is mid-gray so a color float is unambiguous.
_VERTS = [
    (0.0, 0.0, 0.0),
    (1.0, 0.0, 0.0),
    (1.0, 1.0, 0.0),
    (0.0, 1.0, 0.0),
]
_TRIS = [(0, 1, 2), (0, 2, 3)]
_COLS = [
    (255, 0, 0),
    (0, 255, 0),
    (0, 0, 255),
    (128, 128, 128),
]


def test_write_obj_emits_obj_and_mtl(tmp_path: Path) -> None:
    obj = tmp_path / "scan.obj"
    assert write_obj(obj, _VERTS, _TRIS, _COLS) is True

    mtl = tmp_path / "scan.mtl"
    assert obj.exists()
    assert mtl.exists()

    text = obj.read_text(encoding="utf-8")
    lines = text.splitlines()

    # References the sibling material library.
    assert "mtllib scan.mtl" in lines
    assert any(line.startswith("usemtl ") for line in lines)

    # Six colored vertex lines (x y z r g b) and two face lines.
    v_lines = [ln for ln in lines if ln.startswith("v ")]
    f_lines = [ln for ln in lines if ln.startswith("f ")]
    assert len(v_lines) == 4
    assert len(f_lines) == 2

    # Per-vertex color extension: position line has six numbers.
    for ln in v_lines:
        assert len(ln.split()) == 7  # "v" + x y z r g b

    # The mid-gray channel serializes as a 0..1 float, not an integer.
    assert "0.501961" in text

    # Faces are 1-indexed: triangle (0,1,2) becomes "f 1 2 3".
    assert "f 1 2 3" in f_lines
    assert "f 1 3 4" in f_lines

    # The .mtl defines the referenced material.
    assert "newmtl monocle" in mtl.read_text(encoding="utf-8")


def test_write_obj_without_color_omits_color_channels(tmp_path: Path) -> None:
    obj = tmp_path / "plain.obj"
    assert write_obj(obj, _VERTS, _TRIS) is True

    v_lines = [ln for ln in obj.read_text(encoding="utf-8").splitlines() if ln.startswith("v ")]
    assert v_lines
    for ln in v_lines:
        assert len(ln.split()) == 4  # "v" + x y z only


def test_write_usdz_is_a_stored_zip_with_one_usda(tmp_path: Path) -> None:
    usdz = tmp_path / "scan.usdz"
    assert write_usdz(usdz, _VERTS, _TRIS, _COLS) is True

    assert zipfile.is_zipfile(usdz)

    with zipfile.ZipFile(usdz) as archive:
        names = archive.namelist()
        assert len(names) == 1
        assert names[0].endswith(".usda")

        info = archive.getinfo(names[0])
        # USDZ requires no compression.
        assert info.compress_type == zipfile.ZIP_STORED

        text = archive.read(names[0]).decode("utf-8")

    assert "UsdGeomMesh" in text
    assert "def Mesh" in text
    assert "point3f[] points" in text
    assert "int[] faceVertexCounts = [3, 3]" in text
    assert 'primvars:displayColor' in text
    assert 'interpolation = "vertex"' in text
    # Without subdivisionScheme="none", AR Quick Look would render the triangle
    # scan as a smoothed Catmull-Clark subdivision surface.
    assert 'uniform token subdivisionScheme = "none"' in text
    assert "float3[] extent" in text


def test_write_usdz_aligns_layer_data_to_64_bytes(tmp_path: Path) -> None:
    usdz = tmp_path / "aligned.usdz"
    assert write_usdz(usdz, _VERTS, _TRIS, _COLS) is True

    # Parse the ZIP local file header to find where the layer data begins and
    # confirm the USDZ 64-byte alignment.
    data = usdz.read_bytes()
    assert data[:4] == b"PK\x03\x04"
    name_len = int.from_bytes(data[26:28], "little")
    extra_len = int.from_bytes(data[28:30], "little")
    data_offset = 30 + name_len + extra_len
    assert data_offset % 64 == 0


def test_write_usdz_without_color_omits_display_color(tmp_path: Path) -> None:
    usdz = tmp_path / "plain.usdz"
    assert write_usdz(usdz, _VERTS, _TRIS) is True

    with zipfile.ZipFile(usdz) as archive:
        text = archive.read(archive.namelist()[0]).decode("utf-8")

    assert "primvars:displayColor" not in text
    assert "point3f[] points" in text


def test_write_usdz_failure_is_logged_not_silent(tmp_path: Path, caplog) -> None:
    # A failed artifact must leave a trace in the log; a parent directory that
    # does not exist makes the ZIP open fail deterministically.
    bad = tmp_path / "missing" / "scan.usdz"
    with caplog.at_level(logging.WARNING, logger="monocle_sidecar.fusion.export_usdz"):
        assert write_usdz(bad, _VERTS, _TRIS, _COLS) is False

    assert any("scan.usdz" in record.getMessage() for record in caplog.records)
