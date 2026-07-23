import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Da3Pack, DA3_WEIGHTS_FILES, MARKER_VERSION, type PackFileSystem } from './pack'
import { buildMarker, type DownloadedFile } from './integrity'
import type { Da3Platform } from './support'

const BASE = join('/data', 'da3')
const SUPPORTED: Da3Platform = { platform: 'darwin', arch: 'arm64', release: '23.5.0' }

const marker = join(BASE, 'installed.json')
const torch = join(BASE, 'site-packages', 'torch')
const pkgs = join(BASE, 'site-packages')
const modelDir = join(BASE, 'models', 'da3-base')

/** Marker records as a verified install would have written them. */
const RECORDS: DownloadedFile[] = DA3_WEIGHTS_FILES.map((pin) => ({
  name: pin.name,
  sizeBytes: pin.sizeBytes,
  // config.json has no pinned hash; the install records whatever it computed.
  sha256: pin.sha256 || 'c'.repeat(64),
}))
const MARKER_TEXT = buildMarker(MARKER_VERSION, RECORDS)

/** A fake filesystem: paths map to a file's text and size (or {} for a dir). */
function fsFor(entries: Record<string, { text?: string; size?: number }>): PackFileSystem {
  return {
    exists: (path) => path in entries,
    readText: (path) => entries[path]?.text ?? null,
    fileSize: (path) => entries[path]?.size ?? null,
  }
}

/** The full on-disk state of a good install. */
function installedEntries(): Record<string, { text?: string; size?: number }> {
  const entries: Record<string, { text?: string; size?: number }> = {
    [marker]: { text: MARKER_TEXT },
    [torch]: {},
  }
  for (const record of RECORDS) {
    entries[join(modelDir, record.name)] = { size: record.sizeBytes }
  }
  return entries
}

function pack(fs: PackFileSystem, platform = SUPPORTED): Da3Pack {
  return new Da3Pack(BASE, '/py/bin/python3', '/sidecar', platform, fs)
}

describe('Da3Pack.isInstalled', () => {
  it('is true when torch, a matching marker, and full-size weights are present', () => {
    expect(pack(fsFor(installedEntries())).isInstalled()).toBe(true)
  })

  it('is false while pieces are missing', () => {
    expect(pack(fsFor({})).isInstalled()).toBe(false)
    expect(pack(fsFor({ [marker]: { text: MARKER_TEXT } })).isInstalled()).toBe(false)
    expect(pack(fsFor({ [marker]: { text: MARKER_TEXT }, [torch]: {} })).isInstalled()).toBe(false)
  })

  it('is false when a weights file is truncated, even with a valid marker', () => {
    const entries = installedEntries()
    entries[join(modelDir, 'model.safetensors')] = { size: 12345 }
    expect(pack(fsFor(entries)).isInstalled()).toBe(false)
  })

  it('is false for a version 1 marker, so unverified installs re-verify', () => {
    const entries = installedEntries()
    entries[marker] = {
      text: JSON.stringify({ version: 1, files: ['config.json', 'model.safetensors'] }),
    }
    expect(pack(fsFor(entries)).isInstalled()).toBe(false)
  })

  it('is false when the marker disagrees with the current pins', () => {
    const entries = installedEntries()
    const stale = RECORDS.map((record) =>
      record.name === 'model.safetensors' ? { ...record, sha256: 'd'.repeat(64) } : record,
    )
    entries[marker] = { text: buildMarker(MARKER_VERSION, stale) }
    expect(pack(fsFor(entries)).isInstalled()).toBe(false)
  })

  it('is false for an unreadable or corrupt marker', () => {
    const entries = installedEntries()
    entries[marker] = { text: 'not json' }
    expect(pack(fsFor(entries)).isInstalled()).toBe(false)
  })
})

describe('Da3Pack.status', () => {
  it('reports supported and not-installed on a capable machine with no pack', () => {
    const s = pack(fsFor({})).status()
    expect(s).toMatchObject({ installed: false, installing: false, supported: true, reason: '' })
    expect(s.sizeEstimateBytes).toBeGreaterThan(0)
  })

  it('reports the reason and not-supported on an incapable machine', () => {
    const s = pack(fsFor({}), { platform: 'darwin', arch: 'arm64', release: '21.6.0' }).status()
    expect(s.supported).toBe(false)
    expect(s.reason).toMatch(/macOS 14/)
  })
})

describe('Da3Pack.env', () => {
  it('contributes nothing until the pack is installed', () => {
    expect(pack(fsFor({})).env()).toEqual({})
  })

  it('adds the pack to PYTHONPATH and points MONOCLE_DA3_CKPT at the weights', () => {
    const env = pack(fsFor(installedEntries())).env()
    expect(env.PYTHONPATH).toBe(pkgs)
    expect(env.MONOCLE_DA3_CKPT).toBe(modelDir)
  })

  it('prepends the pack to an inherited PYTHONPATH so its torch wins', () => {
    const env = pack(fsFor(installedEntries())).env({ PYTHONPATH: '/other' })
    expect(env.PYTHONPATH).toBe(`${pkgs}${delimiter}/other`)
  })
})
