import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIVE_DEPTH_MODEL,
  LIVE_DEPTH_MODELS,
  liveDepthModelConfig,
  type LiveDepthModel,
} from './liveDepthModel'

describe('liveDepthModelConfig', () => {
  it('defaults to DA2, the smaller fp16-capable model', () => {
    expect(DEFAULT_LIVE_DEPTH_MODEL).toBe('v2')
  })

  it('falls back to the default for an unknown id', () => {
    const config = liveDepthModelConfig('bogus' as LiveDepthModel)
    expect(config.id).toBe(DEFAULT_LIVE_DEPTH_MODEL)
  })

  it('lists both models in selector order, DA2 first', () => {
    expect(LIVE_DEPTH_MODELS.map((m) => m.id)).toEqual(['v2', 'v3'])
  })
})

describe('DA2 config', () => {
  const v2 = liveDepthModelConfig('v2')

  it('picks fp16 on WebGPU and fp32 on the wasm fallback', () => {
    expect(v2.modelFile(true)).toBe('model_fp16.onnx')
    expect(v2.modelFile(false)).toBe('model_fp32.onnx')
  })

  it('builds a 4D NCHW input tensor shape', () => {
    expect(v2.inputShape(252)).toEqual([1, 3, 252, 252])
  })

  it('runs the default output and keeps native disparity', () => {
    expect(v2.pruneToFirstOutput).toBe(false)
    expect(v2.metricToDisparity).toBe(false)
  })

  it('loads from the DA2 public directory', () => {
    expect(v2.dir).toBe('/models/depth-anything-v2-small/')
  })

  it('declares an external-data sibling only for the fp16 (WebGPU) export', () => {
    // The fp16 export keeps its weights in a sibling; the fp32 wasm-fallback
    // export is single-file. This must be config-driven, not probed by fetch:
    // under the packaged app:// origin a missing sibling rejects rather than
    // 404s, which would be misreported as a missing model on Linux/Pi.
    expect(v2.externalDataFile(true)).toBe('model_fp16.onnx_data')
    expect(v2.externalDataFile(false)).toBeNull()
  })
})

describe('DA3 config', () => {
  const v3 = liveDepthModelConfig('v3')

  it('loads the single fp32 graph on both provider paths', () => {
    expect(v3.modelFile(true)).toBe('model.onnx')
    expect(v3.modelFile(false)).toBe('model.onnx')
  })

  it('adds the num_images axis: 5D input over the same pixel buffer', () => {
    const shape = v3.inputShape(308)
    expect(shape).toEqual([1, 1, 3, 308, 308])
    // Same 3*H*W element count as the DA2 4D tensor for the same edge.
    const elements = shape.reduce((a, b) => a * b, 1)
    expect(elements).toBe(3 * 308 * 308)
  })

  it('prunes to the first output and converts metric depth to disparity', () => {
    expect(v3.pruneToFirstOutput).toBe(true)
    expect(v3.metricToDisparity).toBe(true)
  })

  it('loads from the DA3 public directory', () => {
    expect(v3.dir).toBe('/models/depth-anything-v3-small/')
  })

  it('always declares its external-data sibling (single fp32 graph + weights)', () => {
    expect(v3.externalDataFile(true)).toBe('model.onnx_data')
    expect(v3.externalDataFile(false)).toBe('model.onnx_data')
  })
})
