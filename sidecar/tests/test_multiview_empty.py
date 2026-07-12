"""The multi-view backend must not export an empty fused mesh as success.

_is_empty is checked here with a stub that mimics Open3D's TriangleMesh
(a length-able `triangles`), so the guard is covered without importing open3d.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from monocle_sidecar.backends.multiview import _is_empty


@dataclass
class _StubMesh:
    triangles: list = field(default_factory=list)


def test_empty_mesh_is_flagged():
    assert _is_empty(_StubMesh(triangles=[])) is True


def test_non_empty_mesh_is_not_flagged():
    assert _is_empty(_StubMesh(triangles=[(0, 1, 2), (2, 3, 0)])) is False
