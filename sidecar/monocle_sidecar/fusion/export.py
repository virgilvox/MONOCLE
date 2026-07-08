"""Write a fused mesh to disk in the shape the app expects.

The reconstruct path hands back a ReconstructResult: an STL mesh plus an
optional PLY of the same mesh, with vertex and triangle counts. Open3D owns the
actual file writing here; the stdlib writers in geometry_io are for the
dependency-free backends.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any


def _require_open3d() -> Any:
    """Import Open3D or raise a message pointing at the 'reconstruct' extra."""
    try:
        import open3d as o3d  # noqa: F401
    except ImportError as exc:
        raise RuntimeError(
            "Writing a fused mesh needs Open3D. Install the 'reconstruct' extra: "
            "pip install 'monocle-sidecar[reconstruct]'."
        ) from exc
    return o3d


def write_mesh(
    mesh: Any,
    out_dir: str | Path,
    name: str = "scan",
    also_ply: bool = True,
) -> dict[str, Any]:
    """Write an Open3D TriangleMesh as STL and optionally PLY.

    Args:
        mesh: an open3d.geometry.TriangleMesh, ideally with normals computed.
        out_dir: directory to write into. Created if missing.
        name: base filename without extension.
        also_ply: also write a PLY alongside the STL and report its path.

    Returns:
        A ReconstructResult dict with meshPath, pointCloudPath, vertexCount and
        triangleCount.
    """
    o3d = _require_open3d()

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    # STL needs triangle normals to be well formed; compute them if absent.
    if not mesh.has_triangle_normals():
        mesh.compute_triangle_normals()

    mesh_path = out / f"{name}.stl"
    o3d.io.write_triangle_mesh(str(mesh_path), mesh)

    point_cloud_path: str | None = None
    if also_ply:
        ply_path = out / f"{name}.ply"
        o3d.io.write_triangle_mesh(str(ply_path), mesh)
        point_cloud_path = str(ply_path)

    return {
        "meshPath": str(mesh_path),
        "pointCloudPath": point_cloud_path,
        "vertexCount": len(mesh.vertices),
        "triangleCount": len(mesh.triangles),
    }
