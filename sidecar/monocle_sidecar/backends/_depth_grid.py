"""Back-projection and grid triangulation for single-view depth meshes.

Given a metric depth map and pinhole intrinsics, these helpers turn a depth
image into a triangle mesh: back-project every pixel to a camera-space point,
then stitch two triangles per pixel quad. Quads that straddle a depth
discontinuity (a silhouette edge) are dropped so the mesh does not grow the
rubber-sheet triangles that otherwise connect foreground to background.

numpy is imported at module load, so the caller must guard the import of this
module behind the same 'depth' extra check the backend uses for onnxruntime.
"""

from __future__ import annotations

import numpy as np

Vec3 = tuple[float, float, float]


def backproject(depth: np.ndarray, fx: float, fy: float, cx: float, cy: float) -> np.ndarray:
    """Back-project a metric depth map to camera-space points.

    Returns an (H, W, 3) float array. The camera looks down +z, x points right
    and y points up (image rows run top to bottom, so the row term is negated).
    Pixels with depth 0 are left at the origin; callers gate on the depth map,
    not on these coordinates.
    """
    height, width = depth.shape
    us = np.arange(width, dtype=np.float64)
    vs = np.arange(height, dtype=np.float64)
    grid_u, grid_v = np.meshgrid(us, vs)

    z = depth.astype(np.float64)
    x = (grid_u - cx) / fx * z
    y = -(grid_v - cy) / fy * z
    return np.stack((x, y, z), axis=-1)


def quad_keep_mask(depth: np.ndarray, edge_threshold: float) -> np.ndarray:
    """Boolean (H-1, W-1) mask of quads that become triangles.

    A quad (indexed by its top-left pixel) is kept only when all four corners
    carry valid (non-zero) depth and no edge or the shared diagonal spans a depth
    jump larger than ``edge_threshold`` meters. Dropping the jumpy quads is what
    removes flying-pixel rubber sheets stretched between foreground and
    background across a silhouette.
    """
    top_left = depth[:-1, :-1]
    top_right = depth[:-1, 1:]
    bottom_left = depth[1:, :-1]
    bottom_right = depth[1:, 1:]

    valid = (top_left > 0) & (top_right > 0) & (bottom_left > 0) & (bottom_right > 0)

    # Largest depth gap across the quad's four sides and its shared diagonal.
    spans = np.stack(
        (
            np.abs(top_left - top_right),
            np.abs(top_left - bottom_left),
            np.abs(top_right - bottom_right),
            np.abs(bottom_left - bottom_right),
            np.abs(top_left - bottom_right),
        )
    )
    connected = spans.max(axis=0) <= edge_threshold
    return valid & connected


def build_grid_mesh(
    points: np.ndarray,
    depth: np.ndarray,
    edge_threshold: float,
) -> list[tuple[Vec3, Vec3, Vec3]]:
    """Stitch two triangles per kept pixel quad, as a flat triangle soup.

    Winding is counter-clockwise when viewed from the camera so outward normals
    face the viewer. See ``quad_keep_mask`` for the keep rule.
    """
    height, width = depth.shape
    if height < 2 or width < 2:
        return []

    keep = quad_keep_mask(depth, edge_threshold)
    rows, cols = np.nonzero(keep)

    triangles: list[tuple[Vec3, Vec3, Vec3]] = []
    for i, j in zip(rows.tolist(), cols.tolist()):
        a = _vec(points[i, j])
        b = _vec(points[i, j + 1])
        c = _vec(points[i + 1, j + 1])
        d = _vec(points[i + 1, j])
        # Two triangles per quad, counter-clockwise from the camera.
        triangles.append((a, d, c))
        triangles.append((a, c, b))
    return triangles


def build_indexed_grid_mesh(
    points: np.ndarray,
    depth: np.ndarray,
    edge_threshold: float,
    colors: np.ndarray | None = None,
) -> tuple[list[Vec3], list[tuple[int, int, int]], list[tuple[int, int, int]] | None]:
    """Build an indexed mesh (vertices, faces, optional per-vertex colors).

    Same keep rule as ``build_grid_mesh``, but every referenced pixel becomes one
    shared vertex and faces store indices into it. Only pixels used by a kept quad
    are emitted, so the vertex list has no dangling points. When ``colors`` (an
    (H, W, 3) uint8 array aligned to ``depth``) is given, each vertex gets the RGB
    of its source pixel.

    Returning indexed geometry is what lets the exporters attach per-vertex color
    (GLB, colored PLY, 3MF); the flat soup form cannot carry it.
    """
    height, width = depth.shape
    verts: list[Vec3] = []
    faces: list[tuple[int, int, int]] = []
    vertex_colors: list[tuple[int, int, int]] | None = [] if colors is not None else None
    if height < 2 or width < 2:
        return verts, faces, vertex_colors

    keep = quad_keep_mask(depth, edge_threshold)
    rows, cols = np.nonzero(keep)

    index_of: dict[int, int] = {}

    def vertex_id(i: int, j: int) -> int:
        key = i * width + j
        idx = index_of.get(key)
        if idx is None:
            idx = len(verts)
            index_of[key] = idx
            verts.append(_vec(points[i, j]))
            if vertex_colors is not None:
                c = colors[i, j]
                vertex_colors.append((int(c[0]), int(c[1]), int(c[2])))
        return idx

    for i, j in zip(rows.tolist(), cols.tolist()):
        a = vertex_id(i, j)
        b = vertex_id(i, j + 1)
        c = vertex_id(i + 1, j + 1)
        d = vertex_id(i + 1, j)
        # Two triangles per quad, counter-clockwise from the camera.
        faces.append((a, d, c))
        faces.append((a, c, b))
    return verts, faces, vertex_colors


def _vec(point: np.ndarray) -> Vec3:
    return (float(point[0]), float(point[1]), float(point[2]))
