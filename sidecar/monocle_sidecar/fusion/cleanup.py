"""Shared Open3D mesh cleanup, run after any fusion strategy.

Fusion output is rarely export-ready: TSDF leaves degenerate and duplicated
triangles, disconnected specks, and a denser surface than a viewer or slicer
wants. clean_mesh folds the usual repair sequence, largest-component selection,
optional smoothing, and optional decimation into one call so every backend
cleans up the same way.

Open3D is imported lazily so importing this module stays cheap and the missing
dependency surfaces as a clear message naming the 'reconstruct' extra.
"""

from __future__ import annotations

from typing import Any

_RECONSTRUCT_HINT = (
    "Mesh cleanup needs Open3D. Install the 'reconstruct' extra: "
    "pip install 'monocle-sidecar[reconstruct]'."
)


def _require_open3d() -> Any:
    try:
        import open3d as o3d  # noqa: F401
    except ImportError as exc:
        raise RuntimeError(_RECONSTRUCT_HINT) from exc
    return o3d


def clean_mesh(
    mesh: Any,
    keep_largest: bool = True,
    smooth_iterations: int = 0,
    target_triangles: int | None = None,
    fill_holes: bool = False,
) -> Any:
    """Repair, prune, and optionally smooth/decimate an Open3D TriangleMesh.

    Args:
        mesh: an open3d.geometry.TriangleMesh, mutated in place for the repair
            steps and returned (possibly as a new object) after smoothing or
            decimation.
        keep_largest: drop every connected component except the one with the most
            triangles, which removes floating fusion specks.
        smooth_iterations: Taubin smoothing passes; 0 skips smoothing. Taubin is
            used over Laplacian because it does not shrink the surface.
        target_triangles: quadric-decimate down to this triangle budget. Skipped
            when None or when the mesh is already at or under the budget.
        fill_holes: best-effort hole filling via the tensor mesh API; silently
            skipped if unsupported by the installed Open3D.

    Returns:
        The cleaned mesh with vertex normals recomputed.
    """
    o3d = _require_open3d()
    import numpy as np

    # Basic topological repair. These operate in place and are cheap.
    mesh.remove_degenerate_triangles()
    mesh.remove_duplicated_triangles()
    mesh.remove_duplicated_vertices()
    mesh.remove_unreferenced_vertices()
    mesh.remove_non_manifold_edges()

    if keep_largest and len(mesh.triangles) > 0:
        labels, counts, _areas = mesh.cluster_connected_triangles()
        labels = np.asarray(labels)
        counts = np.asarray(counts)
        if counts.size > 1:
            largest = int(counts.argmax())
            mesh.remove_triangles_by_mask(labels != largest)
            mesh.remove_unreferenced_vertices()

    if fill_holes and len(mesh.triangles) > 0:
        try:
            tmesh = o3d.t.geometry.TriangleMesh.from_legacy(mesh)
            mesh = tmesh.fill_holes().to_legacy()
        except Exception:
            # fill_holes is optional polish; a build without it is not an error.
            pass

    if smooth_iterations and smooth_iterations > 0:
        mesh = mesh.filter_smooth_taubin(number_of_iterations=int(smooth_iterations))

    if target_triangles is not None and len(mesh.triangles) > int(target_triangles):
        mesh = mesh.simplify_quadric_decimation(int(target_triangles))

    mesh.compute_vertex_normals()
    return mesh
