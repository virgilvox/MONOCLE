/**
 * The typed contract between the MONOCLE app and the Python inference sidecar.
 * The sidecar's registry mirrors these shapes. Keep both sides in step and bump
 * PROTOCOL_VERSION on any breaking change so the app can refuse a mismatch.
 */

export const PROTOCOL_VERSION = 1

/** Request methods the app sends to the sidecar. */
export const SidecarMethod = {
  Health: 'health',
  ListBackends: 'listBackends',
  Reconstruct: 'reconstruct',
  Cancel: 'cancel',
} as const

/** Notification methods the sidecar streams back to the app. */
export const SidecarNotification = {
  Progress: 'progress',
  Log: 'log',
} as const

/** What a reconstruction backend can do, so the UI can adapt. */
export interface BackendCapabilities {
  /** Single-image monocular depth. */
  mono: boolean
  /** Multi-view geometry from several frames at once. */
  multiview: boolean
  /** Requires camera poses supplied by an upstream stage. */
  needsPoses: boolean
}

export interface BackendInfo {
  id: string
  label: string
  capabilities: BackendCapabilities
  /** SPDX-style license of the model weights, not the code. */
  license: string
  /** False for research or non-commercial weights, so shippable builds can exclude them. */
  commercialUse: boolean
}

export interface HealthResult {
  status: 'starting' | 'ready'
  protocolVersion: number
  torchDevice: string
}

export interface Intrinsics {
  fx: number
  fy: number
  cx: number
  cy: number
  width: number
  height: number
}

/**
 * Reconstruction quality preset. Controls working resolution and the mesh
 * decimation target: `fast` favors speed, `high` favors detail.
 */
export type ReconstructQuality = 'fast' | 'balanced' | 'high'

export interface ReconstructParams {
  /** Directory of captured frames the sidecar reads. */
  framesDir: string
  /** Backend id from listBackends. */
  backend: string
  /** Directory the sidecar writes mesh and point-cloud output into. */
  outputDir: string
  intrinsics?: Intrinsics
  /** Resolution and decimation preset. Defaults to `balanced` when omitted. */
  quality?: ReconstructQuality
  /** Capture and export per-vertex color. */
  color?: boolean
  /** Model checkpoint override for backends that have sizes (Depth Anything 3:
   * `base`, `large`, `giant`, or a Hub repo id / local path). Ignored otherwise. */
  checkpoint?: string
}

export interface ReconstructResult {
  /** Primary mesh output (STL). */
  meshPath: string
  pointCloudPath?: string
  vertexCount: number
  triangleCount: number
  /** True when the mesh carries per-vertex color. */
  hasColor?: boolean
  /** Best file for the 3D viewer: the GLB when color exists, else the STL. */
  previewPath?: string
  /** Every format the backend wrote, keyed by extension. */
  artifacts?: {
    stl?: string
    ply?: string
    glb?: string
    threeMF?: string
  }
}

export interface ProgressNote {
  /** Stage name, for example "depth", "fuse", "mesh". */
  stage: string
  /** Completion in [0, 1]. */
  ratio: number
  message?: string
}

export interface LogNote {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
}
