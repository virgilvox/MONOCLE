"""Wavefront OBJ writer with per-vertex color.

OBJ carries geometry natively but has no standard field for per-vertex color.
The widely-read extension `v x y z r g b` (r, g, b as 0..1 floats appended to the
position line) is what MeshLab and Blender read, so that is what we emit when
colors are given. This is per-vertex color, not a UV texture: we have no texture
coordinates, so the mesh paints from vertex data and there is no image map. A
sibling minimal `.mtl` is written and referenced with `mtllib`/`usemtl` purely so
DCC tools that expect a material library open the file without warnings.

Pure standard-library string writing, no heavy dependencies.
"""

from __future__ import annotations

from pathlib import Path

from ..geometry_io import Vec3


def write_obj(
    path: str | Path,
    verts: list[Vec3],
    tris: list[tuple[int, int, int]],
    cols: list[tuple[int, int, int]] | None = None,
) -> bool:
    """Write an indexed mesh as Wavefront OBJ with an accompanying MTL.

    Args:
        path: destination `.obj` path. The `.mtl` is written beside it with the
            same stem.
        verts: list of (x, y, z) float vertex positions.
        tris: list of (a, b, c) int vertex indices, zero-based. Written as OBJ
            `f` lines with the 1-based indices the format requires.
        cols: optional list of (r, g, b) uint8 per-vertex colors. When given,
            each vertex line gains the `r g b` 0..1 float extension read by
            MeshLab and Blender. This is per-vertex color, not a UV texture.

    Returns:
        True once both files are written.
    """
    obj_path = Path(path)
    mtl_path = obj_path.with_suffix(".mtl")

    _write_mtl(mtl_path)

    lines: list[str] = [
        "# MONOCLE OBJ export",
        "# Per-vertex color uses the 'v x y z r g b' extension (r,g,b in 0..1).",
        "# There are no UVs: color is per vertex, not a texture map.",
        f"mtllib {mtl_path.name}",
        "usemtl monocle",
    ]

    if cols is not None:
        for (x, y, z), (r, g, b) in zip(verts, cols):
            lines.append(
                f"v {_f(x)} {_f(y)} {_f(z)} "
                f"{_f(r / 255.0)} {_f(g / 255.0)} {_f(b / 255.0)}"
            )
    else:
        for x, y, z in verts:
            lines.append(f"v {_f(x)} {_f(y)} {_f(z)}")

    for a, b, c in tris:
        # OBJ faces are 1-indexed.
        lines.append(f"f {a + 1} {b + 1} {c + 1}")

    obj_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return True


def _write_mtl(path: Path) -> None:
    """Write a minimal neutral material so DCC tools find the referenced library."""
    lines = [
        "# MONOCLE material library",
        "newmtl monocle",
        "Ka 1 1 1",
        "Kd 1 1 1",
        "Ks 0 0 0",
        "d 1",
        "illum 1",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _f(value: float) -> str:
    """Format a float without an exponent and without trailing-zero noise."""
    return f"{float(value):.6f}".rstrip("0").rstrip(".")
