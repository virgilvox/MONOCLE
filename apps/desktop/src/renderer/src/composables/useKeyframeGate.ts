/**
 * Gates keyframes so only useful ones reach disk. A frame is accepted when it
 * is sharp enough (variance of the Laplacian, the classic focus measure) and
 * the viewpoint has moved enough since the last accepted frame to add coverage,
 * without being so blurred by motion that geometry would smear.
 *
 * Everything runs on a small grayscale downscale of the frame, so the cost is a
 * few milliseconds regardless of camera resolution.
 */

const SAMPLE_WIDTH = 160

/** Why a frame was or was not accepted, surfaced to the capture HUD. */
export type GateReason =
  'searching' | 'accepted' | 'too-blurry' | 'hold-steady' | 'move-more' | 'first'

export interface GateResult {
  accept: boolean
  reason: GateReason
  /** Variance-of-Laplacian focus score. Higher is sharper. */
  sharpness: number
  /** Mean absolute pixel change since the last evaluated frame, 0..255. */
  motion: number
}

export interface GateThresholds {
  /** Absolute focus floor; frames below this are always rejected as blurry. */
  minSharpness: number
  /** Accept only frames at least this fraction of the sharpest seen so far, so a
   * soft or low-light camera is judged against itself, not a fixed number. */
  sharpnessFraction: number
  /** A new viewpoint needs at least this much change from the last kept frame. */
  minMotion: number
  /** Above this, the camera is moving too fast and the frame is likely smeared. */
  maxMotion: number
}

const DEFAULT_THRESHOLDS: GateThresholds = {
  minSharpness: 8,
  sharpnessFraction: 0.5,
  minMotion: 3.5,
  maxMotion: 42,
}

export function useKeyframeGate(thresholds: Partial<GateThresholds> = {}) {
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds }

  let canvas: OffscreenCanvas | null = null
  let ctx: OffscreenCanvasRenderingContext2D | null = null
  let sampleHeight = 0
  // Grayscale buffers for the current frame, the previous frame (motion), and
  // the last frame we actually kept (coverage progress).
  let gray: Float32Array | null = null
  let previous: Float32Array | null = null
  let lastKept: Float32Array | null = null
  // Sharpest focus score seen recently; decays slowly so the accept floor tracks
  // the current scene and lighting instead of a fixed threshold.
  let peakSharpness = 0

  function ensureCanvas(width: number, height: number): boolean {
    sampleHeight = Math.max(1, Math.round((SAMPLE_WIDTH * height) / width))
    if (!canvas || canvas.width !== SAMPLE_WIDTH || canvas.height !== sampleHeight) {
      canvas = new OffscreenCanvas(SAMPLE_WIDTH, sampleHeight)
      ctx = canvas.getContext('2d', { willReadFrequently: true })
      gray = new Float32Array(SAMPLE_WIDTH * sampleHeight)
      previous = null
      lastKept = null
      peakSharpness = 0
    }
    return ctx !== null && gray !== null
  }

  function meanAbsDiff(a: Float32Array, b: Float32Array): number {
    let sum = 0
    for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i]! - b[i]!)
    return sum / a.length
  }

  /** Variance of the 4-neighbor Laplacian across the interior of the sample. */
  function varianceOfLaplacian(buffer: Float32Array, width: number, height: number): number {
    const values: number[] = []
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const i = y * width + x
        const lap =
          buffer[i - 1]! + buffer[i + 1]! + buffer[i - width]! + buffer[i + width]! - 4 * buffer[i]!
        values.push(lap)
      }
    }
    if (values.length === 0) return 0
    let mean = 0
    for (const v of values) mean += v
    mean /= values.length
    let variance = 0
    for (const v of values) variance += (v - mean) * (v - mean)
    return variance / values.length
  }

  /**
   * Evaluate one frame. Does not consume the bitmap; the caller keeps ownership
   * and may still encode it if the frame is accepted.
   */
  function evaluate(bitmap: ImageBitmap): GateResult {
    if (!ensureCanvas(bitmap.width, bitmap.height) || !ctx || !gray) {
      return { accept: false, reason: 'too-blurry', sharpness: 0, motion: 0 }
    }
    ctx.drawImage(bitmap, 0, 0, SAMPLE_WIDTH, sampleHeight)
    const { data } = ctx.getImageData(0, 0, SAMPLE_WIDTH, sampleHeight)
    for (let i = 0; i < gray.length; i += 1) {
      const p = i * 4
      // Rec. 601 luma keeps the focus measure close to perceived detail.
      gray[i] = 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!
    }

    const sharpness = varianceOfLaplacian(gray, SAMPLE_WIDTH, sampleHeight)
    peakSharpness = Math.max(sharpness, peakSharpness * 0.99)
    const sharpFloor = Math.max(limits.minSharpness, peakSharpness * limits.sharpnessFraction)
    const motion = previous ? meanAbsDiff(gray, previous) : Number.POSITIVE_INFINITY
    previous = gray.slice()

    let reason: GateReason
    let accept = false
    if (sharpness < sharpFloor) {
      reason = 'too-blurry'
    } else if (motion > limits.maxMotion && Number.isFinite(motion)) {
      reason = 'hold-steady'
    } else if (!lastKept) {
      reason = 'first'
      accept = true
    } else {
      const fromKept = meanAbsDiff(gray, lastKept)
      if (fromKept < limits.minMotion) {
        reason = 'move-more'
      } else {
        reason = 'accepted'
        accept = true
      }
    }

    if (accept) lastKept = gray.slice()
    return { accept, reason, sharpness, motion: Number.isFinite(motion) ? motion : 0 }
  }

  function reset(): void {
    previous = null
    lastKept = null
    peakSharpness = 0
  }

  return { evaluate, reset }
}
