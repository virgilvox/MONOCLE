import type { Mesh } from '@monoclejs/core'
import { describe, expect, it } from 'vitest'
import { objAscii } from './obj'

const triangle: Mesh = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
}

describe('objAscii', () => {
  it('writes 1-based faces and no normal references when normals are absent', () => {
    const text = objAscii(triangle)
    expect(text).toContain('v 0 0 0')
    expect(text).toContain('f 1 2 3')
    expect(text).not.toContain('//')
  })

  it('emits vn and the v//vn face form when normals are present', () => {
    const withNormals: Mesh = {
      ...triangle,
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    }
    const text = objAscii(withNormals)
    expect(text).toContain('vn 0 0 1')
    expect(text).toContain('f 1//1 2//2 3//3')
  })
})
