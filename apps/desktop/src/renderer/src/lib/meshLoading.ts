/**
 * Parses reconstruction artifacts (STL, PLY, GLB) into three.js content for the
 * viewer. Only the format handling lives here; the scene lifecycle, materials,
 * and mounting stay in MeshViewer, which passes its material factories in.
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import type { MeshFormat } from './meshFormat'

/** What a parse yields: shaded content, point content, or (for a pure point
 * cloud) points only. Either side can be null, never both on success. */
export interface MeshContent {
  mesh: THREE.Object3D | null
  points: THREE.Points | null
}

export interface MeshLoadHandlers {
  /** Material for shaded geometry (PLY with faces, STL). */
  makeMeshMaterial: () => THREE.Material
  /** Material for a pure point cloud, sized and colored per the geometry. */
  makePointsMaterial: (geometry: THREE.BufferGeometry) => THREE.Material
  /** Parsed content, ready to mount. GLB delivers this asynchronously. */
  onLoad: (content: MeshContent) => void
  /** Corrupt or truncated artifact: nothing to mount. */
  onError: () => void
}

/**
 * Parse artifact bytes in the given format and deliver the result through the
 * handlers. PLY and STL parse synchronously; GLB parses through GLTFLoader's
 * callback, so the caller must guard onLoad/onError against a newer load (or an
 * unmount) having superseded this one.
 */
export function loadMeshArtifact(
  bytes: Uint8Array,
  format: MeshFormat,
  handlers: MeshLoadHandlers,
): void {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer

  if (format === 'glb') {
    new GLTFLoader().parse(
      buffer,
      '',
      (gltf) => handlers.onLoad({ mesh: gltf.scene, points: null }),
      () => handlers.onError(),
    )
    return
  }

  if (format === 'ply') {
    try {
      const geometry = new PLYLoader().parse(buffer)
      const hasFaces = geometry.index !== null && geometry.index.count > 0
      if (hasFaces) {
        geometry.computeVertexNormals()
        handlers.onLoad({
          mesh: new THREE.Mesh(geometry, handlers.makeMeshMaterial()),
          points: null,
        })
      } else {
        // A pure point cloud has no shaded representation.
        handlers.onLoad({
          mesh: null,
          points: new THREE.Points(geometry, handlers.makePointsMaterial(geometry)),
        })
      }
    } catch {
      // Corrupt or truncated artifact: surface the "could not load" state.
      handlers.onError()
    }
    return
  }

  try {
    const geometry = new STLLoader().parse(buffer)
    geometry.computeVertexNormals()
    handlers.onLoad({ mesh: new THREE.Mesh(geometry, handlers.makeMeshMaterial()), points: null })
  } catch {
    handlers.onError()
  }
}
