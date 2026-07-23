/**
 * Experimental live reconstruction: a mesh that forms in the 3D preview as the
 * scan runs. Only applies to multi-view (walk-around) captures. Owns the live
 * session state and derives what the 3D viewer should show: the live-forming
 * mesh during a live scan, otherwise the finished reconstruction.
 */

import { computed, ref } from 'vue'
import { humanReconstructError } from '../lib/errors'
import { useCaptureStore } from '../stores/capture'

export function useLiveReconstruction() {
  const capture = useCaptureStore()

  const liveEnabled = ref(false)
  const liveActive = ref(false)
  const liveMeshData = ref<Uint8Array | null>(null)
  const liveFrameCount = ref(0)
  let unsubMesh: (() => void) | null = null
  // Monotonic token identifying the current live session. The sidecar only
  // observes a cancel between fusion steps, so a session's promise can settle
  // long after Stop; the token lets late callbacks tell whether the state they
  // would touch still belongs to them.
  let liveSession = 0
  const canLive = computed(() => capture.usesCamera && capture.captureStrategy === 'multi-view')

  const previewData = computed(() => (liveActive.value ? liveMeshData.value : capture.meshData))
  const previewFormat = computed(() => (liveActive.value ? 'ply' : capture.meshFormat))
  const previewHasResult = computed(() =>
    liveActive.value ? liveMeshData.value !== null : capture.result !== null,
  )
  // A live scan always forms a mesh; a finished run carries its own output kind so
  // the viewer can be honest about a Gaussian splat or COLMAP model it cannot show.
  const previewOutput = computed(() =>
    liveActive.value ? 'mesh' : (capture.result?.output ?? 'mesh'),
  )

  function startLive(): void {
    const sessionId = capture.sessionId
    if (!sessionId) return
    const session = ++liveSession
    liveActive.value = true
    liveMeshData.value = null
    liveFrameCount.value = 0
    // The camera stays on screen: the user is mid walk-around and needs to see
    // what they are framing. The 3D Preview tab unlocks (liveActive enables it)
    // so they can switch over and watch the mesh form whenever they choose.
    unsubMesh = window.api.sidecar.onMeshUpdate(
      (note) => void onMeshUpdate(note.meshPath, note.frameCount),
    )
    // Fire-and-forget: it resolves when the scan cancels it. A rejection (the
    // sidecar dying, a bad session) must not leave the Live badge stuck, so drop
    // the live state and surface the error where reconstruction errors show.
    // Only if this call is still the current session, though: a late rejection
    // from a stopped session must not tear down a newer one's listener or badge.
    window.api.sidecar.liveReconstruct({ sessionId, color: capture.color }).catch((cause) => {
      if (session !== liveSession) return
      const message = cause instanceof Error ? cause.message : String(cause)
      if (unsubMesh) {
        unsubMesh()
        unsubMesh = null
      }
      liveActive.value = false
      if (!/cancel/i.test(message)) capture.reconstructError = humanReconstructError(message)
    })
  }

  async function onMeshUpdate(meshPath: string, frameCount: number): Promise<void> {
    try {
      liveMeshData.value = await window.api.readArtifact({ path: meshPath })
      liveFrameCount.value = frameCount
    } catch {
      // A versioned mesh file may already be gone; the next update will land.
    }
  }

  function stopLive(): void {
    if (unsubMesh) {
      unsubMesh()
      unsubMesh = null
    }
    if (liveActive.value) {
      void window.api.sidecar.cancelReconstruct()
      liveActive.value = false
    }
  }

  return {
    liveEnabled,
    liveActive,
    liveMeshData,
    liveFrameCount,
    canLive,
    previewData,
    previewFormat,
    previewHasResult,
    previewOutput,
    startLive,
    stopLive,
  }
}
