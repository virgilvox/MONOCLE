"""Synthetic backend: writes a parametric sphere STL with no ML dependencies.

Its purpose is to exercise the full capture-to-STL pipeline (progress streaming,
cancellation, mesh output, export) before any model is installed, and to give
tests a deterministic reconstruction. It ignores the input frames by design.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from ..geometry_io import write_binary_stl
from .base import Backend, Cancelled, Notify, ShouldCancel

_RINGS = 24
_SECTORS = 48
_RADIUS_M = 0.05  # a 50 mm sphere, in meters to match the project's metric scale

Vec3 = tuple[float, float, float]


class SyntheticBackend(Backend):
    def reconstruct(
        self, params: dict[str, Any], notify: Notify, should_cancel: ShouldCancel
    ) -> dict[str, Any]:
        vertices = self._build_vertices(notify, should_cancel)
        triangles = self._build_triangles(vertices)

        out_dir = Path(params["outputDir"])
        out_dir.mkdir(parents=True, exist_ok=True)
        mesh_path = out_dir / "scan.stl"
        write_binary_stl(mesh_path, triangles)

        notify("progress", {"stage": "mesh", "ratio": 1.0, "message": "wrote synthetic sphere"})
        return {
            "meshPath": str(mesh_path),
            "vertexCount": len(vertices),
            "triangleCount": len(triangles),
        }

    def _build_vertices(self, notify: Notify, should_cancel: ShouldCancel) -> list[Vec3]:
        vertices: list[Vec3] = []
        for i in range(_RINGS + 1):
            if should_cancel():
                raise Cancelled()
            notify("progress", {"stage": "mesh", "ratio": i / (_RINGS + 1), "message": "synthesizing"})
            theta = math.pi * i / _RINGS
            for j in range(_SECTORS + 1):
                phi = 2 * math.pi * j / _SECTORS
                vertices.append(
                    (
                        _RADIUS_M * math.sin(theta) * math.cos(phi),
                        _RADIUS_M * math.cos(theta),
                        _RADIUS_M * math.sin(theta) * math.sin(phi),
                    )
                )
        return vertices

    def _build_triangles(self, vertices: list[Vec3]) -> list[tuple[Vec3, Vec3, Vec3]]:
        stride = _SECTORS + 1
        triangles: list[tuple[Vec3, Vec3, Vec3]] = []
        for i in range(_RINGS):
            for j in range(_SECTORS):
                a = i * stride + j
                b = a + stride
                triangles.append((vertices[a], vertices[a + 1], vertices[b + 1]))
                triangles.append((vertices[a], vertices[b + 1], vertices[b]))
        return triangles
