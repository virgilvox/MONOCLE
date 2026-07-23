/**
 * Output products and the Depth Anything 3 checkpoint vocabulary. The rich
 * outputs (point cloud, splat, COLMAP) are native to DA3, so the tables and the
 * coercion rule that gate them live together here, pure and unit-testable.
 */

import type { ReconstructOutput } from '@monoclejs/protocol'

/** The backend id whose model has selectable checkpoint sizes. */
export const DA3_BACKEND = 'depth-anything-3'

/** Depth Anything 3 checkpoint sizes. BASE is Apache-2.0; the others are
 * heavier and CC-BY-NC (non-commercial), so they are opt-in. */
export const DA3_SIZES: { id: string; label: string; note?: string }[] = [
  { id: 'base', label: 'Base', note: 'Apache-2.0' },
  { id: 'large', label: 'Large', note: 'non-commercial, slower' },
  { id: 'giant', label: 'Giant', note: 'non-commercial, slowest' },
]

/** The DA3 checkpoint the Gaussian-splat output needs. */
export const GAUSSIAN_CHECKPOINT = 'giant'

/**
 * Output products a reconstruction can yield. `mesh` runs on any backend; the
 * richer products are native to Depth Anything 3, so they are gated behind it.
 * `gaussian` additionally needs the giant (non-commercial) checkpoint.
 */
export const OUTPUT_KINDS: {
  id: ReconstructOutput
  label: string
  note: string
  richOnly?: boolean
  needsGiant?: boolean
}[] = [
  { id: 'mesh', label: 'Mesh', note: 'Watertight and printable. Works with any model.' },
  {
    id: 'pointCloud',
    label: 'Point cloud',
    note: 'Colored points. Needs Depth Anything 3.',
    richOnly: true,
  },
  {
    id: 'gaussian',
    label: 'Gaussian splat',
    note: 'Needs the giant (non-commercial) Depth Anything 3 checkpoint.',
    richOnly: true,
    needsGiant: true,
  },
  {
    id: 'colmap',
    label: 'COLMAP model',
    note: 'Sparse model for other tools. Needs Depth Anything 3.',
    richOnly: true,
  },
]

/**
 * Coerce an output kind to what the selected backend and checkpoint can actually
 * produce. Only Depth Anything 3 emits the rich products (point cloud, splat,
 * COLMAP), and a Gaussian splat additionally needs the giant checkpoint, so a
 * stale gaussian pick on a base checkpoint never reaches (and is rejected by) the
 * sidecar. Pure so the store and its tests share it.
 */
export function coerceOutput(
  backend: string,
  output: ReconstructOutput,
  checkpoint: string,
): ReconstructOutput {
  if (backend !== DA3_BACKEND) return 'mesh'
  if (output === 'gaussian' && checkpoint !== GAUSSIAN_CHECKPOINT) return 'mesh'
  return output
}
