import type { Mesh } from '@monoclejs/core'
import { getVertex, num, triangles } from './geometry'

/**
 * Encode a mesh as Wavefront OBJ. Indices are 1-based per the format. Vertex
 * normals are written when present and referenced as `v//vn`.
 */
export function objAscii(mesh: Mesh, options: { name?: string } = {}): string {
  const lines: string[] = [`# ${options.name ?? 'monocle'} mesh`]
  const vertexCount = Math.floor(mesh.positions.length / 3)

  for (let i = 0; i < vertexCount; i++) {
    const [x, y, z] = getVertex(mesh.positions, i)
    lines.push(`v ${num(x)} ${num(y)} ${num(z)}`)
  }
  if (mesh.normals) {
    for (let i = 0; i < vertexCount; i++) {
      const [x, y, z] = getVertex(mesh.normals, i)
      lines.push(`vn ${num(x)} ${num(y)} ${num(z)}`)
    }
  }
  for (const [a, b, c] of triangles(mesh)) {
    if (mesh.normals) {
      lines.push(`f ${a + 1}//${a + 1} ${b + 1}//${b + 1} ${c + 1}//${c + 1}`)
    } else {
      lines.push(`f ${a + 1} ${b + 1} ${c + 1}`)
    }
  }
  return lines.join('\n') + '\n'
}
