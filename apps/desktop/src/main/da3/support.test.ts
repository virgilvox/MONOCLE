import { describe, expect, it } from 'vitest'
import { da3Support } from './support'

describe('da3Support', () => {
  it('supports Apple Silicon on macOS 14 or newer (Darwin >= 23)', () => {
    expect(da3Support({ platform: 'darwin', arch: 'arm64', release: '23.5.0' })).toEqual({
      supported: true,
      reason: '',
    })
    expect(da3Support({ platform: 'darwin', arch: 'arm64', release: '24.0.0' }).supported).toBe(
      true,
    )
  })

  it('rejects Apple Silicon on macOS 12/13 (torch has no wheel there)', () => {
    const r = da3Support({ platform: 'darwin', arch: 'arm64', release: '21.6.0' })
    expect(r.supported).toBe(false)
    expect(r.reason).toMatch(/macOS 14/)
  })

  it('rejects Intel Mac (no x86_64 torch wheel)', () => {
    const r = da3Support({ platform: 'darwin', arch: 'x64', release: '23.5.0' })
    expect(r.supported).toBe(false)
    expect(r.reason).toMatch(/Apple Silicon/)
  })

  it('supports 64-bit Windows and Linux, rejects their ARM variants', () => {
    expect(da3Support({ platform: 'win32', arch: 'x64', release: '10.0' }).supported).toBe(true)
    expect(da3Support({ platform: 'linux', arch: 'x64', release: '6.5' }).supported).toBe(true)
    expect(da3Support({ platform: 'win32', arch: 'arm64', release: '10.0' }).supported).toBe(false)
    expect(da3Support({ platform: 'linux', arch: 'arm64', release: '6.5' }).supported).toBe(false)
  })

  it('rejects an unparseable macOS release rather than assuming support', () => {
    expect(da3Support({ platform: 'darwin', arch: 'arm64', release: '' }).supported).toBe(false)
  })
})
