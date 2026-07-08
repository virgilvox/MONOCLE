/** Plain 3-tuple vector helpers used across geometry stages. */
export type Vec3 = readonly [number, number, number]

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2])
}

export function normalize(a: Vec3): Vec3 {
  const len = length(a)
  if (len === 0) return [0, 0, 0]
  const inv = 1 / len
  return [a[0] * inv, a[1] * inv, a[2] * inv]
}

/** Unit-length normal of the triangle (a, b, c), following the right-hand rule. */
export function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return normalize(cross(sub(b, a), sub(c, a)))
}
