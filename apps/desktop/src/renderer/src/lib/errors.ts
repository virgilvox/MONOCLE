/**
 * Error humanization for the renderer. A sidecar rejection reaches the UI
 * wrapped twice: Electron prefixes "Error invoking remote method '<channel>': "
 * and the rejection itself carries its class name ("RpcError: "). The helpers
 * here strip that plumbing and map known failures to plain guidance, so the raw
 * wrapper never lands in front of the user (the full text stays in the logs).
 */

/** Electron's wrapper around an invoke handler that rejected. */
const IPC_WRAPPER = /^Error invoking remote method '[^']+':\s*/
/** A leading error-class name, e.g. "RpcError: " or a bare "Error: ". */
const CLASS_PREFIX = /^(?:[A-Za-z_$][\w$]*)?Error:\s*/

/**
 * Strip the Electron IPC wrapper and any leading error-class names from a
 * rejection message, leaving the underlying detail. Idempotent, so a message
 * that is already clean passes through unchanged.
 */
export function unwrapIpcError(message: string): string {
  let detail = message.trim().replace(IPC_WRAPPER, '')
  // Class names can nest ("Error: RpcError: ..."), so strip until none remain.
  while (CLASS_PREFIX.test(detail)) detail = detail.replace(CLASS_PREFIX, '')
  return detail.trim()
}

/**
 * Turn a raw reconstruction error into one plain, actionable sentence. Known
 * sidecar failures map to guidance; anything else keeps its unwrapped detail
 * behind a friendly lead-in instead of the raw wrapped string.
 */
export function humanReconstructError(raw: string): string {
  const detail = unwrapIpcError(raw)
  const m = detail.toLowerCase()
  if (m.includes('no frames'))
    return 'No frames to reconstruct yet. Capture a scan or import a video or photos first.'
  if (m.includes('timed out'))
    return 'The reconstruction took too long and was stopped. Try fewer frames, or a faster method in Advanced.'
  if (m.includes('empty mesh'))
    return 'That capture produced no geometry. Try a slower sweep with more overlap and texture.'
  if (m.includes('gaussian') && m.includes('checkpoint'))
    return 'Gaussian splats need the giant Depth Anything 3 checkpoint. Choose it in Advanced.'
  if (m.includes('open3d') || m.includes('no module named') || m.includes('not installed'))
    return 'This method needs components that are not installed in this build. Try the default method.'
  if (!detail) return 'Reconstruction failed.'
  return `Reconstruction failed: ${detail}`
}

/**
 * True when a pack install rejection reports a user cancel rather than a
 * failure. Cancels arrive in two vocabularies: 'cancelled' from runPip and the
 * pre-request abort check, and Node's AbortError ('The operation was aborted')
 * when the abort signal fires mid stream during the weights download.
 */
export function isDa3CancelMessage(raw: string): boolean {
  return /cancel|abort/i.test(raw)
}

/**
 * Turn a Depth Anything 3 pack install error into plain guidance. The install
 * is a large download plus a pip install, so the likely failures are the
 * network, disk space, and pip itself.
 */
export function humanDa3InstallError(raw: string): string {
  const detail = unwrapIpcError(raw)
  const m = detail.toLowerCase()
  if (
    m.includes('network') ||
    m.includes('fetch failed') ||
    m.includes('getaddrinfo') ||
    m.includes('enotfound') ||
    m.includes('econnreset') ||
    m.includes('econnrefused') ||
    m.includes('etimedout') ||
    m.includes('offline')
  )
    return 'The download failed on a network problem. Check your connection and try again.'
  if (m.includes('enospc') || m.includes('no space') || m.includes('disk full'))
    return 'There is not enough disk space for the pack. Free some space and try again.'
  if (m.includes('pip'))
    return 'Installing the Python components failed. Check the Diagnostics log, then try again.'
  if (!detail) return 'The pack install failed.'
  return `The pack install failed: ${detail}`
}
