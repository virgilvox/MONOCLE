/**
 * Pure integrity logic for the DA3 pack downloads: pinned-file expectations,
 * the install marker format, and resume-offset math. No IO here; pack.ts wires
 * these to the filesystem and network, so the rules unit-test without either.
 */

/** What we expect of an upstream file, pinned at bundle time. */
export interface PinnedFile {
  name: string
  sizeBytes: number
  /**
   * Hex sha256 of the content, or '' for small non-LFS files where the Hugging
   * Face API publishes no sha256. Those rely on the pinned revision alone; the
   * size still checks.
   */
  sha256: string
}

/** What actually landed on disk, as recorded in the install marker. */
export interface DownloadedFile {
  name: string
  sizeBytes: number
  sha256: string
}

/**
 * Compare a completed download against its pin. Returns a human-readable
 * problem, or null when the file checks out. An empty pinned sha256 skips the
 * hash comparison (no published hash to compare against) but never the size.
 */
export function integrityError(pin: PinnedFile, sizeBytes: number, sha256: string): string | null {
  if (sizeBytes !== pin.sizeBytes) {
    return `${pin.name}: expected ${pin.sizeBytes} bytes, got ${sizeBytes}`
  }
  if (pin.sha256 && sha256 !== pin.sha256) {
    return `${pin.name}: sha256 mismatch (expected ${pin.sha256}, got ${sha256})`
  }
  return null
}

/** Serialize the install marker recording what was verified at install time. */
export function buildMarker(version: number, files: DownloadedFile[]): string {
  return JSON.stringify({ version, files }, null, 2)
}

/**
 * Parse a marker written by buildMarker. Returns null for missing or malformed
 * content and for any other version, so old markers read as not-installed and
 * the pack re-verifies by reinstalling.
 */
export function parseMarker(text: string | null, version: number): DownloadedFile[] | null {
  if (!text) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { version: markerVersion, files } = parsed as { version?: unknown; files?: unknown }
  if (markerVersion !== version || !Array.isArray(files)) return null
  const records: DownloadedFile[] = []
  for (const entry of files) {
    if (typeof entry !== 'object' || entry === null) return null
    const { name, sizeBytes, sha256 } = entry as Record<string, unknown>
    if (typeof name !== 'string' || typeof sizeBytes !== 'number' || typeof sha256 !== 'string') {
      return null
    }
    records.push({ name, sizeBytes, sha256 })
  }
  return records
}

/**
 * A marker matches the current pins when it records exactly the pinned files,
 * each with the pinned size and (where a hash is pinned) the pinned sha256. A
 * marker written against different pins reads as stale, forcing a re-verify.
 */
export function markerMatchesPins(records: DownloadedFile[], pins: PinnedFile[]): boolean {
  if (records.length !== pins.length) return false
  return pins.every((pin) => {
    const record = records.find((r) => r.name === pin.name)
    if (!record || record.sizeBytes !== pin.sizeBytes) return false
    return pin.sha256 === '' || record.sha256 === pin.sha256
  })
}

/**
 * Where a resumed download should continue from. A partial file resumes at its
 * current length; a missing, empty, or full-or-longer file (a prior corrupt
 * download) starts over from zero, which the caller pairs with a truncate.
 */
export function resumeOffset(bytesOnDisk: number | null, expectedBytes: number): number {
  if (bytesOnDisk === null || bytesOnDisk <= 0) return 0
  if (expectedBytes <= 0 || bytesOnDisk >= expectedBytes) return 0
  return bytesOnDisk
}
