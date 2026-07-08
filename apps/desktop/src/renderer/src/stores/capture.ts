import type { ReconstructResult } from '@monoclejs/protocol'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/** The scanning methods the suite offers. Only markerless is wired for the MVP. */
export type ScanMethod = 'markerless' | 'object-sweep' | 'turntable'

export interface ScanMethodInfo {
  id: ScanMethod
  label: string
  description: string
  available: boolean
}

export const SCAN_METHODS: ScanMethodInfo[] = [
  {
    id: 'markerless',
    label: 'Markerless walk-around',
    description: 'Move the webcam through a space or around an object. No markers.',
    available: true,
  },
  {
    id: 'object-sweep',
    label: 'Object sweep',
    description: 'Hold an object and turn it in front of a fixed camera.',
    available: false,
  },
  {
    id: 'turntable',
    label: 'Turntable',
    description: 'Fixed camera, object on a motorized turntable at known angles.',
    available: false,
  },
]

/**
 * Holds the state of the current capture session: chosen method and how many
 * keyframes have been grabbed. Frame processing lives elsewhere; this is the
 * session bookkeeping the UI reads.
 */
export const useCaptureStore = defineStore('capture', () => {
  const method = ref<ScanMethod>('markerless')
  const frameCount = ref(0)
  const scanning = ref(false)

  const reconstructing = ref(false)
  const result = ref<ReconstructResult | null>(null)
  const reconstructError = ref<string | null>(null)

  const canScan = computed(
    () => SCAN_METHODS.find((m) => m.id === method.value)?.available ?? false,
  )

  function selectMethod(next: ScanMethod): void {
    if (scanning.value) return
    method.value = next
  }

  function beginScan(): void {
    frameCount.value = 0
    scanning.value = true
  }

  function endScan(): void {
    scanning.value = false
  }

  function recordFrame(): void {
    frameCount.value += 1
  }

  /** Run a reconstruction on the sidecar with the chosen backend. */
  async function runReconstruction(backend: string): Promise<void> {
    reconstructing.value = true
    reconstructError.value = null
    result.value = null
    try {
      result.value = await window.api.sidecar.reconstruct({ backend })
    } catch (cause) {
      reconstructError.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      reconstructing.value = false
    }
  }

  /** Save the most recent mesh to a user-chosen path. Resolves the path or null. */
  async function exportResult(): Promise<string | null> {
    if (!result.value) return null
    return window.api.exportArtifact({ sourcePath: result.value.meshPath, defaultName: 'scan.stl' })
  }

  return {
    method,
    frameCount,
    scanning,
    reconstructing,
    result,
    reconstructError,
    canScan,
    selectMethod,
    beginScan,
    endScan,
    recordFrame,
    runReconstruction,
    exportResult,
  }
})
