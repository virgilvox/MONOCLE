import { describe, expect, it } from 'vitest'
import { clampPercent, formatBytes, formatSpeed, progressLabel } from './updateState'

describe('clampPercent', () => {
  it('rounds to an integer within the bar range', () => {
    expect(clampPercent(0)).toBe(0)
    expect(clampPercent(42.4)).toBe(42)
    expect(clampPercent(99.6)).toBe(100)
  })

  it('clamps out-of-range and non-finite input to the ends', () => {
    expect(clampPercent(-5)).toBe(0)
    expect(clampPercent(140)).toBe(100)
    expect(clampPercent(Number.NaN)).toBe(0)
  })
})

describe('formatBytes', () => {
  it('shows whole bytes and one decimal past a kilobyte', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1_572_864)).toBe('1.5 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3 GB')
  })

  it('reads zero for non-positive or non-finite input', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-10)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})

describe('formatSpeed', () => {
  it('suffixes a byte size with per-second', () => {
    expect(formatSpeed(1_572_864)).toBe('1.5 MB/s')
  })
})

describe('progressLabel', () => {
  it('joins transferred, total, and rate when downloading', () => {
    expect(
      progressLabel({
        percent: 27,
        bytesPerSecond: 1_048_576,
        transferred: 12_582_912,
        total: 47_185_920,
      }),
    ).toBe('12 MB of 45 MB at 1 MB/s')
  })

  it('drops the rate when the download has not started moving', () => {
    expect(
      progressLabel({ percent: 0, bytesPerSecond: 0, transferred: 0, total: 47_185_920 }),
    ).toBe('0 B of 45 MB')
  })
})
