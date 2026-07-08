export * as mat4 from './math/mat4'
export type { Mat4 } from './math/mat4'
export * as vec3 from './math/vec3'
export type { Vec3 } from './math/vec3'

export type { CameraIntrinsics } from './types/intrinsics'
export { intrinsicsFromFov } from './types/intrinsics'
export type { Frame } from './types/frame'
export { isFusable } from './types/frame'
export type { Mesh, PointCloud } from './types/mesh'
export { vertexCount, triangleCount } from './types/mesh'

export { Emitter } from './pipeline/emitter'
export type { Listener } from './pipeline/emitter'
export type {
  PoseResult,
  PoseEstimator,
  GeometryResult,
  GeometryStage,
  FusionVolume,
  Mesher,
  ScanBackends,
} from './pipeline/stages'
export { ScanEngine } from './pipeline/engine'
export type { ScanEngineEvents, ScanEngineOptions } from './pipeline/engine'
