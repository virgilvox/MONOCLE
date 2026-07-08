import type { Mesh } from '@monoclejs/core'
import { describe, expect, it } from 'vitest'
import { stlAscii, stlBinary } from './stl'

const triangle: Mesh = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
}

describe('stlBinary', () => {
  it('writes a valid header, count, and one triangle', () => {
    const bytes = stlBinary(triangle)
    // 80 header + 4 count + 50 per triangle
    expect(bytes.byteLength).toBe(84 + 50)
    const view = new DataView(bytes.buffer)
    expect(view.getUint32(80, true)).toBe(1)
    // header must not begin with "solid" or parsers treat it as ASCII
    const headerStart = new TextDecoder().decode(bytes.subarray(0, 5))
    expect(headerStart).not.toBe('solid')
  })

  it('encodes the face normal pointing along +z for a ccw triangle', () => {
    const bytes = stlBinary(triangle)
    const view = new DataView(bytes.buffer)
    const nx = view.getFloat32(84, true)
    const ny = view.getFloat32(88, true)
    const nz = view.getFloat32(92, true)
    expect(nx).toBeCloseTo(0, 5)
    expect(ny).toBeCloseTo(0, 5)
    expect(nz).toBeCloseTo(1, 5)
  })
})

describe('stlAscii', () => {
  it('opens and closes with a named solid and one facet', () => {
    const text = stlAscii(triangle, { name: 'cube' })
    expect(text.startsWith('solid cube')).toBe(true)
    expect(text.trimEnd().endsWith('endsolid cube')).toBe(true)
    expect(text.match(/facet normal/g)).toHaveLength(1)
    expect(text.match(/vertex/g)).toHaveLength(3)
  })
})
