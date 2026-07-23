/** Viewer formats the mesh preview can load. */
export type MeshFormat = 'stl' | 'ply' | 'glb'

/** Pick the viewer format from an artifact path's extension. Pure and free of
 * three.js, so the capture store can use it without dragging the viewer's
 * loaders into its import graph. */
export function formatFromPath(path: string): MeshFormat {
  const lower = path.toLowerCase()
  if (lower.endsWith('.glb') || lower.endsWith('.gltf')) return 'glb'
  if (lower.endsWith('.ply')) return 'ply'
  return 'stl'
}
