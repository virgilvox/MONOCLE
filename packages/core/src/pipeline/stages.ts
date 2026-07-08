import type { Mat4 } from '../math/mat4'
import type { Frame } from '../types/frame'
import type { CameraIntrinsics } from '../types/intrinsics'
import type { Mesh } from '../types/mesh'

/**
 * The pipeline is five stages: capture, pose, geometry, fusion, and meshing.
 * Each concrete scanning method (markerless depth, marker mat, turntable) is a
 * different set of backends slotted into the same engine. Build the engine once.
 */

/** Output of a pose estimator for one frame. */
export interface PoseResult {
  /** Camera-from-world pose. */
  pose: Mat4
  /** Intrinsics recovered alongside the pose, when the backend provides them. */
  intrinsics?: CameraIntrinsics
  /** Confidence in [0, 1]. Absent is treated as fully confident. */
  confidence?: number
}

/** Recovers camera pose (and optionally intrinsics) for each frame. */
export interface PoseEstimator<TImage = unknown> {
  readonly name: string
  estimate(frame: Frame<TImage>): Promise<PoseResult | null>
  /** Clear any accumulated state at the start of a scan. */
  reset?(): void
}

/** Per-frame geometry cues: a foreground mask, a depth map, or both. */
export interface GeometryResult {
  mask?: Uint8Array
  depth?: Float32Array
}

/** Produces geometry cues from an RGB frame (segmentation, monocular depth). */
export interface GeometryStage<TImage = unknown> {
  readonly name: string
  compute(frame: Frame<TImage>): Promise<GeometryResult>
}

/** Accumulates posed frames into a volume (binary carve, TSDF, pointmap fuse). */
export interface FusionVolume<TImage = unknown> {
  readonly name: string
  integrate(frame: Frame<TImage>): Promise<void>
  /** Number of frames integrated so far. */
  readonly integratedCount: number
  reset(): void
}

/** Extracts a mesh from the current fusion state. */
export interface Mesher {
  readonly name: string
  extract(): Promise<Mesh>
}

/** The full backend set for one scanning method. */
export interface ScanBackends<TImage = unknown> {
  pose: PoseEstimator<TImage>
  geometry: GeometryStage<TImage>
  fusion: FusionVolume<TImage>
  mesher: Mesher
}
