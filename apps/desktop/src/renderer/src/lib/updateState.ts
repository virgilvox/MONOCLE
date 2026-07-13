/**
 * Small pure helpers for the update banner: clamping the download percentage and
 * formatting byte counts and rates for display. Kept free of Vue and the DOM so
 * the formatting is unit tested in isolation; the banner owns the reactive state.
 */
import type { UpdateDownloadProgress } from '../../../shared/ipc'

/** Clamp a raw percentage to an integer in [0, 100]. Non-finite input reads 0. */
export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.min(100, Math.max(0, Math.round(percent)))
}

/** Format a byte count as B / KB / MB / GB with one decimal past a kilobyte. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** exponent
  const rounded = exponent === 0 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[exponent]}`
}

/** Format a transfer rate as a per-second byte size, e.g. "1.2 MB/s". */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

/**
 * A one-line summary of download progress: transferred of total, plus the
 * current rate when it is moving, e.g. "12.3 MB of 45 MB at 1.2 MB/s".
 */
export function progressLabel(progress: UpdateDownloadProgress): string {
  const size = `${formatBytes(progress.transferred)} of ${formatBytes(progress.total)}`
  if (!Number.isFinite(progress.bytesPerSecond) || progress.bytesPerSecond <= 0) return size
  return `${size} at ${formatSpeed(progress.bytesPerSecond)}`
}
