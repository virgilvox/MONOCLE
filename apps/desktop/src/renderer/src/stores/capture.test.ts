import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { coerceOutput, useCaptureStore } from './capture'

// The advanced overrides are the model-flexibility surface: they must layer on
// top of a preset without mutating it, and reset cleanly when the preset
// changes. None of this path touches window.api, so it tests in the node env.

describe('capture store overrides', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('follows the preset until an override is set', () => {
    const store = useCaptureStore()
    expect(store.presetId).toBe('object-scan')
    expect(store.quality).toBe('balanced')
    expect(store.color).toBe(true)
    expect(store.effectiveBackend).toBe('depth-anything-v2-walk')
    expect(store.hasOverrides).toBe(false)
  })

  it('pins quality, color, and backend when overridden', () => {
    const store = useCaptureStore()
    store.setQualityOverride('high')
    store.setColorOverride(false)
    store.setBackendOverride('synthetic')
    expect(store.quality).toBe('high')
    expect(store.color).toBe(false)
    expect(store.effectiveBackend).toBe('synthetic')
    expect(store.hasOverrides).toBe(true)
  })

  it('clears an override set back to the preset default', () => {
    const store = useCaptureStore()
    store.setQualityOverride('high')
    store.setQualityOverride(null)
    expect(store.hasOverrides).toBe(false)
    expect(store.quality).toBe('balanced')
  })

  it('resets every override when the preset changes', () => {
    const store = useCaptureStore()
    store.setQualityOverride('fast')
    store.setColorOverride(false)
    store.selectPreset('quick-depth')
    expect(store.hasOverrides).toBe(false)
    // Now the quick-depth defaults apply, not the old overrides.
    expect(store.quality).toBe('balanced')
    expect(store.color).toBe(true)
  })

  it('resetOverrides restores the preset defaults in place', () => {
    const store = useCaptureStore()
    store.setBackendOverride('synthetic')
    store.setQualityOverride('fast')
    store.resetOverrides()
    expect(store.hasOverrides).toBe(false)
    expect(store.effectiveBackend).toBe('depth-anything-v2-walk')
    expect(store.quality).toBe('balanced')
  })

  it('exposes a DA3 checkpoint only when Depth Anything 3 is selected', () => {
    const store = useCaptureStore()
    // The default object-scan uses the DA2 walk backend, so no checkpoint applies.
    expect(store.usesCheckpoint).toBe(false)
    expect(store.effectiveCheckpoint).toBe('base')

    store.setBackendOverride('depth-anything-3')
    expect(store.usesCheckpoint).toBe(true)
    store.setCheckpointOverride('large')
    expect(store.effectiveCheckpoint).toBe('large')
    expect(store.hasOverrides).toBe(true)

    store.resetOverrides()
    expect(store.usesCheckpoint).toBe(false)
    expect(store.effectiveCheckpoint).toBe('base')
  })

  it('does not reset overrides while a scan is running', () => {
    const store = useCaptureStore()
    store.setQualityOverride('fast')
    store.setColorOverride(false)
    store.scanning = true
    store.resetOverrides()
    // The settings the capture is running against must not change mid-scan.
    expect(store.hasOverrides).toBe(true)
    expect(store.quality).toBe('fast')
    store.scanning = false
    store.resetOverrides()
    expect(store.hasOverrides).toBe(false)
  })
})

// The adaptive default lets the simple UI pick a good method from the machine
// profile without the user choosing a model. It stands in for the preset's own
// backend, and an explicit override still wins over it.
describe('adaptive default backend', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('follows the recommendation when there is no override', () => {
    const store = useCaptureStore()
    expect(store.effectiveBackend).toBe('depth-anything-v2-walk')
    store.setRecommendedBackend('depth-anything-3')
    expect(store.effectiveBackend).toBe('depth-anything-3')
    expect(store.hasOverrides).toBe(false)
  })

  it('lets an explicit backend override win over the recommendation', () => {
    const store = useCaptureStore()
    store.setRecommendedBackend('depth-anything-3')
    store.setBackendOverride('depth-anything-v2-small')
    expect(store.effectiveBackend).toBe('depth-anything-v2-small')
    expect(store.hasOverrides).toBe(true)
    store.setBackendOverride(null)
    expect(store.effectiveBackend).toBe('depth-anything-3')
  })

  it('exposes the recommendation as the picker default', () => {
    const store = useCaptureStore()
    store.setRecommendedBackend('depth-anything-3')
    expect(store.defaultBackend).toBe('depth-anything-3')
  })
})

// Device, output, and pose are standalone settings sent to the sidecar. runReconstruction
// reads device.value and effectiveOutput.value, so asserting those covers what it sends.
describe('device and output settings', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('defaults to auto device and mesh output', () => {
    const store = useCaptureStore()
    expect(store.device).toBe('auto')
    expect(store.output).toBe('mesh')
    expect(store.effectiveOutput).toBe('mesh')
  })

  it('pins the compute device', () => {
    const store = useCaptureStore()
    store.setDevice('cuda')
    expect(store.device).toBe('cuda')
  })

  it('only sends a rich output when Depth Anything 3 is selected', () => {
    const store = useCaptureStore()
    store.setOutput('gaussian')
    // The default walk backend cannot emit a splat, so it coerces to mesh.
    expect(store.supportsRichOutput).toBe(false)
    expect(store.effectiveOutput).toBe('mesh')

    store.setBackendOverride('depth-anything-3')
    expect(store.supportsRichOutput).toBe(true)
    expect(store.effectiveOutput).toBe('gaussian')
  })

  it('keeps device and output across a preset change', () => {
    const store = useCaptureStore()
    store.setDevice('mps')
    store.setOutput('pointCloud')
    store.selectPreset('quick-depth')
    // These are user intent, not preset-scoped, so they persist.
    expect(store.device).toBe('mps')
    expect(store.output).toBe('pointCloud')
  })

  it('tracks the pose estimator', () => {
    const store = useCaptureStore()
    expect(store.poseEstimator).toBe('auto')
    store.setPoseEstimator('sequential')
    expect(store.poseEstimator).toBe('sequential')
  })
})

describe('coerceOutput', () => {
  it('passes rich outputs through only on Depth Anything 3', () => {
    expect(coerceOutput('depth-anything-3', 'gaussian')).toBe('gaussian')
    expect(coerceOutput('depth-anything-3', 'colmap')).toBe('colmap')
    expect(coerceOutput('depth-anything-3', 'mesh')).toBe('mesh')
    expect(coerceOutput('depth-anything-v2-walk', 'gaussian')).toBe('mesh')
    expect(coerceOutput('synthetic', 'pointCloud')).toBe('mesh')
  })
})
