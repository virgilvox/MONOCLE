/**
 * Per-model configuration for the live depth worker.
 *
 * The worker runs one of two single-image depth models on onnxruntime-web:
 * Depth Anything V2 Small (the default, fp16 on WebGPU) or Depth Anything 3
 * Small (fp32 only). Their pixel preprocessing is identical (ImageNet-normalized
 * NCHW, square edge a multiple of 14), but four things differ and are captured
 * here so the worker stays a single code path parameterized by config:
 *
 *   - the public directory and ONNX graph file to load,
 *   - the input tensor rank: DA2 is 4D [1,3,H,W], DA3 is 5D [1,1,3,H,W] (the
 *     extra num_images axis), over the same 3*H*W float buffer,
 *   - which outputs to request: DA3 has four (predicted_depth, confidence,
 *     extrinsics, intrinsics); asking for only the first prunes the camera-pose
 *     heads for a correctness-neutral speedup, while DA2 has a single output,
 *   - the depth representation: DA2 predicts disparity (near = high), DA3
 *     predicts metric depth (near = low). DA3 output is converted to disparity
 *     (1/z) so both feed the downstream min/max normalization in the same space:
 *     near = high, with near-field contrast expanded the way DA2's disparity
 *     already is. A plain negation would keep linear depth, which reads flat
 *     next to DA2 and is what made the DA3 preview look worse.
 *
 * This module is pure (no DOM, no ort import) so both the worker and the UI can
 * read it and the tensor-shape / file-selection logic is unit tested.
 */

/** The selectable live-depth models. */
export type LiveDepthModel = 'v2' | 'v3'

export interface LiveDepthModelConfig {
  /** Stable identifier threaded from the UI into the worker init message. */
  id: LiveDepthModel
  /** Short human label for the selector. */
  label: string
  /** Public directory the ONNX files load from, with a trailing slash. */
  dir: string
  /**
   * ONNX graph file to fetch. DA2 has an fp16 export for WebGPU and a
   * full-precision fp32 export for the wasm fallback (whose fp16 support is too
   * weak to rely on). DA3 ships fp32 only, so both paths load the same file.
   */
  modelFile(hasWebGPU: boolean): string
  /**
   * Sibling weights file the graph references via ORT external data, or null
   * when the export is single-file. An fp16 export keeps its weights in a
   * `${modelFile}_data` sibling; the fp32 export is self-contained. This is
   * config-driven rather than probed with a fetch, because under the packaged
   * app:// origin a missing file rejects (ERR_FILE_NOT_FOUND) instead of
   * returning a 404, so a speculative fetch for an absent sibling would throw
   * and be misreported as a missing model.
   */
  externalDataFile(hasWebGPU: boolean): string | null
  /**
   * Input tensor shape for a square `size` edge. DA3 carries an extra leading
   * num_images axis; the backing 3*size*size float buffer is identical.
   */
  inputShape(size: number): number[]
  /**
   * When true, request only the model's first output by name so the exotic
   * camera-pose subgraph (DA3) is pruned. DA2 has a single output and runs the
   * default fetch.
   */
  pruneToFirstOutput: boolean
  /**
   * When true, the model outputs metric depth (near = low), so the worker
   * converts it to disparity (1/z) before the downstream normalization. That
   * matches DA2's native disparity: near = high with near-field contrast
   * expanded, instead of the flat linear ramp a plain negation would give.
   */
  metricToDisparity: boolean
}

const V2: LiveDepthModelConfig = {
  id: 'v2',
  label: 'Depth Anything V2',
  dir: '/models/depth-anything-v2-small/',
  modelFile: (hasWebGPU) => (hasWebGPU ? 'model_fp16.onnx' : 'model_fp32.onnx'),
  // The fp16 export carries its weights in a sibling; the fp32 export is
  // self-contained, so the wasm fallback has no external data to load.
  externalDataFile: (hasWebGPU) => (hasWebGPU ? 'model_fp16.onnx_data' : null),
  inputShape: (size) => [1, 3, size, size],
  pruneToFirstOutput: false,
  metricToDisparity: false,
}

const V3: LiveDepthModelConfig = {
  id: 'v3',
  label: 'Depth Anything 3',
  dir: '/models/depth-anything-v3-small/',
  // fp32 only; the single graph file references model.onnx_data for its weights.
  modelFile: () => 'model.onnx',
  externalDataFile: () => 'model.onnx_data',
  inputShape: (size) => [1, 1, 3, size, size],
  pruneToFirstOutput: true,
  metricToDisparity: true,
}

const CONFIGS: Record<LiveDepthModel, LiveDepthModelConfig> = { v2: V2, v3: V3 }

/** The default live-depth model: DA2 is smaller and fp16-capable on WebGPU. */
export const DEFAULT_LIVE_DEPTH_MODEL: LiveDepthModel = 'v2'

/** Config for a model id, falling back to the default for an unknown value. */
export function liveDepthModelConfig(model: LiveDepthModel): LiveDepthModelConfig {
  return CONFIGS[model] ?? CONFIGS[DEFAULT_LIVE_DEPTH_MODEL]
}

/** The models in selector order, for building a picker. */
export const LIVE_DEPTH_MODELS: readonly LiveDepthModelConfig[] = [V2, V3]

/**
 * Nearest plausible scan distance in metres. Hand-held object scans rarely put
 * anything closer than this to the webcam, so disparity (1/z) is capped at its
 * reciprocal. Without the cap, one near or invalid pixel (a metric depth of a
 * millimetre) inverts to a disparity of ~1000, which dominates the preview's
 * min/max auto-range and collapses the real scene to black.
 */
export const MIN_SCAN_DEPTH_M = 0.2

/** Disparity ceiling derived from {@link MIN_SCAN_DEPTH_M} (1 / 0.2 = 5). */
export const MAX_DISPARITY = 1 / MIN_SCAN_DEPTH_M

/**
 * Convert a metric depth z (metres) to bounded disparity, near = high. Invalid
 * or sub-millimetre depths (0, negative, NaN, from model edges) map to 0 (far),
 * and the result is capped at {@link MAX_DISPARITY} so a single near outlier can
 * not blow out the downstream auto-range. Pure, so it is unit tested against the
 * worker's exact behavior.
 */
export function metricToDisparityValue(z: number): number {
  return z > 1e-3 ? Math.min(1 / z, MAX_DISPARITY) : 0
}
