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
  /** Ingest a dropped-in video or image folder into a frames directory, choosing
   * a bounded set of sharp, well-spread keyframes, so the same reconstruct path
   * runs over imported media. */
  PrepareMedia: 'prepareMedia',
  /** Start an experimental incremental reconstruction that streams mesh updates
   * as frames are staged; ends when the app sends Cancel. */
  LiveReconstruct: 'liveReconstruct',
  Cancel: 'cancel',
} as const

/** Parameters for ingesting a dropped-in video or image folder. */
export interface PrepareMediaParams {
  /** Absolute path to a video file or a directory of images. */
  source: string
  /** Directory the selected keyframes are written into as frame_NNNNN.png. */
  framesDir: string
  /** Cap on how many keyframes to keep; sampled evenly and by sharpness. */
  maxFrames?: number
}

/** Result of preparing media: how many keyframes were staged. */
export interface PrepareMediaResult {
  frameCount: number
}

/** Notification methods the sidecar streams back to the app. */
export const SidecarNotification = {
  Progress: 'progress',
  Log: 'log',
  /** A refreshed live-reconstruction mesh is ready to preview. */
  MeshUpdate: 'meshUpdate',
} as const

/** Parameters for a live incremental reconstruction. */
export interface LiveReconstructParams {
  framesDir: string
  outputDir: string
  color?: boolean
}

/** A streamed live-reconstruction update: the current mesh and its counts. */
export interface MeshUpdateNote {
  /** Path to the current mesh file (a colored PLY) the app can read. */
  meshPath: string
  vertexCount: number
  triangleCount: number
  /** How many keyframes have been fused so far. */
  frameCount: number
}

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

/**
 * Heavy-path compute device for the sidecar. `auto` picks the best the machine
 * offers (CUDA, then Apple MPS, then CPU); the explicit values force one, which
 * is what the advanced compute lever sends. This is independent of the renderer's
 * WebGPU/WebGL light path.
 */
export type ReconstructDevice = 'auto' | 'cpu' | 'mps' | 'cuda'

/**
 * What product a reconstruction should yield. `mesh` is the watertight TSDF mesh
 * (the printable default). The others are the native Depth Anything 3 outputs:
 * a colored point cloud, a COLMAP sparse model for other tools, or a Gaussian
 * splat. `gaussian` requires a Gaussian-capable DA3 checkpoint (giant/nested),
 * which is non-commercial, so a shippable build gates it.
 */
export type ReconstructOutput = 'mesh' | 'pointCloud' | 'colmap' | 'gaussian'

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
  /** Heavy-path compute device. Defaults to `auto` when omitted. */
  device?: ReconstructDevice
  /** Desired output product. Defaults to `mesh` when omitted. */
  output?: ReconstructOutput
}

export interface ReconstructResult {
  /** Primary output file: the mesh (STL) for a mesh result, else the point
   * cloud / splat / COLMAP the output kind produced. */
  meshPath: string
  pointCloudPath?: string
  /** Vertices for a mesh, or points for a point cloud / splat. */
  vertexCount: number
  /** Triangles for a mesh; 0 for point-cloud, COLMAP, and Gaussian outputs. */
  triangleCount: number
  /** True when the output carries color. */
  hasColor?: boolean
  /** The output product this result represents. Defaults to `mesh`. */
  output?: ReconstructOutput
  /**
   * Printed size in millimeters (the STL/3MF scale), x/y/z extent. Monocular
   * capture has no true metric scale, so treat this as an estimate the user can
   * rescale in a slicer. Absent for non-mesh outputs.
   */
  boundingBoxMm?: { x: number; y: number; z: number }
  /** Best file for the 3D viewer: the GLB when color exists, else the STL. */
  previewPath?: string
  /** Every format the backend wrote, keyed by a short name. */
  artifacts?: {
    stl?: string
    ply?: string
    glb?: string
    threeMF?: string
    obj?: string
    usdz?: string
    /** Gaussian splat PLY (DA3 gs_ply). */
    gsPly?: string
    /** COLMAP sparse model directory (DA3 colmap). */
    colmap?: string
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
