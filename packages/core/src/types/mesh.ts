/**
 * Geometry containers shared by the fusion, meshing, and export stages. Kept in
 * core so serializers (mesh-io) and producers (fusion backends) agree on one
 * representation without a circular dependency.
 */

/** An indexed triangle mesh. Positions are packed xyz triples. */
export interface Mesh {
  /** Vertex positions, length is a multiple of 3. */
  positions: Float32Array
  /**
   * Triangle indices into positions. When absent, the triangle-only writers
   * (STL, OBJ) treat the positions as a flat soup, three vertices per face.
   * PLY, which also represents point clouds, only writes faces for an indexed
   * mesh, so index a mesh before writing PLY (or pass a `PointCloud` for points).
   */
  indices?: Uint32Array
  /** Per-vertex normals, packed xyz, same vertex count as positions. */
  normals?: Float32Array
  /** Per-vertex colors, packed rgb bytes 0-255, same vertex count as positions. */
  colors?: Uint8Array
}

/** An unstructured point cloud, the intermediate product of the geometry stage. */
export interface PointCloud {
  positions: Float32Array
  normals?: Float32Array
  colors?: Uint8Array
}

/** Number of whole vertices in a mesh or point cloud. */
export function vertexCount(geometry: Mesh | PointCloud): number {
  return Math.floor(geometry.positions.length / 3)
}

/** Number of whole triangles from the index buffer, or zero when unindexed. */
export function triangleCount(mesh: Mesh): number {
  if (mesh.indices) return Math.floor(mesh.indices.length / 3)
  return 0
}
