"""Write a reconstructed mesh to disk in the shape the app expects.

Two entry points:

- write_all(out_dir, name, vertices, triangles, colors): the format matrix. It
  always writes a binary STL and a colored PLY using only geometry_io (no heavy
  deps), then adds a GLB (via trimesh) and a color 3MF (via lib3mf) when those
  optional libraries are present. Missing libraries are skipped, never fatal, so
  the STL + PLY floor is guaranteed. Returns a ReconstructResult dict.
- write_mesh(mesh, out_dir): the Open3D convenience used by the fusion round-trip
  test, writing an existing TriangleMesh straight to STL and PLY.

The GLB is the best 3D-viewer preview when color exists (it carries per-vertex
color); otherwise the STL is the preview.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..geometry_io import Vec3, write_ascii_ply, write_binary_stl


def write_all(
    out_dir: str | Path,
    name: str,
    vertices: Any,
    triangles: Any,
    colors: Any | None = None,
) -> dict[str, Any]:
    """Write STL/PLY (always) plus GLB/3MF (when their libs exist).

    Args:
        out_dir: directory to write into. Created if missing.
        name: base filename without extension.
        vertices: (N, 3) array-like of float vertex positions in meters.
        triangles: (M, 3) array-like of int vertex indices, one row per triangle.
        colors: optional (N, 3) array-like of uint8 per-vertex RGB. When given,
            the PLY carries color, a colored GLB is emitted if trimesh is present,
            and a color 3MF if lib3mf is present.

    Returns:
        A ReconstructResult dict: meshPath (STL), pointCloudPath (PLY),
        vertexCount, triangleCount, hasColor, previewPath, and an artifacts map of
        every file actually written.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    verts = _as_vertex_list(vertices)
    tris = _as_triangle_list(triangles)
    cols = _as_color_list(colors) if colors is not None else None

    artifacts: dict[str, str] = {}

    stl_path = out / f"{name}.stl"
    write_binary_stl(stl_path, _triangle_soup(verts, tris))
    artifacts["stl"] = str(stl_path)

    ply_path = out / f"{name}.ply"
    _write_ply(ply_path, verts, tris, cols)
    artifacts["ply"] = str(ply_path)

    glb_path = out / f"{name}.glb"
    if _write_glb(glb_path, verts, tris, cols):
        artifacts["glb"] = str(glb_path)

    if cols is not None:
        threemf_path = out / f"{name}.3mf"
        if _write_3mf(threemf_path, verts, tris, cols, name):
            artifacts["threeMF"] = str(threemf_path)

    has_color = cols is not None
    preview = artifacts.get("glb") if has_color else None
    preview = preview or artifacts["stl"]

    return {
        "meshPath": str(stl_path),
        "pointCloudPath": str(ply_path),
        "vertexCount": len(verts),
        "triangleCount": len(tris),
        "hasColor": has_color,
        "previewPath": preview,
        "artifacts": artifacts,
    }


def _as_vertex_list(vertices: Any) -> list[Vec3]:
    return [(float(v[0]), float(v[1]), float(v[2])) for v in vertices]


def _as_triangle_list(triangles: Any) -> list[tuple[int, int, int]]:
    return [(int(t[0]), int(t[1]), int(t[2])) for t in triangles]


def _as_color_list(colors: Any) -> list[tuple[int, int, int]]:
    return [(int(c[0]), int(c[1]), int(c[2])) for c in colors]


def _triangle_soup(
    verts: list[Vec3], tris: list[tuple[int, int, int]]
) -> list[tuple[Vec3, Vec3, Vec3]]:
    """Expand an indexed mesh into the flat triangle list write_binary_stl wants."""
    return [(verts[a], verts[b], verts[c]) for a, b, c in tris]


def _try_open3d() -> Any | None:
    """Return the Open3D module, or None when it is not importable."""
    try:
        import open3d as o3d

        return o3d
    except ImportError:
        return None


def _write_ply(
    path: Path,
    verts: list[Vec3],
    tris: list[tuple[int, int, int]],
    cols: list[tuple[int, int, int]] | None,
) -> None:
    """Write the colored PLY.

    With Open3D present, write a proper mesh PLY (faces plus per-vertex color).
    Without it, fall back to the stdlib ASCII writer, which emits the vertices and
    their colors as a point cloud. Either way the file carries the color data.
    """
    o3d = _try_open3d()
    if o3d is not None:
        import numpy as np

        mesh = o3d.geometry.TriangleMesh()
        mesh.vertices = o3d.utility.Vector3dVector(np.asarray(verts, dtype=np.float64))
        mesh.triangles = o3d.utility.Vector3iVector(np.asarray(tris, dtype=np.int32))
        if cols is not None:
            rgb = np.asarray(cols, dtype=np.float64) / 255.0
            mesh.vertex_colors = o3d.utility.Vector3dVector(rgb)
        mesh.compute_vertex_normals()
        o3d.io.write_triangle_mesh(str(path), mesh)
        return

    write_ascii_ply(path, verts, cols)


def _write_glb(
    path: Path,
    verts: list[Vec3],
    tris: list[tuple[int, int, int]],
    cols: list[tuple[int, int, int]] | None,
) -> bool:
    """Write a GLB via trimesh when it is installed. Returns whether it was written."""
    try:
        import trimesh
    except ImportError:
        return False
    import numpy as np

    kwargs: dict[str, Any] = {}
    if cols is not None:
        rgb = np.asarray(cols, dtype=np.uint8).reshape(-1, 3)
        alpha = np.full((len(rgb), 1), 255, dtype=np.uint8)
        kwargs["vertex_colors"] = np.concatenate((rgb, alpha), axis=1)
    mesh = trimesh.Trimesh(
        vertices=np.asarray(verts, dtype=np.float64),
        faces=np.asarray(tris, dtype=np.int64),
        process=False,
        **kwargs,
    )
    mesh.export(str(path))
    return True


def _write_3mf(
    path: Path,
    verts: list[Vec3],
    tris: list[tuple[int, int, int]],
    cols: list[tuple[int, int, int]],
    name: str,
) -> bool:
    """Write a per-vertex color 3MF via lib3mf when installed.

    lib3mf's API is not verified against a pinned version in this environment
    (the package is not installed here), so the whole body is best-effort: any
    failure returns False and the caller simply omits the 3MF artifact.
    """
    try:
        import lib3mf
    except ImportError:
        return False
    try:
        wrapper = lib3mf.get_wrapper()
        model = wrapper.CreateModel()
        mesh_object = model.AddMeshObject()
        mesh_object.SetName(name)

        positions = []
        for x, y, z in verts:
            pos = lib3mf.Position()
            pos.Coordinates[0] = float(x)
            pos.Coordinates[1] = float(y)
            pos.Coordinates[2] = float(z)
            positions.append(pos)

        indexed = []
        for a, b, c in tris:
            tri = lib3mf.Triangle()
            tri.Indices[0] = int(a)
            tri.Indices[1] = int(b)
            tri.Indices[2] = int(c)
            indexed.append(tri)

        mesh_object.SetGeometry(positions, indexed)

        color_group = model.AddColorGroup()
        property_ids = [
            color_group.AddColor(wrapper.RGBAToColor(int(r), int(g), int(b), 255))
            for r, g, b in cols
        ]

        for face_index, (a, b, c) in enumerate(tris):
            props = lib3mf.TriangleProperties()
            props.ResourceID = color_group.GetResourceID()
            props.PropertyIDs[0] = property_ids[a]
            props.PropertyIDs[1] = property_ids[b]
            props.PropertyIDs[2] = property_ids[c]
            mesh_object.SetTriangleProperties(face_index, props)

        model.AddBuildItem(mesh_object, wrapper.GetIdentityTransform())
        writer = model.QueryWriter("3mf")
        writer.WriteToFile(str(path))
        return True
    except Exception:
        return False


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
