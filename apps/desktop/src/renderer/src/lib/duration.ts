/**
 * Small pure helpers for showing how long a run has taken and how much longer
 * it may take. Kept free of Vue and the DOM so the formatting and the estimate
 * are unit tested in isolation; the ticking clock lives in useElapsed.
 */

/** Format a millisecond duration as m:ss, or h:mm:ss past an hour. Clamps to 0. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const ss = String(seconds).padStart(2, '0')
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`
  return `${minutes}:${ss}`
}

/**
 * Estimate the milliseconds remaining from the elapsed time and a completion
 * ratio in [0,1], assuming a roughly linear rate. Returns null when there is
 * not enough signal for a meaningful estimate: a ratio at or below a small
 * floor (the first few percent swing wildly) or at/above completion.
 */
export function estimateRemainingMs(elapsedMs: number, ratio: number): number | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null
  if (!Number.isFinite(ratio) || ratio < 0.05 || ratio >= 1) return null
  return Math.round((elapsedMs * (1 - ratio)) / ratio)
}
