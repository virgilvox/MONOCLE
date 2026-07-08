import type { ReconstructResult } from '@monoclejs/protocol'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/** How the app gathers frames before handing them to a backend. */
export type CaptureStrategy = 'single' | 'multi-view' | 'synthetic'

/** Reconstruction quality tier, mapped to sidecar resolution and decimation. */
export type Quality = 'fast' | 'balanced' | 'high'

/** Viewer formats the mesh preview can load. */
export type MeshFormat = 'stl' | 'ply' | 'glb'

/**
 * A benefit-worded scan preset. Each option bundles the capture strategy, the
 * backend, and the export settings so a user picks an outcome, not a model.
 */
export interface ScanPreset {
  id: string
  label: string
  description: string
  captureStrategy: CaptureStrategy
  backend: string
  quality: Quality
  color: boolean
  /** How many good keyframes the HUD aims for. Zero means no capture step. */
  targetFrames: number
}

export const SCAN_PRESETS: ScanPreset[] = [
  {
    id: 'quick-depth',
    label: 'Quick depth snapshot',
    description: 'One sharp frame turns into a depth mesh. Fastest way to a result.',
    captureStrategy: 'single',
    backend: 'depth-anything-v2-small',
    quality: 'balanced',
    color: true,
    targetFrames: 1,
  },
  {
    id: 'object-scan',
    label: 'Object scan (multi-view)',
    description: 'Walk the camera around an object. More views, more detail and color.',
    captureStrategy: 'multi-view',
    backend: 'depth-anything-3',
    quality: 'high',
    color: true,
    targetFrames: 48,
  },
  {
    id: 'synthetic',
    label: 'Synthetic test',
    description: 'Generate a known test mesh with no camera. Good for checking the pipeline.',
    captureStrategy: 'synthetic',
    backend: 'synthetic',
    quality: 'balanced',
    color: false,
    targetFrames: 0,
  },
]

const DEFAULT_PRESET = SCAN_PRESETS[0]!

function formatFromPath(path: string): MeshFormat {
  const lower = path.toLowerCase()
  if (lower.endsWith('.glb') || lower.endsWith('.gltf')) return 'glb'
  if (lower.endsWith('.ply')) return 'ply'
  return 'stl'
}

/**
 * Holds the current capture session: the chosen preset, an optional backend
 * override, how many keyframes have been staged, and the reconstruction result
 * with the artifact bytes loaded for the 3D preview.
 */
export const useCaptureStore = defineStore('capture', () => {
  const presetId = ref<string>(DEFAULT_PRESET.id)
  const backendOverride = ref<string | null>(null)
  const frameCount = ref(0)
  const scanning = ref(false)
  const sessionId = ref<string | null>(null)

  const reconstructing = ref(false)
  const result = ref<ReconstructResult | null>(null)
  const reconstructError = ref<string | null>(null)
  const meshData = ref<Uint8Array | null>(null)
  const meshFormat = ref<MeshFormat>('stl')
  const savedPath = ref<string | null>(null)

  const activePreset = computed(
    () => SCAN_PRESETS.find((p) => p.id === presetId.value) ?? DEFAULT_PRESET,
  )
  const captureStrategy = computed(() => activePreset.value.captureStrategy)
  const quality = computed(() => activePreset.value.quality)
  const color = computed(() => activePreset.value.color)
  const targetFrames = computed(() => activePreset.value.targetFrames)
  const effectiveBackend = computed(() => backendOverride.value ?? activePreset.value.backend)

  /** True when the preset actually captures frames from the camera. */
  const usesCamera = computed(() => captureStrategy.value !== 'synthetic')
  const canScan = computed(() => usesCamera.value)

  function selectPreset(id: string): void {
    if (scanning.value) return
    presetId.value = id
    backendOverride.value = null
  }

  function setBackendOverride(id: string | null): void {
    backendOverride.value = id
  }

  /** Open a capture session in the main process and start scanning. */
  async function beginScan(): Promise<void> {
    frameCount.value = 0
    sessionId.value = await window.api.session.begin()
    scanning.value = true
  }

  /** Stop scanning and close the session. Staged frames are kept for reconstruct. */
  async function endScan(): Promise<void> {
    scanning.value = false
    const id = sessionId.value
    if (id) await window.api.session.end(id)
  }

  /** Encode-and-stage a keyframe to the active session, updating the count. */
  async function stageFrame(pngBytes: Uint8Array): Promise<void> {
    const id = sessionId.value
    if (!id) return
    frameCount.value = await window.api.session.stageFrame({ sessionId: id, data: pngBytes })
  }

  /** Run a reconstruction on the sidecar with the active preset's settings. */
  async function runReconstruction(): Promise<void> {
    reconstructing.value = true
    reconstructError.value = null
    result.value = null
    meshData.value = null
    savedPath.value = null
    try {
      const res = await window.api.sidecar.reconstruct({
        backend: effectiveBackend.value,
        quality: quality.value,
        color: color.value,
        sessionId: sessionId.value ?? undefined,
      })
      result.value = res
      // Prefer the previewPath the backend nominates (GLB for color, else STL).
      const previewSource = res.previewPath ?? res.meshPath
      meshFormat.value = formatFromPath(previewSource)
      try {
        meshData.value = await window.api.readArtifact({ path: previewSource })
      } catch {
        // The result and its counts still stand and Save still works; the
        // viewer just cannot show this artifact. MeshViewer handles the null.
        meshData.value = null
      }
    } catch (cause) {
      reconstructError.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      reconstructing.value = false
    }
  }

  /** Ask the sidecar to abort the in-flight reconstruction. */
  async function cancelReconstruction(): Promise<void> {
    await window.api.sidecar.cancelReconstruct()
  }

  /** Save one artifact to a user-chosen path, remembering it for the Reveal action. */
  async function saveArtifact(sourcePath: string, defaultName: string): Promise<string | null> {
    const path = await window.api.exportArtifact({ sourcePath, defaultName })
    if (path) savedPath.value = path
    return path
  }

  /** Show a saved file in the OS file browser. */
  async function reveal(path: string): Promise<void> {
    await window.api.reveal(path)
  }

  return {
    presetId,
    backendOverride,
    frameCount,
    scanning,
    sessionId,
    reconstructing,
    result,
    reconstructError,
    meshData,
    meshFormat,
    savedPath,
    activePreset,
    captureStrategy,
    quality,
    color,
    targetFrames,
    effectiveBackend,
    usesCamera,
    canScan,
    selectPreset,
    setBackendOverride,
    beginScan,
    endScan,
    stageFrame,
    runReconstruction,
    cancelReconstruction,
    saveArtifact,
    reveal,
  }
})
