import type { Mesh, PointCloud } from '@monoclejs/core'
import { describe, expect, it } from 'vitest'
import { plyAscii, plyBinary } from './ply'

const cloud: PointCloud = {
  positions: new Float32Array([0, 0, 0, 1, 2, 3]),
  colors: new Uint8Array([255, 0, 0, 0, 255, 0]),
}

const triangle: Mesh = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
}

describe('plyAscii', () => {
  it('emits a vertex-only header for a point cloud with colors', () => {
    const text = plyAscii(cloud, { comment: 'monocle capture' })
    expect(text).toContain('element vertex 2')
    expect(text).toContain('property uchar red')
    expect(text).toContain('comment monocle capture')
    expect(text).not.toContain('element face')
    expect(text).toContain('1 2 3 0 255 0')
  })

  it('emits face records for a mesh', () => {
    const text = plyAscii(triangle)
    expect(text).toContain('element face 1')
    expect(text).toContain('property list uchar uint vertex_indices')
    expect(text.trimEnd().endsWith('3 0 1 2')).toBe(true)
  })
})

describe('plyBinary', () => {
  it('prefixes an ascii header before the little-endian body', () => {
    const bytes = plyBinary(cloud)
    const headerEnd =
      new TextDecoder().decode(bytes).indexOf('end_header\n') + 'end_header\n'.length
    const view = new DataView(bytes.buffer, bytes.byteOffset + headerEnd)
    // first vertex position is (0,0,0), second starts after 12 pos + 3 color bytes
    expect(view.getFloat32(0, true)).toBe(0)
    expect(view.getFloat32(15 + 0, true)).toBe(1)
    expect(view.getFloat32(15 + 4, true)).toBe(2)
    expect(view.getFloat32(15 + 8, true)).toBe(3)
  })
})
