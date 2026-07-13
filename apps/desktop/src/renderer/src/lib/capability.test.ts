import { describe, expect, it } from 'vitest'
import {
  assessMethods,
  describeMachine,
  deviceAvailable,
  livePreviewSupport,
  recommendedDefault,
  threadedWasmAvailable,
  toComputeDevice,
  type MachineProfile,
} from './capability'

const cudaBox: MachineProfile = {
  torchDevice: 'cuda',
  webgpu: true,
  webgl2: true,
  crossOriginIsolated: true,
}
const macBox: MachineProfile = {
  torchDevice: 'mps',
  webgpu: true,
  webgl2: true,
  crossOriginIsolated: true,
}
// A CPU-only box with no WebGPU but cross-origin isolation on: the wasm fallback
// gets threads.
const cpuBox: MachineProfile = {
  torchDevice: 'cpu',
  webgpu: false,
  webgl2: true,
  crossOriginIsolated: true,
}
// Same class of machine but without isolation, so the wasm fallback is single
// threaded.
const cpuBoxNoIsolation: MachineProfile = {
  torchDevice: 'cpu',
  webgpu: false,
  webgl2: true,
  crossOriginIsolated: false,
}
const pi: MachineProfile = {
  torchDevice: 'cpu',
  webgpu: false,
  webgl2: false,
  crossOriginIsolated: false,
}

describe('recommendedDefault', () => {
  it('defaults to DA3 when a GPU makes it pleasant', () => {
    expect(recommendedDefault(cudaBox)).toBe('depth-anything-3')
    expect(recommendedDefault(macBox)).toBe('depth-anything-3')
  })

  it('falls back to the faster walk-around on a CPU-only box', () => {
    expect(recommendedDefault(cpuBox)).toBe('depth-anything-v2-walk')
  })
})

describe('assessMethods', () => {
  it('rates DA3 slow on CPU and fast on CUDA, with a heads-up note', () => {
    const cpu = assessMethods(cpuBox).find((m) => m.backend === 'depth-anything-3')!
    expect(cpu.speed).toBe('slow')
    expect(cpu.note.toLowerCase()).toContain('slow')

    const cuda = assessMethods(cudaBox).find((m) => m.backend === 'depth-anything-3')!
    expect(cuda.speed).toBe('fast')
  })

  it('always offers the quick snapshot as a fast option', () => {
    for (const profile of [cudaBox, macBox, cpuBox]) {
      const snap = assessMethods(profile).find((m) => m.backend === 'depth-anything-v2-small')!
      expect(snap.speed).toBe('fast')
    }
  })

  it('rates the walk-around at least moderate on every machine', () => {
    for (const profile of [cudaBox, macBox, cpuBox]) {
      const walk = assessMethods(profile).find((m) => m.backend === 'depth-anything-v2-walk')!
      expect(['fast', 'moderate']).toContain(walk.speed)
    }
  })
})

describe('livePreviewSupport', () => {
  it('is fast on WebGPU, slow on WebGL2 only, unavailable without either', () => {
    expect(livePreviewSupport(cudaBox).speed).toBe('fast')
    expect(livePreviewSupport(cpuBox).speed).toBe('slow')
    expect(livePreviewSupport(pi).speed).toBe('unavailable')
  })

  it('notes multi-threaded wasm on an isolated non-WebGPU box', () => {
    expect(livePreviewSupport(cpuBox).note.toLowerCase()).toContain('thread')
    expect(livePreviewSupport(cpuBoxNoIsolation).note.toLowerCase()).not.toContain('thread')
  })
})

describe('threadedWasmAvailable', () => {
  it('is true only without WebGPU and with cross-origin isolation', () => {
    expect(threadedWasmAvailable(cpuBox)).toBe(true)
    expect(threadedWasmAvailable(cpuBoxNoIsolation)).toBe(false)
    // WebGPU boxes use the GPU path; threads would only spin up an unused pool.
    expect(threadedWasmAvailable(cudaBox)).toBe(false)
  })
})

describe('describeMachine', () => {
  it('summarizes both compute tiers in one line', () => {
    expect(describeMachine(macBox)).toBe('Apple GPU reconstruction, WebGPU preview')
    expect(describeMachine(pi)).toBe('CPU only reconstruction, no GPU preview')
  })
})

describe('deviceAvailable', () => {
  it('always offers auto and cpu, and a GPU only when the machine reports it', () => {
    expect(deviceAvailable('auto', cpuBox)).toBe(true)
    expect(deviceAvailable('cpu', cpuBox)).toBe(true)
    expect(deviceAvailable('cuda', cpuBox)).toBe(false)
    expect(deviceAvailable('cuda', cudaBox)).toBe(true)
    expect(deviceAvailable('mps', macBox)).toBe(true)
    expect(deviceAvailable('mps', cudaBox)).toBe(false)
  })
})

describe('toComputeDevice', () => {
  it('passes known devices through and maps anything else to unknown', () => {
    expect(toComputeDevice('mps')).toBe('mps')
    expect(toComputeDevice('cuda')).toBe('cuda')
    expect(toComputeDevice('cpu')).toBe('cpu')
    expect(toComputeDevice('rocm')).toBe('unknown')
    expect(toComputeDevice(null)).toBe('unknown')
  })
})
