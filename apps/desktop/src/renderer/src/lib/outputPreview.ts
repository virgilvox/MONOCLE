import type { ReconstructOutput } from '@monoclejs/protocol'

/**
 * How a reconstruction output should be presented in the 3D preview and the
 * result panel. A `mesh` and a `pointCloud` are real three.js geometry the
 * MeshViewer can render, but a Gaussian splat and a COLMAP model are not:
 *
 *   - A Gaussian splat PLY carries per-splat covariance and spherical-harmonic
 *     attributes, not triangles. The mesh viewer's PLYLoader would parse its
 *     vertices and draw a misleading dot cloud, so it is marked non-previewable
 *     and the viewer shows an honest "opens in a splat viewer" state instead.
 *   - A COLMAP result is a sparse-model folder, not a single mesh file, so it
 *     cannot be loaded into the viewer at all.
 *
 * This module is pure (no DOM, no three.js) so the viewer, the panel, and their
 * tests all read the same source of truth for what each output actually is.
 */
export interface OutputPreview {
  /** Whether the three.js MeshViewer can render this output as geometry. */
  previewable: boolean
  /** Honest short title for a non-previewable output's overlay. */
  label: string
  /** Secondary line explaining what the output is and how to open it. */
  hint: string
  /**
   * What the result's primary count counts for this output: `vertices` for a
   * mesh, `points` for a point cloud, `splats` for a Gaussian splat. Null when
   * the output has no meaningful vertex count to show (COLMAP), so the panel can
   * omit a misleading zero rather than print one.
   */
  countNoun: string | null
  /** Whether a triangle count is meaningful. Only a mesh has triangles. */
  hasTriangles: boolean
}

const PREVIEWS: Record<ReconstructOutput, OutputPreview> = {
  mesh: {
    previewable: true,
    label: 'Mesh',
    hint: '',
    countNoun: 'vertices',
    hasTriangles: true,
  },
  pointCloud: {
    previewable: true,
    label: 'Point cloud',
    hint: '',
    countNoun: 'points',
    hasTriangles: false,
  },
  gaussian: {
    previewable: false,
    label: 'Gaussian splat',
    hint: 'Not a standard mesh. Save it and open it in a Gaussian splat viewer.',
    countNoun: 'splats',
    hasTriangles: false,
  },
  colmap: {
    previewable: false,
    label: 'COLMAP model',
    hint: 'Not previewable. Saved as a folder for other photogrammetry tools.',
    countNoun: null,
    hasTriangles: false,
  },
}

/**
 * Presentation facts for an output kind, falling back to `mesh` for an unknown
 * value so a new backend product never renders as a blank or misleading preview.
 */
export function outputPreview(output: ReconstructOutput | undefined): OutputPreview {
  return (output && PREVIEWS[output]) || PREVIEWS.mesh
}
