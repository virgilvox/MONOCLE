import { describe, expect, it } from 'vitest'
import { fromRotationTranslation, identity, invert, multiply, transformPoint } from './mat4'

describe('mat4', () => {
  it('multiplying by identity returns the original', () => {
    const m = fromRotationTranslation([0, -1, 0, 1, 0, 0, 0, 0, 1], [3, 4, 5])
    const product = multiply(m, identity())
    expect([...product]).toEqual([...m])
  })

  it('transformPoint applies rotation and translation', () => {
    // 90 degree rotation about z, then translate by (1, 2, 3).
    const m = fromRotationTranslation([0, -1, 0, 1, 0, 0, 0, 0, 1], [1, 2, 3])
    const [x, y, z] = transformPoint(m, 1, 0, 0)
    expect(x).toBeCloseTo(1, 6)
    expect(y).toBeCloseTo(3, 6)
    expect(z).toBeCloseTo(3, 6)
  })

  it('invert undoes a rigid transform', () => {
    const m = fromRotationTranslation([0, -1, 0, 1, 0, 0, 0, 0, 1], [7, -2, 4])
    const inv = invert(m)
    expect(inv).not.toBeNull()
    const back = multiply(inv!, m)
    const id = identity()
    for (let i = 0; i < 16; i++) {
      expect(back[i]).toBeCloseTo(id[i]!, 5)
    }
  })

  it('invert returns null for a singular matrix', () => {
    const singular = new Float32Array(16) // all zeros
    expect(invert(singular)).toBeNull()
  })
})
