/**
 * Pinhole camera intrinsics in pixels. Distortion is optional and follows the
 * OpenCV [k1, k2, p1, p2, k3] ordering when present.
 */
export interface CameraIntrinsics {
  fx: number
  fy: number
  cx: number
  cy: number
  width: number
  height: number
  distortion?: readonly number[]
}

/** Rough intrinsics guess from image size and a horizontal field of view. */
export function intrinsicsFromFov(
  width: number,
  height: number,
  horizontalFovDeg: number,
): CameraIntrinsics {
  const fx = width / 2 / Math.tan((horizontalFovDeg * Math.PI) / 360)
  return { fx, fy: fx, cx: width / 2, cy: height / 2, width, height }
}
