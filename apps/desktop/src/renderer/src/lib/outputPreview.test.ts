import { describe, expect, it } from 'vitest'
import type { ReconstructOutput } from '@monoclejs/protocol'
import { outputPreview } from './outputPreview'

describe('outputPreview', () => {
  it('marks a mesh previewable with vertices and triangles', () => {
    const p = outputPreview('mesh')
    expect(p.previewable).toBe(true)
    expect(p.countNoun).toBe('vertices')
    expect(p.hasTriangles).toBe(true)
  })

  it('marks a point cloud previewable, counting points without triangles', () => {
    const p = outputPreview('pointCloud')
    expect(p.previewable).toBe(true)
    expect(p.countNoun).toBe('points')
    expect(p.hasTriangles).toBe(false)
  })

  it('marks a Gaussian splat non-previewable and points to a splat viewer', () => {
    const p = outputPreview('gaussian')
    expect(p.previewable).toBe(false)
    expect(p.label).toBe('Gaussian splat')
    expect(p.hint.toLowerCase()).toContain('splat viewer')
    // Splats still carry a count, but no triangles.
    expect(p.countNoun).toBe('splats')
    expect(p.hasTriangles).toBe(false)
  })

  it('marks a COLMAP model non-previewable, folder-based, with no count', () => {
    const p = outputPreview('colmap')
    expect(p.previewable).toBe(false)
    expect(p.label).toBe('COLMAP model')
    expect(p.hint.toLowerCase()).toContain('folder')
    // A sparse model has no single vertex count worth printing.
    expect(p.countNoun).toBeNull()
    expect(p.hasTriangles).toBe(false)
  })

  it('falls back to mesh for an undefined or unknown output', () => {
    expect(outputPreview(undefined).previewable).toBe(true)
    expect(outputPreview('bogus' as ReconstructOutput).label).toBe('Mesh')
  })

  it('never claims triangles for a non-mesh output', () => {
    const nonMesh: ReconstructOutput[] = ['pointCloud', 'gaussian', 'colmap']
    for (const kind of nonMesh) expect(outputPreview(kind).hasTriangles).toBe(false)
  })
})
