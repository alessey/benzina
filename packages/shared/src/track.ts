/**
 * Tracks are defined as a closed loop of control points on the XZ plane. Everything else
 * (centre line samples, road edges, wall colliders) is derived from that, so the client's
 * visuals and the physics colliders always match exactly.
 */

export interface Vec2 {
  x: number;
  z: number;
}

export interface TrackDef {
  name: string;
  /** Closed loop of control points, in driving order. */
  controlPoints: Vec2[];
  /** Road width, metres. */
  width: number;
  wallHeight: number;
  wallThickness: number;
  /** Centre line samples per control-point segment. */
  samplesPerSegment: number;
}

export interface TrackSample {
  x: number;
  z: number;
  /** Unit tangent (driving direction). */
  tx: number;
  tz: number;
  /** Distance along the centre line from sample 0. */
  dist: number;
}

export interface WallSegment {
  x: number;
  z: number;
  /** Rotation around +Y; the segment's length runs along local +Z. */
  yaw: number;
  length: number;
}

export interface Track {
  def: TrackDef;
  samples: TrackSample[];
  /** Total centre line length, metres. */
  length: number;
  leftEdge: Vec2[];
  rightEdge: Vec2[];
  walls: WallSegment[];
}

export const DEFAULT_TRACK: TrackDef = {
  name: 'Circuito Uno',
  controlPoints: [
    { x: 0, z: 0 },
    { x: 0, z: 120 },
    { x: 30, z: 170 },
    { x: 90, z: 180 },
    { x: 130, z: 140 },
    { x: 120, z: 80 },
    { x: 160, z: 40 },
    { x: 220, z: 50 },
    { x: 250, z: 110 },
    { x: 300, z: 130 },
    { x: 340, z: 80 },
    { x: 320, z: -20 },
    { x: 250, z: -60 },
    { x: 160, z: -50 },
    { x: 80, z: -80 },
    { x: 20, z: -60 },
  ],
  width: 14,
  wallHeight: 1.2,
  wallThickness: 1,
  samplesPerSegment: 24,
};

/** Right-hand vector for a driving direction (Y up, forward along +Z means right is -X). */
export function rightOf(tx: number, tz: number): Vec2 {
  return { x: -tz, z: tx };
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

export function buildTrack(def: TrackDef): Track {
  const cp = def.controlPoints;
  const n = cp.length;
  const points: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = cp[(i - 1 + n) % n];
    const p1 = cp[i];
    const p2 = cp[(i + 1) % n];
    const p3 = cp[(i + 2) % n];
    for (let s = 0; s < def.samplesPerSegment; s++) {
      const t = s / def.samplesPerSegment;
      points.push({
        x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
        z: catmullRom(p0.z, p1.z, p2.z, p3.z, t),
      });
    }
  }

  const count = points.length;
  const samples: TrackSample[] = [];
  let dist = 0;
  for (let i = 0; i < count; i++) {
    const prev = points[(i - 1 + count) % count];
    const next = points[(i + 1) % count];
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const len = Math.hypot(dx, dz);
    if (i > 0) dist += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    samples.push({ x: points[i].x, z: points[i].z, tx: dx / len, tz: dz / len, dist });
  }
  const length = dist + Math.hypot(points[0].x - points[count - 1].x, points[0].z - points[count - 1].z);

  const hw = def.width / 2;
  const leftEdge: Vec2[] = [];
  const rightEdge: Vec2[] = [];
  for (const s of samples) {
    const r = rightOf(s.tx, s.tz);
    leftEdge.push({ x: s.x - r.x * hw, z: s.z - r.z * hw });
    rightEdge.push({ x: s.x + r.x * hw, z: s.z + r.z * hw });
  }

  const walls = [
    ...buildWalls(leftEdge, samples, -1, def.wallThickness),
    ...buildWalls(rightEdge, samples, 1, def.wallThickness),
  ];

  return { def, samples, length, leftEdge, rightEdge, walls };
}

/** One box per edge segment, pushed outward by half the wall thickness, slightly overlapping. */
function buildWalls(edge: Vec2[], samples: TrackSample[], side: 1 | -1, thickness: number): WallSegment[] {
  const walls: WallSegment[] = [];
  const count = edge.length;
  for (let i = 0; i < count; i++) {
    const a = edge[i];
    const b = edge[(i + 1) % count];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const r = rightOf(samples[i].tx, samples[i].tz);
    const out = (side * thickness) / 2;
    walls.push({
      x: (a.x + b.x) / 2 + r.x * out,
      z: (a.z + b.z) / 2 + r.z * out,
      yaw: Math.atan2(dx, dz),
      length: Math.hypot(dx, dz) + thickness,
    });
  }
  return walls;
}

/** Index of the centre line sample closest to a world position. */
export function nearestSampleIndex(track: Track, x: number, z: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < track.samples.length; i++) {
    const s = track.samples[i];
    const d = (s.x - x) ** 2 + (s.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Starting grid: two columns, staggered behind the start line (sample 0). */
export function gridSlot(track: Track, slot: number): { x: number; z: number; yaw: number } {
  const s0 = track.samples[0];
  const r = rightOf(s0.tx, s0.tz);
  const back = 8 + Math.floor(slot / 2) * 8 + (slot % 2) * 3;
  const side = slot % 2 === 0 ? -3 : 3;
  return {
    x: s0.x - s0.tx * back + r.x * side,
    z: s0.z - s0.tz * back + r.z * side,
    yaw: Math.atan2(s0.tx, s0.tz),
  };
}
