import type { ReconstructDevice, ReconstructOutput, ReconstructResult } from '@monoclejs/protocol'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { humanReconstructError } from '../lib/errors'
import { formatFromPath, type MeshFormat } from '../lib/meshFormat'
import { coerceOutput, DA3_BACKEND, GAUSSIAN_CHECKPOINT } from '../lib/outputs'
import { DEFAULT_PRESET, SCAN_PRESETS, type Quality } from '../lib/presets'
import { resolveScanBackend } from '../lib/scanEngine'

/**
 * Holds the current capture session: the chosen preset, an optional backend
 * override, how many keyframes have been staged, and the reconstruction result
 * with the artifact bytes loaded for the 3D preview.
 */
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
   * backend so the recommendation can never run the wrong model. The resolution
   * rule lives in lib/scanEngine so the preset cards show the same answer. */
  const defaultBackend = computed(() =>
    resolveScanBackend(activePreset.value.backend, null, recommendedBackend.value),
  )
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
