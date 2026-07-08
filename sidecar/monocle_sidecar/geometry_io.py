"""Dependency-free geometry writers shared by backends.

Binary STL and ASCII PLY, using only the standard library so a backend can emit
a mesh or point cloud without pulling numpy or Open3D.
"""

from __future__ import annotations

import math
import struct
from pathlib import Path

Vec3 = tuple[float, float, float]


def write_binary_stl(path: str | Path, triangles: list[tuple[Vec3, Vec3, Vec3]]) -> None:
    """Write triangles as binary STL. The 80-byte header is zeroed, which is
    required to start with anything other than the word "solid"."""
    with Path(path).open("wb") as file:
        file.write(b"\x00" * 80)
        file.write(struct.pack("<I", len(triangles)))
        for a, b, c in triangles:
            nx, ny, nz = triangle_normal(a, b, c)
            file.write(struct.pack("<12fH", nx, ny, nz, *a, *b, *c, 0))


def write_ascii_ply(
    path: str | Path,
    points: list[Vec3],
    colors: list[tuple[int, int, int]] | None = None,
) -> None:
    """Write a point cloud as ASCII PLY, with optional per-point RGB."""
    lines = [
        "ply",
        "format ascii 1.0",
        f"element vertex {len(points)}",
        "property float x",
        "property float y",
        "property float z",
    ]
    if colors is not None:
        lines += ["property uchar red", "property uchar green", "property uchar blue"]
    lines.append("end_header")
    for i, (x, y, z) in enumerate(points):
        if colors is not None:
            r, g, b = colors[i]
            lines.append(f"{x} {y} {z} {r} {g} {b}")
        else:
            lines.append(f"{x} {y} {z}")
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


def triangle_normal(a: Vec3, b: Vec3, c: Vec3) -> Vec3:
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    length = math.sqrt(nx * nx + ny * ny + nz * nz)
    if length == 0:
        return (0.0, 0.0, 0.0)
    return (nx / length, ny / length, nz / length)
