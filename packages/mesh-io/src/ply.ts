import type { Mesh, PointCloud } from '@monoclejs/core'
import { num, triangles } from './geometry'
// PLY writes faces only for an indexed mesh; an indexless input (a soup Mesh or
// a PointCloud) is written as points. See Mesh.indices in @monoclejs/core.

export interface PlyOptions {
  /** Free-text comment written into the header. */
  comment?: string
}

type Geometry = Mesh | PointCloud

function hasFaces(geometry: Geometry): geometry is Mesh {
  return 'indices' in geometry && (geometry as Mesh).indices !== undefined
}

function buildHeader(
  geometry: Geometry,
  format: 'ascii' | 'binary',
  options: PlyOptions,
): string[] {
  const vertexCount = Math.floor(geometry.positions.length / 3)
  const header = [
    'ply',
    format === 'ascii' ? 'format ascii 1.0' : 'format binary_little_endian 1.0',
  ]
  if (options.comment) header.push(`comment ${options.comment}`)
  header.push(`element vertex ${vertexCount}`)
  header.push('property float x', 'property float y', 'property float z')
  if (geometry.normals) header.push('property float nx', 'property float ny', 'property float nz')
  if (geometry.colors) {
    header.push('property uchar red', 'property uchar green', 'property uchar blue')
  }
  if (hasFaces(geometry)) {
    const faceCount = Math.floor(geometry.indices!.length / 3)
    header.push(`element face ${faceCount}`)
    header.push('property list uchar uint vertex_indices')
  }
  header.push('end_header')
  return header
}

/** Encode a mesh or point cloud as ASCII PLY. */
export function plyAscii(geometry: Geometry, options: PlyOptions = {}): string {
  const { positions, normals, colors } = geometry
  const vertexCount = Math.floor(positions.length / 3)
  const lines = buildHeader(geometry, 'ascii', options)

  for (let i = 0; i < vertexCount; i++) {
    const o = i * 3
    const parts = [num(positions[o]!), num(positions[o + 1]!), num(positions[o + 2]!)]
    if (normals) parts.push(num(normals[o]!), num(normals[o + 1]!), num(normals[o + 2]!))
    if (colors) parts.push(String(colors[o]!), String(colors[o + 1]!), String(colors[o + 2]!))
    lines.push(parts.join(' '))
  }
  if (hasFaces(geometry)) {
    for (const [a, b, c] of triangles(geometry)) {
      lines.push(`3 ${a} ${b} ${c}`)
    }
  }
  return lines.join('\n') + '\n'
}

/** Encode a mesh or point cloud as binary little-endian PLY. */
export function plyBinary(geometry: Geometry, options: PlyOptions = {}): Uint8Array {
  const { positions, normals, colors } = geometry
  const vertexCount = Math.floor(positions.length / 3)
  const header = buildHeader(geometry, 'binary', options).join('\n') + '\n'
  const headerBytes = new TextEncoder().encode(header)

  const perVertex = 12 + (normals ? 12 : 0) + (colors ? 3 : 0)
  const faces = hasFaces(geometry) ? [...triangles(geometry)] : []
  const faceBytes = faces.length * (1 + 12) // count byte + three uint32 indices

  const body = new ArrayBuffer(vertexCount * perVertex + faceBytes)
  const view = new DataView(body)
  let offset = 0

  for (let i = 0; i < vertexCount; i++) {
    const o = i * 3
    view.setFloat32(offset, positions[o]!, true)
    view.setFloat32(offset + 4, positions[o + 1]!, true)
    view.setFloat32(offset + 8, positions[o + 2]!, true)
    offset += 12
    if (normals) {
      view.setFloat32(offset, normals[o]!, true)
      view.setFloat32(offset + 4, normals[o + 1]!, true)
      view.setFloat32(offset + 8, normals[o + 2]!, true)
      offset += 12
    }
    if (colors) {
      view.setUint8(offset, colors[o]!)
      view.setUint8(offset + 1, colors[o + 1]!)
      view.setUint8(offset + 2, colors[o + 2]!)
      offset += 3
    }
  }
  for (const [a, b, c] of faces) {
    view.setUint8(offset, 3)
    view.setUint32(offset + 1, a, true)
    view.setUint32(offset + 5, b, true)
    view.setUint32(offset + 9, c, true)
    offset += 13
  }

  const out = new Uint8Array(headerBytes.length + body.byteLength)
  out.set(headerBytes, 0)
  out.set(new Uint8Array(body), headerBytes.length)
  return out
}
