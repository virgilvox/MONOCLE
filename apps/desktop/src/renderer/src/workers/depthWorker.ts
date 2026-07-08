/**
 * Depth inference worker.
 *
 * Runs Depth Anything V2 Small (fp16 ONNX) on a dedicated thread with the
 * onnxruntime-web WebGPU execution provider. It receives camera frames as
 * transferable ImageBitmaps, produces a single-channel depth map, and posts the
 * result back as a transferable Float32Array. Buffers are recycled from the
 * main thread so the steady state does no per-frame allocation.
 *
 * The ort session, the input tensor, and the OffscreenCanvas all live here for
 * the lifetime of the worker. The model and the ort wasm binaries load from the
 * renderer public directory so the app works fully offline under CSP.
 */
import * as ort from 'onnxruntime-web/webgpu'

// ort fetches its wasm binaries from a local path, never a CDN.
ort.env.wasm.wasmPaths = '/models/ort/'

type InitMessage = { type: 'init'; modelUrl: string; inputSize: number }
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
let inputName = ''
let outputName = ''
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
  size = message.inputSize
  plane = size * size
  inputData = new Float32Array(3 * plane)
  inputTensor = new ort.Tensor('float32', inputData, [1, 3, size, size])
  canvas = new OffscreenCanvas(size, size)
  ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    send({ type: 'error', reason: 'init-failed', message: 'no 2d context in worker' })
    return
  }

  let modelBytes: Uint8Array
  let externalBytes: Uint8Array | null = null
  try {
    const modelResponse = await fetch(message.modelUrl)
    if (!modelResponse.ok) {
      send({ type: 'error', reason: 'missing-model', message: `model ${modelResponse.status}` })
      return
    }
    modelBytes = new Uint8Array(await modelResponse.arrayBuffer())
    // The fp16 export keeps its weights in a sibling external-data file.
    const externalResponse = await fetch(`${message.modelUrl}_data`)
    if (externalResponse.ok) {
      externalBytes = new Uint8Array(await externalResponse.arrayBuffer())
    }
  } catch (cause) {
    send({ type: 'error', reason: 'missing-model', message: describe(cause) })
    return
  }

  try {
    session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ['webgpu', 'wasm'],
      externalData: externalBytes
        ? [{ path: 'model_fp16.onnx_data', data: externalBytes }]
        : undefined,
    })
  } catch (cause) {
    send({ type: 'error', reason: 'init-failed', message: describe(cause) })
    return
  }

  inputName = session.inputNames[0]!
  outputName = session.outputNames[0]!

  // One warm-up run compiles shaders and allocates GPU buffers up front so the
  // first real frame is not janky.
  try {
    await session.run({ [inputName]: inputTensor })
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
    output = await session.run({ [inputName]: inputTensor })
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
  depth.set(source.subarray(0, plane))
  send({ type: 'result', depth, width, height }, [depth.buffer])
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
