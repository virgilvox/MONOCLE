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
    id: 'object-scan',
    label: 'Object scan',
    description: 'Walk the camera around an object. Fuses many views with Depth Anything V2.',
    captureStrategy: 'multi-view',
    backend: 'depth-anything-v2-walk',
    quality: 'balanced',
    color: true,
    targetFrames: 40,
  },
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

/** The default preset: an object scan with Depth Anything V2. */
const DEFAULT_PRESET = SCAN_PRESETS[0]!
/** Presets shown as cards. Synthetic is a diagnostic, offered as an Advanced
 * button rather than a card. */
export const CARD_PRESETS = SCAN_PRESETS.filter((p) => p.id !== 'synthetic')

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
/** Quality tiers a user can pick from in the advanced controls. */
export const QUALITY_TIERS: { id: Quality; label: string }[] = [
  { id: 'fast', label: 'Fast' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'high', label: 'High detail' },
]

/** The backend id whose model has selectable checkpoint sizes. */
export const DA3_BACKEND = 'depth-anything-3'

/** Depth Anything 3 checkpoint sizes. BASE is Apache-2.0; the others are
 * heavier and CC-BY-NC (non-commercial), so they are opt-in. */
export const DA3_SIZES: { id: string; label: string; note?: string }[] = [
  { id: 'base', label: 'Base', note: 'Apache-2.0' },
  { id: 'large', label: 'Large', note: 'non-commercial, slower' },
  { id: 'giant', label: 'Giant', note: 'non-commercial, slowest' },
]

export const useCaptureStore = defineStore('capture', () => {
  const presetId = ref<string>(DEFAULT_PRESET.id)
  // Advanced overrides. Null means "follow the preset"; a value pins that
  // setting regardless of the preset, so a user can trade speed for detail or
  // force a specific backend without leaving their chosen outcome.
  const backendOverride = ref<string | null>(null)
  const qualityOverride = ref<Quality | null>(null)
  const colorOverride = ref<boolean | null>(null)
  const checkpointOverride = ref<string | null>(null)
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
  const quality = computed(() => qualityOverride.value ?? activePreset.value.quality)
  const color = computed(() => colorOverride.value ?? activePreset.value.color)
  const targetFrames = computed(() => activePreset.value.targetFrames)
  const effectiveBackend = computed(() => backendOverride.value ?? activePreset.value.backend)
  /** The DA3 checkpoint size, defaulting to the Apache-2.0 base. */
  const effectiveCheckpoint = computed(() => checkpointOverride.value ?? 'base')
  /** True when the selected backend is Depth Anything 3, which has sizes. */
  const usesCheckpoint = computed(() => effectiveBackend.value === DA3_BACKEND)
  /** True when any advanced setting departs from the preset defaults. */
  const hasOverrides = computed(
    () =>
      backendOverride.value !== null ||
      qualityOverride.value !== null ||
      colorOverride.value !== null ||
      checkpointOverride.value !== null,
  )

  /** True when the preset actually captures frames from the camera. */
  const usesCamera = computed(() => captureStrategy.value !== 'synthetic')
  const canScan = computed(() => usesCamera.value)

  function selectPreset(id: string): void {
    if (scanning.value) return
    presetId.value = id
    resetOverrides()
  }

  function setBackendOverride(id: string | null): void {
    backendOverride.value = id
  }

  function setQualityOverride(quality: Quality | null): void {
    qualityOverride.value = quality
  }

  function setColorOverride(color: boolean | null): void {
    colorOverride.value = color
  }

  function setCheckpointOverride(checkpoint: string | null): void {
    checkpointOverride.value = checkpoint
  }

  /** Drop every advanced override back to the preset defaults. No-op while
   * scanning, so the settings a capture is running against cannot change. */
  function resetOverrides(): void {
    if (scanning.value) return
    backendOverride.value = null
    qualityOverride.value = null
    colorOverride.value = null
    checkpointOverride.value = null
  }

  /** Open a capture session in the main process and start scanning. Clears the
   * previous reconstruction so a new scan starts from a clean slate instead of
   * leaving the old mesh in the preview and the workflow reading as finished. */
  async function beginScan(): Promise<void> {
    frameCount.value = 0
    result.value = null
    meshData.value = null
    meshFormat.value = 'stl'
    savedPath.value = null
    reconstructError.value = null
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
        // Only Depth Anything 3 has selectable checkpoint sizes.
        checkpoint: usesCheckpoint.value ? effectiveCheckpoint.value : undefined,
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
    qualityOverride,
    colorOverride,
    checkpointOverride,
    effectiveCheckpoint,
    usesCheckpoint,
    hasOverrides,
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
    setQualityOverride,
    setColorOverride,
    setCheckpointOverride,
    resetOverrides,
    beginScan,
    endScan,
    stageFrame,
    runReconstruction,
    cancelReconstruction,
    saveArtifact,
    reveal,
  }
})
