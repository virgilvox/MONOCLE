import { describe, expect, it } from 'vitest'
import { coerceOutput } from './outputs'

describe('coerceOutput', () => {
  it('passes rich outputs through only on Depth Anything 3', () => {
    expect(coerceOutput('depth-anything-3', 'pointCloud', 'base')).toBe('pointCloud')
    expect(coerceOutput('depth-anything-3', 'colmap', 'base')).toBe('colmap')
    expect(coerceOutput('depth-anything-3', 'mesh', 'base')).toBe('mesh')
    expect(coerceOutput('depth-anything-v2-walk', 'pointCloud', 'base')).toBe('mesh')
    expect(coerceOutput('synthetic', 'pointCloud', 'base')).toBe('mesh')
  })

  it('gates a Gaussian output on the giant checkpoint', () => {
    expect(coerceOutput('depth-anything-3', 'gaussian', 'base')).toBe('mesh')
    expect(coerceOutput('depth-anything-3', 'gaussian', 'large')).toBe('mesh')
    expect(coerceOutput('depth-anything-3', 'gaussian', 'giant')).toBe('gaussian')
  })
})
