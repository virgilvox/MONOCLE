import { describe, expect, it } from 'vitest'
import { recommendedDefault, type MachineProfile } from './capability'
import { engineLabel, resolveScanBackend } from './scanEngine'

// The preset cards and the capture store both call resolveScanBackend, so these
// tests pin the one rule that decides which engine actually runs.

describe('resolveScanBackend', () => {
  it('lets the machine recommendation stand in for an adaptive preset backend', () => {
    expect(resolveScanBackend('depth-anything-v2-walk', null, 'depth-anything-3')).toBe(
      'depth-anything-3',
    )
    expect(resolveScanBackend('depth-anything-3', null, 'depth-anything-v2-walk')).toBe(
      'depth-anything-v2-walk',
    )
  })

  it('keeps a purpose-pinned preset backend regardless of the recommendation', () => {
    expect(resolveScanBackend('depth-anything-v2-small', null, 'depth-anything-3')).toBe(
      'depth-anything-v2-small',
    )
    expect(resolveScanBackend('synthetic', null, 'depth-anything-3')).toBe('synthetic')
  })

  it('falls back to the preset backend when there is no recommendation yet', () => {
    expect(resolveScanBackend('depth-anything-v2-walk', null, null)).toBe('depth-anything-v2-walk')
  })

  it('lets an explicit Advanced pin win over everything', () => {
    expect(
      resolveScanBackend('depth-anything-v2-walk', 'depth-anything-3', 'depth-anything-v2-walk'),
    ).toBe('depth-anything-3')
    expect(resolveScanBackend('depth-anything-v2-small', 'synthetic', 'depth-anything-3')).toBe(
      'synthetic',
    )
  })

  it('resolves the walk-around when DA3 is not installed, via the recommendation', () => {
    // The store's recommendedBackend is recommendedDefault(profile, da3Available),
    // so the DA3 install state reaches the cards through this composition.
    const gpuBox: MachineProfile = {
      torchDevice: 'cuda',
      webgpu: true,
      webgl2: true,
      crossOriginIsolated: false,
    }
    const withoutDa3 = recommendedDefault(gpuBox, false)
    expect(resolveScanBackend('depth-anything-v2-walk', null, withoutDa3)).toBe(
      'depth-anything-v2-walk',
    )
    const withDa3 = recommendedDefault(gpuBox, true)
    expect(resolveScanBackend('depth-anything-v2-walk', null, withDa3)).toBe('depth-anything-3')
  })
})

describe('engineLabel', () => {
  it('names every engine a preset can resolve to', () => {
    expect(engineLabel('depth-anything-3')).toBe('Depth Anything 3')
    expect(engineLabel('depth-anything-v2-walk')).toBe('Walk-around (Depth Anything V2)')
    expect(engineLabel('depth-anything-v2-small')).toBe('Depth Anything V2 (single frame)')
    expect(engineLabel('synthetic')).toBe('Synthetic test mesh')
  })

  it('falls back to the id for an unknown backend', () => {
    expect(engineLabel('some-future-engine')).toBe('some-future-engine')
  })
})
