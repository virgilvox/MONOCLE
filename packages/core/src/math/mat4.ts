/**
 * Minimal 4x4 matrix helpers in column-major order, matching the WebGL and
 * three.js convention. A Mat4 is a length-16 Float32Array where element m[c*4+r]
 * is column c, row r.
 *
 * Poses in this project are stored camera-from-world (a world point multiplied
 * by the pose lands in camera space).
 */
export type Mat4 = Float32Array

/** Create a new identity matrix. */
export function identity(): Mat4 {
  const m = new Float32Array(16)
  m[0] = 1
  m[5] = 1
  m[10] = 1
  m[15] = 1
  return m
}

/** Multiply a * b and return a new matrix (column-major). */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row]! * b[col * 4 + k]!
      }
      out[col * 4 + row] = sum
    }
  }
  return out
}

/** Transform a 3D point by the matrix, applying translation (w = 1). */
export function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  const px = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
  const py = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
  const pz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
  const pw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
  const inv = pw !== 0 ? 1 / pw : 1
  return [px * inv, py * inv, pz * inv]
}

/**
 * Invert a 4x4 matrix. Returns null when the matrix is singular so callers can
 * decide how to handle a degenerate pose rather than silently propagating NaN.
 */
export function invert(m: Mat4): Mat4 | null {
  const a = m
  const b00 = a[0]! * a[5]! - a[1]! * a[4]!
  const b01 = a[0]! * a[6]! - a[2]! * a[4]!
  const b02 = a[0]! * a[7]! - a[3]! * a[4]!
  const b03 = a[1]! * a[6]! - a[2]! * a[5]!
  const b04 = a[1]! * a[7]! - a[3]! * a[5]!
  const b05 = a[2]! * a[7]! - a[3]! * a[6]!
  const b06 = a[8]! * a[13]! - a[9]! * a[12]!
  const b07 = a[8]! * a[14]! - a[10]! * a[12]!
  const b08 = a[8]! * a[15]! - a[11]! * a[12]!
  const b09 = a[9]! * a[14]! - a[10]! * a[13]!
  const b10 = a[9]! * a[15]! - a[11]! * a[13]!
  const b11 = a[10]! * a[15]! - a[11]! * a[14]!

  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (det === 0) return null
  const invDet = 1 / det

  const out = new Float32Array(16)
  out[0] = (a[5]! * b11 - a[6]! * b10 + a[7]! * b09) * invDet
  out[1] = (a[2]! * b10 - a[1]! * b11 - a[3]! * b09) * invDet
  out[2] = (a[13]! * b05 - a[14]! * b04 + a[15]! * b03) * invDet
  out[3] = (a[10]! * b04 - a[9]! * b05 - a[11]! * b03) * invDet
  out[4] = (a[6]! * b08 - a[4]! * b11 - a[7]! * b07) * invDet
  out[5] = (a[0]! * b11 - a[2]! * b08 + a[3]! * b07) * invDet
  out[6] = (a[14]! * b02 - a[12]! * b05 - a[15]! * b01) * invDet
  out[7] = (a[8]! * b05 - a[10]! * b02 + a[11]! * b01) * invDet
  out[8] = (a[4]! * b10 - a[5]! * b08 + a[7]! * b06) * invDet
  out[9] = (a[1]! * b08 - a[0]! * b10 - a[3]! * b06) * invDet
  out[10] = (a[12]! * b04 - a[13]! * b02 + a[15]! * b00) * invDet
  out[11] = (a[9]! * b02 - a[8]! * b04 - a[11]! * b00) * invDet
  out[12] = (a[5]! * b07 - a[4]! * b09 - a[6]! * b06) * invDet
  out[13] = (a[0]! * b09 - a[1]! * b07 + a[2]! * b06) * invDet
  out[14] = (a[13]! * b01 - a[12]! * b03 - a[14]! * b00) * invDet
  out[15] = (a[8]! * b03 - a[9]! * b01 + a[10]! * b00) * invDet
  return out
}

/** Build a rigid transform from a 3x3 row list and a translation vector. */
export function fromRotationTranslation(
  rotation: readonly [number, number, number, number, number, number, number, number, number],
  translation: readonly [number, number, number],
): Mat4 {
  const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = rotation
  const [tx, ty, tz] = translation
  const m = new Float32Array(16)
  m[0] = r00
  m[1] = r10
  m[2] = r20
  m[4] = r01
  m[5] = r11
  m[6] = r21
  m[8] = r02
  m[9] = r12
  m[10] = r22
  m[12] = tx
  m[13] = ty
  m[14] = tz
  m[15] = 1
  return m
}
