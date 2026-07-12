import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useCaptureStore } from './capture'

// The advanced overrides are the model-flexibility surface: they must layer on
// top of a preset without mutating it, and reset cleanly when the preset
// changes. None of this path touches window.api, so it tests in the node env.

describe('capture store overrides', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('follows the preset until an override is set', () => {
    const store = useCaptureStore()
    expect(store.presetId).toBe('quick-depth')
    expect(store.quality).toBe('balanced')
    expect(store.color).toBe(true)
    expect(store.effectiveBackend).toBe('depth-anything-v2-small')
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
    store.selectPreset('object-scan')
    expect(store.hasOverrides).toBe(false)
    // Now the object-scan defaults apply, not the old overrides.
    expect(store.quality).toBe('high')
    expect(store.color).toBe(true)
  })

  it('resetOverrides restores the preset defaults in place', () => {
    const store = useCaptureStore()
    store.setBackendOverride('synthetic')
    store.setQualityOverride('fast')
    store.resetOverrides()
    expect(store.hasOverrides).toBe(false)
    expect(store.effectiveBackend).toBe('depth-anything-v2-small')
    expect(store.quality).toBe('balanced')
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
