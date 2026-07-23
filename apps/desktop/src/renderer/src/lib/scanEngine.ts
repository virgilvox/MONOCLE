/**
 * Resolve which reconstruction engine a scan preset will actually run, and name
 * it for the UI. The object-scan card promises "the best method is chosen for
 * your machine"; this module makes that choice visible. It is pure (no store,
 * no DOM) so the capture store and the preset cards share one resolution and
 * the tests can pin it down.
 */

/**
 * Backends whose method is an adaptive multi-view reconstruction, for which the
 * machine's recommendation may stand in. A preset pinned to a different backend
 * for a reason (the single-frame snapshot, the synthetic diagnostic) keeps its
 * own backend, so the recommendation never silently runs the wrong model.
 */
export const ADAPTIVE_BACKENDS = new Set<string>(['depth-anything-3', 'depth-anything-v2-walk'])

/**
 * The backend a preset would run right now. An explicit Advanced pin wins;
 * otherwise the machine's recommendation stands in for an adaptive preset
 * backend, and a purpose-pinned backend keeps itself. This is the capture
 * store's effectiveBackend rule, extracted so the preset cards can apply the
 * exact same resolution per card.
 */
export function resolveScanBackend(
  presetBackend: string,
  backendOverride: string | null,
  recommendedBackend: string | null,
): string {
  if (backendOverride) return backendOverride
  if (recommendedBackend && ADAPTIVE_BACKENDS.has(presetBackend)) return recommendedBackend
  return presetBackend
}

/** Plain engine names for the "Runs:" line on the preset cards. */
const ENGINE_LABELS: Record<string, string> = {
  'depth-anything-3': 'Depth Anything 3',
  'depth-anything-v2-walk': 'Walk-around (Depth Anything V2)',
  'depth-anything-v2-small': 'Depth Anything V2 (single frame)',
  synthetic: 'Synthetic test mesh',
}

/** Human name for a backend id. Falls back to the id for an unknown backend, so
 * a new engine still shows something honest rather than nothing. */
export function engineLabel(backend: string): string {
  return ENGINE_LABELS[backend] ?? backend
}
