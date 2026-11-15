/** Everything needed to restore a car exactly. This is what server snapshots will carry. */
export interface CarState {
  /** Position x, y, z. */
  p: [number, number, number];
  /** Rotation quaternion x, y, z, w. */
  q: [number, number, number, number];
  /** Linear velocity. */
  v: [number, number, number];
  /** Angular velocity. */
  w: [number, number, number];
  /** Smoothed steering value (-1..1). */
  steer: number;
}

/** Signed yaw (rotation about +Y) from a quaternion. */
export function yawOf(q: { x: number; y: number; z: number; w: number }): number {
  // Forward is local +Z rotated by q, projected on XZ.
  const fx = 2 * (q.x * q.z + q.w * q.y);
  const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
  return Math.atan2(fx, fz);
}

export function yawQuat(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}
