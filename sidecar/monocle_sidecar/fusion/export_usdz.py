"""USDZ writer built without pxr/usd-core.

A USDZ is an uncompressed ZIP archive whose first entry is the default USD layer.
The `pxr`/`usd-core` package is not available here, so we hand-write a minimal
valid ASCII USD (`.usda`) describing a `UsdGeomMesh` and pack it with `zipfile`
using `ZIP_STORED` (no compression), which the USDZ spec requires.

USDZ alignment rule: the spec mandates that each file's *data* start on a 64-byte
boundary, achieved by padding the ZIP local file header's extra field. We honor
that for the single `.usda` entry by choosing the archive name and an extra-field
pad so the data begins at offset 64. The padding is written as zero bytes in the
extra field, matching Pixar's `usdzip`; readers use the extra-field length to skip
it, so the archive stays a valid ZIP. See:
https://openusd.org/release/spec_usdz.html

The whole write is best-effort: any failure returns False so the caller simply
omits the USDZ artifact, mirroring the optional 3MF writer.
"""

from __future__ import annotations

import zipfile
from pathlib import Path

from ..geometry_io import Vec3

# USDZ requires file data to be aligned to this many bytes.
_DATA_ALIGNMENT = 64
# Archive name of the default layer. Length is chosen with the fixed 30-byte
# local header so a whole-record extra pad lands the data on a 64-byte boundary.
_LAYER_NAME = "model.usda"
# Fixed size of a ZIP local file header before the file name and extra field.
_LOCAL_HEADER_SIZE = 30


def write_usdz(
    path: str | Path,
    verts: list[Vec3],
    tris: list[tuple[int, int, int]],
    cols: list[tuple[int, int, int]] | None = None,
) -> bool:
    """Write an indexed mesh as a USDZ archive containing one ASCII USD layer.

    Args:
        path: destination `.usdz` path.
        verts: list of (x, y, z) float vertex positions.
        tris: list of (a, b, c) int vertex indices, zero-based.
        cols: optional list of (r, g, b) uint8 per-vertex colors. When given,
            the mesh carries `primvars:displayColor` with `interpolation = vertex`
            and the colors converted to 0..1 `color3f` values.

    Returns:
        True on success, False on any failure.
    """
    try:
        usda = _build_usda(verts, tris, cols).encode("utf-8")
        info = zipfile.ZipInfo(_LAYER_NAME)
        info.compress_type = zipfile.ZIP_STORED
        info.extra = _alignment_extra(len(_LAYER_NAME))
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr(info, usda)
        return True
    except Exception:
        return False


def _alignment_extra(name_len: int) -> bytes:
    """Return extra-field bytes that push the layer data to a 64-byte boundary."""
    before_extra = _LOCAL_HEADER_SIZE + name_len
    pad = (-before_extra) % _DATA_ALIGNMENT
    # A ZIP extra record needs at least its 4-byte header; if the gap is smaller
    # than that, borrow a full extra alignment block so a valid pad still fits.
    if 0 < pad < 4:
        pad += _DATA_ALIGNMENT
    return b"\x00" * pad


def _build_usda(
    verts: list[Vec3],
    tris: list[tuple[int, int, int]],
    cols: list[tuple[int, int, int]] | None,
) -> str:
    """Compose a minimal valid ASCII USD (.usda) for the mesh.

    The prim is declared `def Mesh`, which is the USDA spelling of the
    UsdGeomMesh schema. Faces are all triangles, so faceVertexCounts is a run of
    3s and faceVertexIndices is the flattened triangle list.
    """
    counts = ", ".join("3" for _ in tris)
    indices = ", ".join(f"{a}, {b}, {c}" for a, b, c in tris)
    points = ", ".join(f"({_f(x)}, {_f(y)}, {_f(z)})" for x, y, z in verts)

    body = [
        "#usda 1.0",
        "(",
        '    defaultPrim = "Mesh"',
        '    upAxis = "Y"',
        "    metersPerUnit = 1",
        ")",
        "",
        "# UsdGeomMesh authored without pxr/usd-core.",
        'def Mesh "Mesh"',
        "{",
        # Without this, UsdGeomMesh defaults to catmullClark, so AR Quick Look and
        # usdview would smooth and shrink a triangulated scan into a subdivision
        # surface. "none" renders it as the authored polygon mesh.
        '    uniform token subdivisionScheme = "none"',
    ]
    extent = _extent(verts)
    if extent is not None:
        body.append(f"    float3[] extent = [{extent}]")
    body += [
        f"    int[] faceVertexCounts = [{counts}]",
        f"    int[] faceVertexIndices = [{indices}]",
        f"    point3f[] points = [{points}]",
    ]

    if cols is not None:
        colors = ", ".join(
            f"({_f(r / 255.0)}, {_f(g / 255.0)}, {_f(b / 255.0)})" for r, g, b in cols
        )
        body += [
            f"    color3f[] primvars:displayColor = [{colors}] (",
            '        interpolation = "vertex"',
            "    )",
        ]

    body += ["}", ""]
    return "\n".join(body)


def _extent(verts: list[Vec3]) -> str | None:
    """The mesh bounding box as a USD extent pair, or None for an empty mesh.

    Authoring extent lets a viewer frame the model without loading every point
    and silences the missing-extent warning from usdchecker / Reality Converter.
    """
    if not verts:
        return None
    xs = [v[0] for v in verts]
    ys = [v[1] for v in verts]
    zs = [v[2] for v in verts]
    lo = f"({_f(min(xs))}, {_f(min(ys))}, {_f(min(zs))})"
    hi = f"({_f(max(xs))}, {_f(max(ys))}, {_f(max(zs))})"
    return f"{lo}, {hi}"


def _f(value: float) -> str:
    """Format a float without an exponent and without trailing-zero noise."""
    return f"{float(value):.6f}".rstrip("0").rstrip(".")
