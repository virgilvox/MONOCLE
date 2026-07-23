/**
 * The capture polling loop: grab the camera a few times a second, run each
 * frame through the keyframe gate, and stage the keepers to the active session.
 * Owns the gate feedback the HUD shows.
 */

import { ref } from 'vue'
import { useCaptureStore } from '../stores/capture'
import { encodeBitmapToPng } from './useFrameEncoder'
import { type GateReason, useKeyframeGate } from './useKeyframeGate'

// Poll the camera a few times a second; the gate decides what to keep.
const GRAB_INTERVAL_MS = 200

export function useCaptureLoop(options: {
  /** Grab one frame from the camera view; null when no camera is mounted. */
  grab: () => Promise<ImageBitmap | null>
  /** Ends the scan when a single-frame preset lands its frame. */
  onSingleFrameDone: () => Promise<void>
}) {
  const capture = useCaptureStore()
  const gate = useKeyframeGate()

  // HUD feedback from the keyframe gate.
  const gateReason = ref<GateReason>('searching')
  const gateSharpness = ref(0)

  let captureTimer: ReturnType<typeof setInterval> | null = null
  let grabbing = false

  /** Clear the gate and its HUD feedback ahead of a fresh scan. */
  function resetGate(): void {
    gate.reset()
    gateReason.value = 'searching'
    gateSharpness.value = 0
  }

  function startLoop(): void {
    captureTimer = setInterval(() => void grabFrame(), GRAB_INTERVAL_MS)
  }

  function stopLoop(): void {
    if (captureTimer) {
      clearInterval(captureTimer)
      captureTimer = null
    }
  }

  async function grabFrame(force = false): Promise<void> {
    // In-flight guard: never let two grabs overlap.
    if (grabbing || !capture.scanning) return
    grabbing = true
    try {
      const bitmap = await options.grab()
      if (!bitmap) return
      try {
        const metrics = gate.evaluate(bitmap)
        gateReason.value = metrics.reason
        gateSharpness.value = metrics.sharpness
        // Manual capture forces the frame through even when the gate would skip it.
        if (!force && !metrics.accept) return
        const png = await encodeBitmapToPng(bitmap)
        // The scan can end while the PNG encodes; staging to a closed session
        // throws "unknown session". Re-check before handing the frame over.
        if (!capture.scanning) return
        await capture.stageFrame(png)
        // A single-frame preset is done as soon as one frame lands.
        if (capture.captureStrategy === 'single') await options.onSingleFrameDone()
      } finally {
        bitmap.close()
      }
    } finally {
      grabbing = false
    }
  }

  return { gateReason, gateSharpness, resetGate, startLoop, stopLoop, grabFrame }
}
