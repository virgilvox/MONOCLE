import type { Mesh } from '@monoclejs/core'

/** Read vertex `index` from a packed xyz position array. */
export function getVertex(positions: Float32Array, index: number): [number, number, number] {
  const o = index * 3
  return [positions[o] ?? 0, positions[o + 1] ?? 0, positions[o + 2] ?? 0]
}

/**
 * Yield the vertex-index triples of a mesh. When the mesh has no index buffer
 * the positions are treated as a flat triangle soup (three vertices per face).
 */
export function* triangles(mesh: Mesh): Generator<[number, number, number]> {
  const { indices, positions } = mesh
  if (indices) {
    for (let k = 0; k + 2 < indices.length; k += 3) {
      yield [indices[k]!, indices[k + 1]!, indices[k + 2]!]
    }
  } else {
    const count = Math.floor(positions.length / 3)
    for (let i = 0; i + 2 < count; i += 3) {
      yield [i, i + 1, i + 2]
    }
  }
}

/** Number of whole triangles a mesh serializes to, indexed or as a soup. */
export function faceCount(mesh: Mesh): number {
  if (mesh.indices) return Math.floor(mesh.indices.length / 3)
  return Math.floor(mesh.positions.length / 3 / 3)
}

/** Format a finite number for a text format, falling back to 0 for NaN/Infinity. */
export function num(value: number): string {
  return Number.isFinite(value) ? String(value) : '0'
}
