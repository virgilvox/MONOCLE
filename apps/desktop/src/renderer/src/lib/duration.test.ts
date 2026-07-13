import { describe, expect, it } from 'vitest'
import { estimateRemainingMs, formatDuration } from './duration'

describe('formatDuration', () => {
  it('formats sub-hour durations as m:ss with padded seconds', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(5_000)).toBe('0:05')
    expect(formatDuration(65_000)).toBe('1:05')
    expect(formatDuration(600_000)).toBe('10:00')
  })

  it('formats hour-plus durations as h:mm:ss', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00')
    expect(formatDuration(3_661_000)).toBe('1:01:01')
  })

  it('clamps negative input to zero', () => {
    expect(formatDuration(-500)).toBe('0:00')
  })

  it('floors partial seconds rather than rounding up', () => {
    expect(formatDuration(1_999)).toBe('0:01')
  })
})

describe('estimateRemainingMs', () => {
  it('estimates linearly from elapsed and ratio', () => {
    // Half done in 60s implies about 60s remaining.
    expect(estimateRemainingMs(60_000, 0.5)).toBe(60_000)
    // A quarter done in 30s implies about 90s remaining.
    expect(estimateRemainingMs(30_000, 0.25)).toBe(90_000)
  })

  it('returns null below the low-ratio floor, where estimates swing wildly', () => {
    expect(estimateRemainingMs(1_000, 0.01)).toBeNull()
    expect(estimateRemainingMs(1_000, 0)).toBeNull()
  })

  it('returns null at or past completion', () => {
    expect(estimateRemainingMs(60_000, 1)).toBeNull()
    expect(estimateRemainingMs(60_000, 1.2)).toBeNull()
  })

  it('returns null without any elapsed time', () => {
    expect(estimateRemainingMs(0, 0.5)).toBeNull()
    expect(estimateRemainingMs(-10, 0.5)).toBeNull()
  })
})
