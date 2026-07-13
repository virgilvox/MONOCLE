/**
 * Depth inference worker.
 *
 * Runs a single-image depth model (Depth Anything V2 Small by default, or
 * Depth Anything 3 Small) on a dedicated thread with the onnxruntime-web WebGPU
 * execution provider. It receives camera frames as transferable ImageBitmaps,
 * produces a single-channel depth map, and posts the result back as a
 * transferable Float32Array. Buffers are recycled from the main thread so the
 * steady state does no per-frame allocation.
 *
 * The ort session, the input tensor, and the OffscreenCanvas all live here for
 * the lifetime of the worker. The model and the ort wasm binaries load from the
 * renderer public directory so the app works fully offline under CSP. Everything
 * that differs between the two models (file, input rank, output pruning, depth
 * sign) is read from a per-model config so this stays one code path.
 */
import * as ort from 'onnxruntime-web/webgpu'
import {
  DEFAULT_LIVE_DEPTH_MODEL,
  liveDepthModelConfig,
  metricToDisparityValue,
  type LiveDepthModel,
  type LiveDepthModelConfig,
} from '../lib/liveDepthModel'

// ort loads its wasm binaries (and dynamically imports the .mjs glue) from a
// local path, never a CDN. Use an absolute origin URL rather than a bare
// "/models/ort/": the bundler must treat ort's dynamic import as a runtime URL,
// not resolve it through the module graph (a bare /public path errors in dev).
// Works for both the dev http origin and the packaged app:// origin.
ort.env.wasm.wasmPaths = `${self.location.origin}/models/ort/`

type InitMessage = { type: 'init'; model: LiveDepthModel; inputSize: number }
type InferMessage = { type: 'infer'; bitmap: ImageBitmap }
type RecycleMessage = { type: 'recycle'; buffer: ArrayBuffer }
type InboundMessage = InitMessage | InferMessage | RecycleMessage

type ReadyMessage = { type: 'ready' }
type ResultMessage = { type: 'result'; depth: Float32Array; width: number; height: number }
type ErrorMessage = {
  type: 'error'
  reason: 'missing-model' | 'init-failed' | 'infer-failed'
  message: string
}
type OutboundMessage = ReadyMessage | ResultMessage | ErrorMessage

// ImageNet normalization constants used by Depth Anything's preprocessing.
const MEAN = [0.485, 0.456, 0.406] as const
const STD = [0.229, 0.224, 0.225] as const

const scope = self as unknown as DedicatedWorkerGlobalScope

let session: ort.InferenceSession | null = null
let config: LiveDepthModelConfig = liveDepthModelConfig(DEFAULT_LIVE_DEPTH_MODEL)
let inputName = ''
let outputName = ''
// Outputs to request each run: only the first for DA3 (prunes the camera-pose
// heads), or undefined to run the default single output for DA2.
let fetches: string[] | undefined
let size = 0
let plane = 0
let inputData: Float32Array | null = null
let inputTensor: ort.Tensor | null = null
let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null

// Recycled output buffers returned by the main thread. When empty we allocate,
// which only happens for the first couple of frames before recycling catches up.
const freeList: Float32Array[] = []

scope.onmessage = (event: MessageEvent<InboundMessage>) => {
  const message = event.data
  if (message.type === 'init') void init(message)
  else if (message.type === 'infer') void infer(message.bitmap)
  else if (message.type === 'recycle') recycle(message.buffer)
}

function send(message: OutboundMessage, transfer?: Transferable[]): void {
  scope.postMessage(message, transfer ?? [])
}

function recycle(buffer: ArrayBuffer): void {
  if (buffer.byteLength === plane * 4) freeList.push(new Float32Array(buffer))
}

async function init(message: InitMessage): Promise<void> {
  config = liveDepthModelConfig(message.model)
  size = message.inputSize
  plane = size * size
  inputData = new Float32Array(3 * plane)
  // DA2 is 4D [1,3,H,W]; DA3 carries an extra num_images axis, [1,1,3,H,W]. Same
  // backing buffer, only the rank differs.
  inputTensor = new ort.Tensor('float32', inputData, config.inputShape(size))
  canvas = new OffscreenCanvas(size, size)
  ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    send({ type: 'error', reason: 'init-failed', message: 'no 2d context in worker' })
    return
  }

  // Pick the model file and provider by capability. DA2 has an fp16 export for
  // WebGPU (fast, small) and an fp32 export for the wasm fallback, whose fp16
  // support is too weak to rely on; DA3 is fp32 only. An fp16 export keeps its
  // weights in a sibling data file; a single-file export has none, and the
  // config tells us which so we never fetch an absent sibling (that would reject
  // under app:// and be misreported as a missing model).
  const hasWebGPU = 'gpu' in navigator
  const modelFile = config.modelFile(hasWebGPU)
  const modelUrl = `${config.dir}${modelFile}`
  const externalFile = config.externalDataFile(hasWebGPU)
  const executionProviders = hasWebGPU ? ['webgpu', 'wasm'] : ['wasm']

  // Only the wasm path benefits from threads, and only under cross-origin
  // isolation (COOP/COEP) where SharedArrayBuffer exists. Keep the WebGPU path's
  // wasm fallback single-threaded so it does not spin up an unused thread pool.
  ort.env.wasm.numThreads =
    !hasWebGPU && self.crossOriginIsolated ? (navigator.hardwareConcurrency ?? 4) : 1

  let modelBytes: Uint8Array
  let externalBytes: Uint8Array | null = null
  try {
    const modelResponse = await fetch(modelUrl)
    if (!modelResponse.ok) {
      send({ type: 'error', reason: 'missing-model', message: `model ${modelResponse.status}` })
      return
    }
    modelBytes = new Uint8Array(await modelResponse.arrayBuffer())
    if (externalFile) {
      const externalResponse = await fetch(`${config.dir}${externalFile}`)
      if (externalResponse.ok) {
        externalBytes = new Uint8Array(await externalResponse.arrayBuffer())
      }
    }
  } catch (cause) {
    send({ type: 'error', reason: 'missing-model', message: describe(cause) })
    return
  }

  try {
    session = await ort.InferenceSession.create(modelBytes, {
      executionProviders,
      externalData:
        externalBytes && externalFile ? [{ path: externalFile, data: externalBytes }] : undefined,
    })
  } catch (cause) {
    send({ type: 'error', reason: 'init-failed', message: describe(cause) })
    return
  }

  inputName = session.inputNames[0]!
  outputName = session.outputNames[0]!
  // DA3's first output is predicted_depth; requesting only it prunes the
  // camera-pose subgraph (bit-identical depth, ~15% cheaper). DA2 has one
  // output, so it runs the default fetch.
  fetches = config.pruneToFirstOutput ? [outputName] : undefined

  // One warm-up run compiles shaders and allocates GPU buffers up front so the
  // first real frame is not janky.
  try {
    await runSession()
  } catch {
    // A failed warm-up is not fatal; the first live frame will surface any real
    // problem through the infer path.
  }

  send({ type: 'ready' })
}

async function infer(bitmap: ImageBitmap): Promise<void> {
  if (!session || !ctx || !inputData || !inputTensor) {
    bitmap.close()
    return
  }

  ctx.drawImage(bitmap, 0, 0, size, size)
  bitmap.close()
  const pixels = ctx.getImageData(0, 0, size, size).data

  // Rescale to [0,1], then ImageNet-normalize into the reused NCHW buffer.
  const buffer = inputData
  for (let i = 0; i < plane; i += 1) {
    const p = i * 4
    buffer[i] = (pixels[p]! / 255 - MEAN[0]) / STD[0]
    buffer[plane + i] = (pixels[p + 1]! / 255 - MEAN[1]) / STD[1]
    buffer[2 * plane + i] = (pixels[p + 2]! / 255 - MEAN[2]) / STD[2]
  }

  let output: Awaited<ReturnType<ort.InferenceSession['run']>>
  try {
    output = await runSession()
  } catch (cause) {
    send({ type: 'error', reason: 'infer-failed', message: describe(cause) })
    return
  }

  const tensor = output[outputName] as ort.Tensor
  const source = tensor.data as Float32Array
  const dims = tensor.dims
  const height = dims.length >= 3 ? Number(dims[dims.length - 2]) : size
  const width = dims.length >= 3 ? Number(dims[dims.length - 1]) : size

  const depth = freeList.pop() ?? new Float32Array(plane)
  if (config.metricToDisparity) {
    // DA3 predicted_depth is metric (near = low). Convert to capped disparity so
    // it matches DA2: near = high, near-field contrast expanded, and no single
    // near/invalid pixel can blow out the downstream min/max auto-range.
    for (let i = 0; i < plane; i += 1) depth[i] = metricToDisparityValue(source[i]!)
  } else {
    depth.set(source.subarray(0, plane))
  }
  send({ type: 'result', depth, width, height }, [depth.buffer])
}

/**
 * Run the session with the current input tensor, requesting only the pruned
 * output list when the model config asks for it. Shared by warm-up and infer.
 */
function runSession(): Promise<ort.InferenceSession.ReturnType> {
  const s = session!
  const feeds = { [inputName]: inputTensor! }
  return fetches ? s.run(feeds, fetches) : s.run(feeds)
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
