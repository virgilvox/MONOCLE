import { describe, expect, it } from 'vitest'
import {
  buildMarker,
  integrityError,
  markerMatchesPins,
  parseMarker,
  resumeOffset,
  type DownloadedFile,
  type PinnedFile,
} from './integrity'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const WEIGHTS: PinnedFile = { name: 'model.safetensors', sizeBytes: 1000, sha256: HASH_A }
const CONFIG: PinnedFile = { name: 'config.json', sizeBytes: 12, sha256: '' }

describe('integrityError', () => {
  it('accepts a matching size and hash', () => {
    expect(integrityError(WEIGHTS, 1000, HASH_A)).toBeNull()
  })

  it('rejects a size mismatch before looking at the hash', () => {
    expect(integrityError(WEIGHTS, 999, HASH_A)).toMatch(/expected 1000 bytes, got 999/)
  })

  it('rejects a hash mismatch at the right size', () => {
    expect(integrityError(WEIGHTS, 1000, HASH_B)).toMatch(/sha256 mismatch/)
  })

  it('skips the hash comparison, but not the size, when no hash is pinned', () => {
    expect(integrityError(CONFIG, 12, HASH_B)).toBeNull()
    expect(integrityError(CONFIG, 13, HASH_B)).toMatch(/expected 12 bytes/)
  })
})

describe('marker round trip', () => {
  const files: DownloadedFile[] = [
    { name: 'config.json', sizeBytes: 12, sha256: HASH_B },
    { name: 'model.safetensors', sizeBytes: 1000, sha256: HASH_A },
  ]

  it('parses what buildMarker wrote', () => {
    expect(parseMarker(buildMarker(2, files), 2)).toEqual(files)
  })

  it('rejects a marker from another version, so old installs re-verify', () => {
    expect(parseMarker(buildMarker(1, files), 2)).toBeNull()
  })

  it('rejects missing or malformed content', () => {
    expect(parseMarker(null, 2)).toBeNull()
    expect(parseMarker('', 2)).toBeNull()
    expect(parseMarker('not json', 2)).toBeNull()
    expect(parseMarker('[]', 2)).toBeNull()
    expect(parseMarker('{"version":2}', 2)).toBeNull()
    expect(parseMarker('{"version":2,"files":[{"name":"x"}]}', 2)).toBeNull()
    expect(parseMarker('{"version":2,"files":[null]}', 2)).toBeNull()
  })
})

describe('markerMatchesPins', () => {
  const pins = [CONFIG, WEIGHTS]
  const configRecord: DownloadedFile = { name: 'config.json', sizeBytes: 12, sha256: HASH_B }
  const weightsRecord: DownloadedFile = {
    name: 'model.safetensors',
    sizeBytes: 1000,
    sha256: HASH_A,
  }
  const records = [configRecord, weightsRecord]

  it('matches records that agree with the pins, in any order', () => {
    expect(markerMatchesPins(records, pins)).toBe(true)
    expect(markerMatchesPins([...records].reverse(), pins)).toBe(true)
  })

  it('accepts any recorded hash for a pin without one', () => {
    // config.json has no pinned sha256; the recorded install-time hash may be anything.
    expect(markerMatchesPins(records, pins)).toBe(true)
  })

  it('rejects a missing, resized, or rehashed file', () => {
    expect(markerMatchesPins([weightsRecord], pins)).toBe(false)
    expect(markerMatchesPins([configRecord, { ...weightsRecord, sizeBytes: 999 }], pins)).toBe(
      false,
    )
    expect(markerMatchesPins([configRecord, { ...weightsRecord, sha256: HASH_B }], pins)).toBe(
      false,
    )
  })

  it('rejects extra records, so a stale marker never over-claims', () => {
    expect(markerMatchesPins([...records, { name: 'extra', sizeBytes: 1, sha256: '' }], pins)).toBe(
      false,
    )
  })
})

describe('resumeOffset', () => {
  it('resumes a partial file at its current length', () => {
    expect(resumeOffset(1, 1000)).toBe(1)
    expect(resumeOffset(999, 1000)).toBe(999)
  })

  it('starts over for a missing or empty file', () => {
    expect(resumeOffset(null, 1000)).toBe(0)
    expect(resumeOffset(0, 1000)).toBe(0)
  })

  it('starts over for a full-or-longer file (a prior corrupt download)', () => {
    expect(resumeOffset(1000, 1000)).toBe(0)
    expect(resumeOffset(1001, 1000)).toBe(0)
  })

  it('never resumes against an unknown expected size', () => {
    expect(resumeOffset(500, 0)).toBe(0)
  })
})
