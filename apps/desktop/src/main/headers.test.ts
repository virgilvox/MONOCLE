import { describe, expect, it } from 'vitest'
import { crossOriginIsolationHeaders } from './headers'

describe('crossOriginIsolationHeaders', () => {
  it('sets the COOP/COEP pair that makes crossOriginIsolated true', () => {
    const headers = crossOriginIsolationHeaders()
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin')
    expect(headers['Cross-Origin-Embedder-Policy']).toBe('require-corp')
  })

  it('lets same-origin subresources satisfy COEP', () => {
    expect(crossOriginIsolationHeaders()['Cross-Origin-Resource-Policy']).toBe('same-origin')
  })

  it('returns only plain string values so it merges into either header sink', () => {
    for (const value of Object.values(crossOriginIsolationHeaders())) {
      expect(typeof value).toBe('string')
    }
  })
})
