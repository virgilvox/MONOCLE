import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useCaptureStore } from '../stores/capture'
import { useStageTabs } from './useStageTabs'
import type { ReconstructResult } from '@monoclejs/protocol'

// The auto-jump to the 3D preview must respect a tab the user picked while a
// run was underway, and must come back for the next run. Pure state logic, no
// window.api involved.

const RESULT = { meshPath: '/tmp/scan.stl', vertexCount: 3, triangleCount: 1 } as ReconstructResult

describe('useStageTabs auto-jump guard', () => {
  let scope: EffectScope

  beforeEach(() => {
    setActivePinia(createPinia())
    scope = effectScope()
  })

  afterEach(() => {
    scope.stop()
  })

  function mount() {
    return scope.run(() => useStageTabs(ref(false)))!
  }

  it('jumps to the preview when a result lands and the user did not navigate', async () => {
    const tabs = mount()
    const capture = useCaptureStore()
    capture.reconstructing = true
    await nextTick()
    capture.reconstructing = false
    capture.result = RESULT
    await nextTick()
    expect(tabs.stageView.value).toBe('preview')
  })

  it('stays on a tab the user picked during the run', async () => {
    const tabs = mount()
    const capture = useCaptureStore()
    capture.reconstructing = true
    await nextTick()
    tabs.selectTab('live')
    capture.reconstructing = false
    capture.result = RESULT
    await nextTick()
    expect(tabs.stageView.value).toBe('live')
  })

  it('does not count a pick made while idle', async () => {
    const tabs = mount()
    const capture = useCaptureStore()
    tabs.selectTab('live')
    capture.reconstructing = true
    await nextTick()
    capture.reconstructing = false
    capture.result = RESULT
    await nextTick()
    expect(tabs.stageView.value).toBe('preview')
  })

  it('keeps a pick made during the import phase through the reconstruction', async () => {
    const tabs = mount()
    const capture = useCaptureStore()
    capture.importing = true
    await nextTick()
    tabs.selectTab('live')
    // The store flips importing off and reconstructing on in the same tick.
    capture.importing = false
    capture.reconstructing = true
    await nextTick()
    capture.reconstructing = false
    capture.result = RESULT
    await nextTick()
    expect(tabs.stageView.value).toBe('live')
  })

  it('resets the guard for the next run', async () => {
    const tabs = mount()
    const capture = useCaptureStore()
    capture.reconstructing = true
    await nextTick()
    tabs.selectTab('live')
    capture.reconstructing = false
    capture.result = RESULT
    await nextTick()
    expect(tabs.stageView.value).toBe('live')

    capture.result = null
    capture.reconstructing = true
    await nextTick()
    capture.reconstructing = false
    capture.result = RESULT
    await nextTick()
    expect(tabs.stageView.value).toBe('preview')
  })
})
