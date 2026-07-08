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

const MODEL_PATH = '/models/depth-anything-v2-small/model_fp16.onnx'
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
    worker = new Worker(new URL('../workers/depthWorker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => onWorkerMessage(event.data)
    worker.onerror = () => {
      // A worker crash (WebGPU device lost, OOM) must not leave the loop running
      // with inFlight stuck true and the GPU session + model resident. Tear it
      // all down so a later reconfigure can start fresh.
      errorMessage.value = 'Depth worker crashed'
      stopLoop()
      stopWorker()
      status.value = 'error'
    }
    worker.postMessage({ type: 'init', modelUrl: MODEL_PATH, inputSize: size })
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
      if (looping) status.value = 'running'
      return
    }
    if (message.type === 'error') {
      status.value = message.reason === 'missing-model' ? 'missing-model' : 'error'
      errorMessage.value =
        message.reason === 'missing-model' ? MISSING_MODEL_MESSAGE : message.message
      stopLoop()
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
    stopLoop()
    stopWorker()
    if (status.value !== 'missing-model' && status.value !== 'error') status.value = 'idle'
  }

  function reconfigure(): void {
    const isActive = toValue(options.active)
    const stream = toValue(options.stream)
    const size = inputSize()

    if (!isActive || !stream) {
      teardown()
      return
    }

    if (depthSize.value !== size) {
      depthSize.value = size
      depthData.value = new Float32Array(size * size)
    }

    startWorker(size)
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
