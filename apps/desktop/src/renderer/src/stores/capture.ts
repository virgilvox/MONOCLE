import type { ReconstructDevice, ReconstructOutput, ReconstructResult } from '@monoclejs/protocol'
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
    description: 'Walk the camera around an object. The best method is chosen for your machine.',
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

/** The DA3 checkpoint the Gaussian-splat output needs. */
export const GAUSSIAN_CHECKPOINT = 'giant'

/**
 * Output products a reconstruction can yield. `mesh` runs on any backend; the
 * richer products are native to Depth Anything 3, so they are gated behind it.
 * `gaussian` additionally needs the giant (non-commercial) checkpoint.
 */
export const OUTPUT_KINDS: {
  id: ReconstructOutput
  label: string
  note: string
  richOnly?: boolean
  needsGiant?: boolean
}[] = [
  { id: 'mesh', label: 'Mesh', note: 'Watertight and printable. Works with any model.' },
  {
    id: 'pointCloud',
    label: 'Point cloud',
    note: 'Colored points. Needs Depth Anything 3.',
    richOnly: true,
  },
  {
    id: 'gaussian',
    label: 'Gaussian splat',
    note: 'Needs the giant (non-commercial) Depth Anything 3 checkpoint.',
    richOnly: true,
    needsGiant: true,
  },
  {
    id: 'colmap',
    label: 'COLMAP model',
    note: 'Sparse model for other tools. Needs Depth Anything 3.',
    richOnly: true,
  },
]

/** Compute devices the advanced lever can force. `auto` picks the best available. */
export const COMPUTE_DEVICES: { id: ReconstructDevice; label: string }[] = [
  { id: 'auto', label: 'Automatic' },
  { id: 'cpu', label: 'CPU' },
  { id: 'mps', label: 'Apple GPU (MPS)' },
  { id: 'cuda', label: 'NVIDIA GPU (CUDA)' },
]

/**
 * Backends whose method is an adaptive multi-view reconstruction, for which the
 * machine's recommendation may stand in. A preset pinned to a different backend
 * for a reason (the single-frame snapshot, the synthetic diagnostic) keeps its
 * own backend, so the recommendation never silently runs the wrong model.
 */
export const ADAPTIVE_BACKENDS = new Set<string>(['depth-anything-3', 'depth-anything-v2-walk'])

/**
 * Coerce an output kind to what the selected backend and checkpoint can actually
 * produce. Only Depth Anything 3 emits the rich products (point cloud, splat,
 * COLMAP), and a Gaussian splat additionally needs the giant checkpoint, so a
 * stale gaussian pick on a base checkpoint never reaches (and is rejected by) the
 * sidecar. Pure so the store and its tests share it.
 */
export function coerceOutput(
  backend: string,
  output: ReconstructOutput,
  checkpoint: string,
): ReconstructOutput {
  if (backend !== DA3_BACKEND) return 'mesh'
  if (output === 'gaussian' && checkpoint !== GAUSSIAN_CHECKPOINT) return 'mesh'
  return output
}

/**
 * Turn a raw sidecar error into one plain, actionable sentence. Falls back to the
 * original text (kept in the logs anyway) rather than hiding an unknown failure.
 */
export function humanReconstructError(raw: string): string {
  const m = raw.toLowerCase()
  if (m.includes('no frames'))
    return 'No frames to reconstruct yet. Capture a scan or import a video or photos first.'
  if (m.includes('timed out'))
    return 'The reconstruction took too long and was stopped. Try fewer frames, or a faster method in Advanced.'
  if (m.includes('empty mesh'))
    return 'That capture produced no geometry. Try a slower sweep with more overlap and texture.'
  if (m.includes('gaussian') || m.includes('giant'))
    return 'Gaussian splats need the giant Depth Anything 3 checkpoint. Choose it in Advanced.'
  if (m.includes('open3d') || m.includes('extra'))
    return 'This method needs components that are not installed in this build. Try the default method.'
  return raw
}

export const useCaptureStore = defineStore('capture', () => {
  const presetId = ref<string>(DEFAULT_PRESET.id)
  // Advanced overrides. Null means "follow the preset"; a value pins that
  // setting regardless of the preset, so a user can trade speed for detail or
  // force a specific backend without leaving their chosen outcome.
  const backendOverride = ref<string | null>(null)
  const qualityOverride = ref<Quality | null>(null)
  const colorOverride = ref<boolean | null>(null)
  const checkpointOverride = ref<string | null>(null)
  // The adaptive default method, set from the machine profile. It stands in for
  // the preset's own backend so the simple UI picks a good model without the user
  // choosing one; an explicit backendOverride still wins over it.
  const recommendedBackend = ref<string | null>(DEFAULT_PRESET.backend)
  // Standalone reconstruction settings (not preset-scoped): the heavy-path
  // compute device and the output product. They persist across preset changes
  // because they express user intent, not an outcome.
  const device = ref<ReconstructDevice>('auto')
  const output = ref<ReconstructOutput>('mesh')
  const frameCount = ref(0)
  const scanning = ref(false)
  const sessionId = ref<string | null>(null)

  const reconstructing = ref(false)
  const importing = ref(false)
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
  /** The backend that stands for "no override". The machine's recommendation only
   * substitutes for a preset whose own backend is itself an adaptive multi-view
   * reconstruction; a purpose-pinned preset (snapshot, synthetic) keeps its
   * backend so the recommendation can never run the wrong model. */
  const defaultBackend = computed(() => {
    const preset = activePreset.value.backend
    if (recommendedBackend.value && ADAPTIVE_BACKENDS.has(preset)) return recommendedBackend.value
    return preset
  })
  const effectiveBackend = computed(() => backendOverride.value ?? defaultBackend.value)
  /** The DA3 checkpoint size, defaulting to the Apache-2.0 base. */
  const effectiveCheckpoint = computed(() => checkpointOverride.value ?? 'base')
  /** True when the selected backend is Depth Anything 3, which has sizes. */
  const usesCheckpoint = computed(() => effectiveBackend.value === DA3_BACKEND)
  /** True when the backend can emit the rich outputs (point cloud, splat, COLMAP). */
  const supportsRichOutput = computed(() => effectiveBackend.value === DA3_BACKEND)
  /** The output actually sent: coerced to mesh when the backend or checkpoint
   * cannot produce the chosen rich product, so a stale gaussian pick never
   * reaches the sidecar. */
  const effectiveOutput = computed(() =>
    coerceOutput(effectiveBackend.value, output.value, effectiveCheckpoint.value),
  )
  /** True when the current selection can actually produce a Gaussian splat: DA3
   * with the giant checkpoint. Drives the output selector's enabled state. */
  const canGaussian = computed(
    () => supportsRichOutput.value && effectiveCheckpoint.value === GAUSSIAN_CHECKPOINT,
  )
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

  /** Set the adaptive default method (from the machine profile). Leaves an
   * explicit backend override untouched, so a user's pin always wins. */
  function setRecommendedBackend(id: string): void {
    recommendedBackend.value = id
  }

  function setDevice(next: ReconstructDevice): void {
    device.value = next
  }

  function setOutput(next: ReconstructOutput): void {
    output.value = next
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
        device: device.value,
        output: effectiveOutput.value,
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
      const message = cause instanceof Error ? cause.message : String(cause)
      // A user cancel is not a failure: clear the busy state without a red error.
      reconstructError.value = /cancel/i.test(message) ? null : humanReconstructError(message)
    } finally {
      reconstructing.value = false
    }
  }

  /**
   * Reconstruct from a dropped-in video or image folder. Prompts for the source,
   * has the sidecar ingest it into a fresh session's frames (choosing sharp,
   * well-spread keyframes), then reconstructs with the active preset's backend.
   * The keyframe budget follows the preset's target (one frame for the snapshot
   * preset, up to a multi-view cap otherwise). Resolves true when a run started.
   */
  async function importMedia(maxFrames?: number): Promise<boolean> {
    const chosen = await window.api.chooseMedia()
    if (!chosen) return false

    importing.value = true
    frameCount.value = 0
    result.value = null
    meshData.value = null
    meshFormat.value = 'stl'
    savedPath.value = null
    reconstructError.value = null
    try {
      const budget = maxFrames ?? (targetFrames.value > 0 ? targetFrames.value : 40)
      const staged = await window.api.sidecar.prepareMedia({
        token: chosen.token,
        maxFrames: budget,
      })
      sessionId.value = staged.sessionId
      frameCount.value = staged.frameCount
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      reconstructError.value = /cancel/i.test(message) ? null : humanReconstructError(message)
      return false
    } finally {
      importing.value = false
    }

    await runReconstruction()
    return true
  }

  /** Ask the sidecar to abort the in-flight reconstruction. */
  async function cancelReconstruction(): Promise<void> {
    await window.api.sidecar.cancelReconstruct()
  }

  /** Save one artifact (a file or, for COLMAP, a folder) to a user-chosen path,
   * remembering it for the Reveal action. Surfaces a failure rather than letting
   * it become an unhandled rejection. */
  async function saveArtifact(sourcePath: string, defaultName: string): Promise<string | null> {
    try {
      const path = await window.api.exportArtifact({ sourcePath, defaultName })
      if (path) savedPath.value = path
      return path
    } catch {
      reconstructError.value = 'Could not save that file. Try a different location.'
      return null
    }
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
    recommendedBackend,
    device,
    output,
    effectiveCheckpoint,
    usesCheckpoint,
    supportsRichOutput,
    effectiveOutput,
    canGaussian,
    hasOverrides,
    frameCount,
    scanning,
    sessionId,
    reconstructing,
    importing,
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
    defaultBackend,
    effectiveBackend,
    usesCamera,
    canScan,
    selectPreset,
    setBackendOverride,
    setQualityOverride,
    setColorOverride,
    setCheckpointOverride,
    setRecommendedBackend,
    setDevice,
    setOutput,
    resetOverrides,
    beginScan,
    endScan,
    stageFrame,
    runReconstruction,
    importMedia,
    cancelReconstruction,
    saveArtifact,
    reveal,
  }
})
