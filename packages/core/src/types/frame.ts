import type { Mat4 } from '../math/mat4'
import type { CameraIntrinsics } from './intrinsics'

/**
 * A single captured frame flowing through the pipeline. The image payload is
 * generic so this package stays free of DOM types: the renderer parameterizes
 * TImage with ImageBitmap or VideoFrame, while a Node context can use a raw
 * buffer or a file path.
 */
export interface Frame<TImage = unknown> {
  /** Monotonic frame identifier within a scan session. */
  id: number
  /** Capture timestamp in milliseconds. */
  t: number
  /** The RGB payload for this frame. */
  image: TImage
  /** Intrinsics, if known at capture or after calibration. */
  intrinsics?: CameraIntrinsics
  /** Camera-from-world pose once estimated. */
  pose?: Mat4
  /** Foreground silhouette, one byte per pixel (0 background, 255 foreground). */
  mask?: Uint8Array
  /** Metric depth in meters after alignment, row-major, one float per pixel. */
  depth?: Float32Array
  /** Laplacian-variance blur score used for keyframe selection. Higher is sharper. */
  blurScore?: number
}

/** True once a frame carries everything the fusion stage needs. */
export function isFusable(frame: Frame): boolean {
  return frame.pose !== undefined && (frame.depth !== undefined || frame.mask !== undefined)
}
