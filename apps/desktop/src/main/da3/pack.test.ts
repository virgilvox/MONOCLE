import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Da3Pack } from './pack'
import type { Da3Platform } from './support'

const BASE = join('/data', 'da3')
const SUPPORTED: Da3Platform = { platform: 'darwin', arch: 'arm64', release: '23.5.0' }

/** An `exists` that returns true only for the given set of paths. */
function existsFor(present: string[]): (path: string) => boolean {
  const set = new Set(present)
  return (path) => set.has(path)
}

const marker = join(BASE, 'installed.json')
const torch = join(BASE, 'site-packages', 'torch')
const weights = join(BASE, 'models', 'da3-base', 'model.safetensors')
const pkgs = join(BASE, 'site-packages')
const modelDir = join(BASE, 'models', 'da3-base')

function pack(exists: (path: string) => boolean, platform = SUPPORTED): Da3Pack {
  return new Da3Pack(BASE, '/py/bin/python3', '/sidecar', platform, exists)
}

describe('Da3Pack.isInstalled', () => {
  it('is false until the marker, torch, and weights are all present', () => {
    expect(pack(existsFor([])).isInstalled()).toBe(false)
    expect(pack(existsFor([marker])).isInstalled()).toBe(false)
    expect(pack(existsFor([marker, torch])).isInstalled()).toBe(false)
    expect(pack(existsFor([marker, torch, weights])).isInstalled()).toBe(true)
  })
})

describe('Da3Pack.status', () => {
  it('reports supported and not-installed on a capable machine with no pack', () => {
    const s = pack(existsFor([])).status()
    expect(s).toMatchObject({ installed: false, installing: false, supported: true, reason: '' })
    expect(s.sizeEstimateBytes).toBeGreaterThan(0)
  })

  it('reports the reason and not-supported on an incapable machine', () => {
    const s = pack(existsFor([]), { platform: 'darwin', arch: 'arm64', release: '21.6.0' }).status()
    expect(s.supported).toBe(false)
    expect(s.reason).toMatch(/macOS 14/)
  })
})

describe('Da3Pack.env', () => {
  it('contributes nothing until the pack is installed', () => {
    expect(pack(existsFor([])).env()).toEqual({})
  })

  it('adds the pack to PYTHONPATH and points MONOCLE_DA3_CKPT at the weights', () => {
    const env = pack(existsFor([marker, torch, weights])).env()
    expect(env.PYTHONPATH).toBe(pkgs)
    expect(env.MONOCLE_DA3_CKPT).toBe(modelDir)
  })

  it('prepends the pack to an inherited PYTHONPATH so its torch wins', () => {
    const env = pack(existsFor([marker, torch, weights])).env({ PYTHONPATH: '/other' })
    expect(env.PYTHONPATH).toBe(`${pkgs}${delimiter}/other`)
  })
})
