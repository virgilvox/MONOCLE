import { describe, expect, it } from 'vitest'
import { formatFromPath } from './meshFormat'

describe('formatFromPath', () => {
  it('recognizes GLB and GLTF extensions', () => {
    expect(formatFromPath('/tmp/out/preview.glb')).toBe('glb')
    expect(formatFromPath('/tmp/out/scene.gltf')).toBe('glb')
  })

  it('recognizes PLY', () => {
    expect(formatFromPath('/tmp/out/cloud.ply')).toBe('ply')
  })

  it('is case-insensitive', () => {
    expect(formatFromPath('C:\\out\\MESH.GLB')).toBe('glb')
    expect(formatFromPath('/tmp/out/CLOUD.PLY')).toBe('ply')
  })

  it('falls back to STL for anything else', () => {
    expect(formatFromPath('/tmp/out/mesh.stl')).toBe('stl')
    expect(formatFromPath('/tmp/out/mesh.obj')).toBe('stl')
  })
})
