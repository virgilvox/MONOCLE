/**
 * Drive the live depth preview from a camera MediaStream.
 *
 * This owns the inference worker, an offscreen video element, and the frame
 * loop. Each camera frame is resized and handed to the worker; while an
 * inference is in flight new frames are dropped so the pipeline degrades
 * gracefully under load instead of queueing latency.
 *
 * Two exponential moving averages smooth the output on the main thread: one on
 * the normalization range (slow, so the depth scale does not flicker) and one
 * per pixel (faster, to settle noise). The smoothed values are written into the
 * reused typed arrays that back the viewer's depth and color textures.
 */
import { onBeforeUnmount, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'

export type DepthQuality = 'fast' | 'balanced' | 'high'
export type DepthStatus = 'idle' | 'loading' | 'running' | 'missing-model' | 'error'

// Square input edge per quality tier. Every value is a multiple of 14, which
// Depth Anything V2's patch embedding requires.
const INPUT_SIZE: Record<DepthQuality, number> = {
  fast: 252,
  balanced: 308,
  high: 308,
}

// Resolution of the color texture sampled by the point cloud. Fixed so the
// texture is allocated once regardless of quality.
const COLOR_SIZE = 256

const RANGE_LERP = 0.1
const DEPTH_LERP = 0.35

// The worker picks the fp16 or fp32 file under this directory by execution
// provider (fp16 for WebGPU, fp32 for the wasm fallback).
const MODEL_DIR = '/models/depth-anything-v2-small/'
const MISSING_MODEL_MESSAGE = 'Live depth model not installed - run pnpm fetch:models'

type ResultMessage = { type: 'result'; depth: Float32Array; width: number; height: number }
type ReadyMessage = { type: 'ready' }
type ErrorMessage = { type: 'error'; reason: string; message: string }
type WorkerMessage = ResultMessage | ReadyMessage | ErrorMessage

export interface LiveDepthOptions {
  stream: MaybeRefOrGetter<MediaStream | null>
  active: MaybeRefOrGetter<boolean>
  quality: MaybeRefOrGetter<DepthQuality>
}

export function useLiveDepth(options: LiveDepthOptions) {
  const status = ref<DepthStatus>('idle')
  const errorMessage = ref<string | null>(null)
  const revision = ref(0)
  const depthSize = ref(INPUT_SIZE[toValue(options.quality)])

  // Buffers backing the viewer textures. depthData is reallocated when quality
  // changes its resolution; colorData is fixed for the session.
  const depthData = shallowRef(new Float32Array(depthSize.value * depthSize.value))
  const colorData = new Uint8Array(COLOR_SIZE * COLOR_SIZE * 4)

  let worker: Worker | null = null
  let workerReady = false
  let inFlight = false
  // Input size the current worker was built for, so a warm worker is reused
  // across Live-tab toggles and only rebuilt when the size actually changes.
  let workerSize = 0

  // Bounded auto-restart after a worker crash or a transient device loss, so the
  // preview recovers on its own instead of staying dead until the user toggles
  // tabs. Attempts reset on a successful load and on any user-driven change.
  const MAX_WORKER_RESTARTS = 5
  let restartAttempts = 0
  let restartTimer: ReturnType<typeof setTimeout> | null = null

  let video: HTMLVideoElement | null = null
  let frameHandle = 0
  let usingVfc = false
  let looping = false

  let colorCanvas: OffscreenCanvas | null = null
  let colorCtx: OffscreenCanvasRenderingContext2D | null = null

  let rangeMin = 0
  let rangeMax = 1
  let rangePrimed = false

  function inputSize(): number {
    return INPUT_SIZE[toValue(options.quality)]
  }

  function resetSmoothing(): void {
    rangePrimed = false
    depthData.value.fill(0)
  }

  function ensureColorCanvas(): void {
    if (colorCanvas) return
    colorCanvas = new OffscreenCanvas(COLOR_SIZE, COLOR_SIZE)
    colorCtx = colorCanvas.getContext('2d', { willReadFrequently: true })
  }

  function startWorker(size: number): void {
    stopWorker()
    status.value = 'loading'
    errorMessage.value = null
    workerReady = false
    inFlight = false
    workerSize = size
    worker = new Worker(new URL('../workers/depthWorker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => onWorkerMessage(event.data)
    worker.onerror = () => {
      // A worker crash (WebGPU device lost, OOM) must not leave the loop running
      // with inFlight stuck true and the GPU session + model resident. Tear it
      // down, then try to recover on a backoff rather than staying dead.
      errorMessage.value = 'Depth worker crashed'
      stopWorker()
      scheduleWorkerRestart()
    }
    worker.postMessage({ type: 'init', modelDir: MODEL_DIR, inputSize: size })
  }

  /** Try to rebuild the worker after a crash or device loss, with backoff. */
  function scheduleWorkerRestart(): void {
    if (restartTimer !== null) return
    if (!toValue(options.active) || !toValue(options.stream)) return
    if (restartAttempts >= MAX_WORKER_RESTARTS) {
      status.value = 'error'
      errorMessage.value = 'Live depth failed to recover'
      stopLoop()
      return
    }
    const delay = Math.min(500 * 2 ** restartAttempts, 5000)
    restartAttempts += 1
    status.value = 'loading'
    restartTimer = setTimeout(() => {
      restartTimer = null
      const stream = toValue(options.stream)
      if (!toValue(options.active) || !stream) return
      startWorker(inputSize())
      stopLoop()
      void startLoop(stream)
    }, delay)
  }

  function clearRestartTimer(): void {
    if (restartTimer !== null) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
  }

  function stopWorker(): void {
    if (!worker) return
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
    worker = null
    workerReady = false
    inFlight = false
  }

  function onWorkerMessage(message: WorkerMessage): void {
    if (message.type === 'ready') {
      workerReady = true
      restartAttempts = 0 // a clean load restores the recovery budget
      if (looping) status.value = 'running'
      return
    }
    if (message.type === 'error') {
      if (message.reason === 'missing-model') {
        status.value = 'missing-model'
        errorMessage.value = MISSING_MODEL_MESSAGE
        stopLoop()
        return
      }
      // A device loss surfaces as an init or infer failure and is recoverable;
      // tear the worker down and retry on a backoff.
      errorMessage.value = message.message
      stopWorker()
      scheduleWorkerRestart()
      return
    }
    onDepth(message.depth)
  }

  function onDepth(depth: Float32Array): void {
    inFlight = false
    const count = Math.min(depth.length, depthData.value.length)

    let frameMin = Infinity
    let frameMax = -Infinity
    for (let i = 0; i < count; i += 1) {
      const value = depth[i]!
      if (value < frameMin) frameMin = value
      if (value > frameMax) frameMax = value
    }

    if (!rangePrimed) {
      rangeMin = frameMin
      rangeMax = frameMax
      rangePrimed = true
    } else {
      rangeMin += (frameMin - rangeMin) * RANGE_LERP
      rangeMax += (frameMax - rangeMax) * RANGE_LERP
    }

    const span = Math.max(rangeMax - rangeMin, 1e-6)
    const target = depthData.value
    for (let i = 0; i < count; i += 1) {
      let normalized = (depth[i]! - rangeMin) / span
      if (normalized < 0) normalized = 0
      else if (normalized > 1) normalized = 1
      const prev = target[i]!
      target[i] = prev + (normalized - prev) * DEPTH_LERP
    }

    revision.value += 1

    // Hand the buffer back to the worker for reuse.
    worker?.postMessage({ type: 'recycle', buffer: depth.buffer }, [depth.buffer])
  }

  function onFrame(): void {
    if (!looping || !video || !colorCtx) return

    colorCtx.drawImage(video, 0, 0, COLOR_SIZE, COLOR_SIZE)
    colorData.set(colorCtx.getImageData(0, 0, COLOR_SIZE, COLOR_SIZE).data)
    revision.value += 1

    if (worker && workerReady && !inFlight) {
      inFlight = true
      const size = depthSize.value
      createImageBitmap(video, {
        resizeWidth: size,
        resizeHeight: size,
        resizeQuality: 'low',
      })
        .then((bitmap) => {
          if (worker && looping) worker.postMessage({ type: 'infer', bitmap }, [bitmap])
          else {
            bitmap.close()
            inFlight = false
          }
        })
        .catch(() => {
          inFlight = false
        })
    }

    scheduleFrame()
  }

  function scheduleFrame(): void {
    if (!looping || !video) return
    if (usingVfc && video.requestVideoFrameCallback) {
      frameHandle = video.requestVideoFrameCallback(onFrame)
    } else {
      frameHandle = requestAnimationFrame(onFrame)
    }
  }

  async function startLoop(stream: MediaStream): Promise<void> {
    ensureColorCanvas()
    resetSmoothing()

    // Operate on a local const so narrowing survives the await (the closure
    // `video` can be nulled by a concurrent teardown).
    const el = document.createElement('video')
    el.muted = true
    el.playsInline = true
    el.srcObject = stream
    video = el
    try {
      await el.play()
    } catch {
      // Autoplay can reject if the stream stopped mid-start; the teardown path
      // below cleans up either way.
    }

    looping = true
    usingVfc = typeof el.requestVideoFrameCallback === 'function'
    if (workerReady) status.value = 'running'
    scheduleFrame()
  }

  function stopLoop(): void {
    looping = false
    if (video) {
      if (usingVfc && video.cancelVideoFrameCallback && frameHandle) {
        video.cancelVideoFrameCallback(frameHandle)
      } else if (frameHandle) {
        cancelAnimationFrame(frameHandle)
      }
      video.pause()
      video.srcObject = null
      video = null
    }
    frameHandle = 0
    inFlight = false
  }

  function teardown(): void {
    clearRestartTimer()
    stopLoop()
    stopWorker()
    if (status.value !== 'missing-model' && status.value !== 'error') status.value = 'idle'
  }

  function reconfigure(): void {
    const isActive = toValue(options.active)
    const stream = toValue(options.stream)
    const size = inputSize()

    // A user-driven change (tab, stream, quality) is a fresh start: clear any
    // pending crash-restart and restore the recovery budget.
    clearRestartTimer()
    restartAttempts = 0

    // Leaving the Live tab stops the frame loop but keeps the worker warm, so
    // returning does not reload and recompile the model. The worker is only torn
    // down on unmount or when the input size (quality) changes.
    if (!isActive || !stream) {
      stopLoop()
      return
    }

    if (depthSize.value !== size) {
      depthSize.value = size
      depthData.value = new Float32Array(size * size)
    }

    if (!worker || workerSize !== size) startWorker(size)
    stopLoop()
    void startLoop(stream)
  }

  watch(
    () => [toValue(options.active), toValue(options.stream), toValue(options.quality)] as const,
    () => reconfigure(),
    { immediate: true },
  )

  onBeforeUnmount(teardown)

  return {
    status,
    errorMessage,
    revision,
    depthData,
    depthSize,
    colorData,
    colorSize: COLOR_SIZE,
  }
}
