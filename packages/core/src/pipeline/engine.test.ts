import { describe, expect, it } from 'vitest'
import { ScanEngine } from './engine'
import type { FusionVolume, GeometryStage, Mesher, PoseEstimator, ScanBackends } from './stages'
import { identity } from '../math/mat4'
import type { Frame } from '../types/frame'
import type { Mesh } from '../types/mesh'

function makeBackends(overrides: Partial<ScanBackends> = {}): {
  backends: ScanBackends
  fusion: FusionVolume & { integrated: number[] }
} {
  const pose: PoseEstimator = {
    name: 'fake-pose',
    estimate: async () => ({ pose: identity(), confidence: 0.9 }),
  }
  const geometry: GeometryStage = {
    name: 'fake-geometry',
    compute: async () => ({ depth: new Float32Array([1, 1, 1, 1]) }),
  }
  const integrated: number[] = []
  const fusion: FusionVolume & { integrated: number[] } = {
    name: 'fake-fusion',
    integrated,
    integratedCount: 0,
    integrate: async (frame: Frame) => {
      integrated.push(frame.id)
    },
    reset: () => {
      integrated.length = 0
    },
  }
  const mesher: Mesher = {
    name: 'fake-mesher',
    extract: async (): Promise<Mesh> => ({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    }),
  }
  return { backends: { pose, geometry, fusion, mesher, ...overrides }, fusion }
}

async function* frames(count: number): AsyncGenerator<Frame> {
  for (let id = 0; id < count; id++) {
    yield { id, t: id * 33, image: null }
  }
}

describe('ScanEngine', () => {
  it('runs frames through every stage and returns a mesh', async () => {
    const { backends, fusion } = makeBackends()
    const engine = new ScanEngine(backends)

    const progress: number[] = []
    engine.on('progress', (p) => progress.push(p.integrated))

    const mesh = await engine.run(frames(3))

    expect(fusion.integrated).toEqual([0, 1, 2])
    expect(progress.at(-1)).toBe(3)
    expect(mesh.indices).toEqual(new Uint32Array([0, 1, 2]))
  })

  it('skips frames below the confidence threshold', async () => {
    const { backends, fusion } = makeBackends({
      pose: {
        name: 'low-confidence',
        estimate: async () => ({ pose: identity(), confidence: 0.2 }),
      },
    })
    const engine = new ScanEngine(backends)
    await engine.run(frames(3), { minPoseConfidence: 0.5 })
    expect(fusion.integrated).toEqual([])
  })

  it('reports per-frame errors without aborting the session', async () => {
    const { backends, fusion } = makeBackends({
      geometry: {
        name: 'flaky-geometry',
        compute: async (frame: Frame) => {
          if (frame.id === 1) throw new Error('boom')
          return { depth: new Float32Array([1]) }
        },
      },
    })
    const engine = new ScanEngine(backends)
    const errors: number[] = []
    engine.on('error', (e) => errors.push(e.frameId ?? -1))

    await engine.run(frames(3))

    expect(errors).toEqual([1])
    expect(fusion.integrated).toEqual([0, 2])
  })
})
