import type { Mesh } from '@monoclejs/core'
import { vec3 } from '@monoclejs/core'
import { getVertex, num, triangles } from './geometry'

const HEADER_BYTES = 80
const COUNT_BYTES = 4
const TRIANGLE_BYTES = 50 // 12 floats + a 2-byte attribute count

/**
 * Encode a mesh as binary STL, the default for 3D printing: compact and
 * universally accepted by slicers. The 80-byte header is left zeroed, which is
 * required to start with anything other than the word "solid" so parsers do not
 * mistake it for ASCII STL.
 */
export function stlBinary(mesh: Mesh): Uint8Array {
  const tris = [...triangles(mesh)]
  const buffer = new ArrayBuffer(HEADER_BYTES + COUNT_BYTES + tris.length * TRIANGLE_BYTES)
  const view = new DataView(buffer)
  view.setUint32(HEADER_BYTES, tris.length, true)

  let offset = HEADER_BYTES + COUNT_BYTES
  const put = (x: number, y: number, z: number) => {
    view.setFloat32(offset, x, true)
    view.setFloat32(offset + 4, y, true)
    view.setFloat32(offset + 8, z, true)
    offset += 12
  }

  for (const [a, b, c] of tris) {
    const va = getVertex(mesh.positions, a)
    const vb = getVertex(mesh.positions, b)
    const vc = getVertex(mesh.positions, c)
    const n = vec3.triangleNormal(va, vb, vc)
    put(n[0], n[1], n[2])
    put(...va)
    put(...vb)
    put(...vc)
    view.setUint16(offset, 0, true)
    offset += 2
  }
  return new Uint8Array(buffer)
}

/** Encode a mesh as ASCII STL. Human-readable but larger; prefer binary to ship. */
export function stlAscii(mesh: Mesh, options: { name?: string } = {}): string {
  const name = options.name ?? 'monocle'
  const lines: string[] = [`solid ${name}`]
  for (const [a, b, c] of triangles(mesh)) {
    const va = getVertex(mesh.positions, a)
    const vb = getVertex(mesh.positions, b)
    const vc = getVertex(mesh.positions, c)
    const n = vec3.triangleNormal(va, vb, vc)
    lines.push(`  facet normal ${num(n[0])} ${num(n[1])} ${num(n[2])}`)
    lines.push('    outer loop')
    lines.push(`      vertex ${num(va[0])} ${num(va[1])} ${num(va[2])}`)
    lines.push(`      vertex ${num(vb[0])} ${num(vb[1])} ${num(vb[2])}`)
    lines.push(`      vertex ${num(vc[0])} ${num(vc[1])} ${num(vc[2])}`)
    lines.push('    endloop')
    lines.push('  endfacet')
  }
  lines.push(`endsolid ${name}`)
  return lines.join('\n') + '\n'
}
