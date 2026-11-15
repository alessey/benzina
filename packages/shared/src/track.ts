/**
 * Tracks are defined as a closed loop of control points with heights. Everything else (centre
 * line samples, banked road edges, road and wall colliders, terrain) is derived from that, so
 * the client's visuals and the physics colliders always match exactly.
 */

export interface Vec2 {
  x: number;
  z: number;
}

export interface Vec3 extends Vec2 {
  y: number;
}

export interface ControlPoint extends Vec2 {
  /** Road height, metres (0 = ground level). Must stay >= 0. */
  y?: number;
}

export interface TrackDef {
  id: string;
  name: string;
  /** Closed loop of control points, in driving order. */
  controlPoints: ControlPoint[];
  /** Road width, metres. */
  width: number;
  wallHeight: number;
  wallThickness: number;
  /** Centre line samples per control-point segment. */
  samplesPerSegment: number;
  /** 0..1: how much corners are banked (outside edge raised), scaled by how tight they are. */
  banking?: number;
}

export interface TrackSample extends Vec3 {
  /** Unit tangent on the ground plane (driving direction). */
  tx: number;
  tz: number;
  /** Distance along the centre line from sample 0 (on the ground plane). */
  dist: number;
  /** Gradient: metres of climb per metre along the track. */
  slope: number;
  /** Bank angle, radians; positive raises the left edge (for right-hand corners). */
  bank: number;
  /** Signed curvature, 1/m; positive for right-hand turns. */
  curvature: number;
}

export interface WallSegment extends Vec3 {
  /** Rotation around +Y; the segment's length runs along local +Z. */
  yaw: number;
  length: number;
}

export interface Track {
  def: TrackDef;
  samples: TrackSample[];
  /** Total centre line length, metres. */
  length: number;
  leftEdge: Vec3[];
  rightEdge: Vec3[];
  walls: WallSegment[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; maxY: number };
}

/** Steepest bank, radians (~10 degrees). */
const MAX_BANK = 0.18;
/** Bank per unit curvature: a 60 m radius corner reaches the maximum. */
const BANK_GAIN = 11;

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

function smooth(values: number[], radius: number): number[] {
  const n = values.length;
  return values.map((_, i) => {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += values[(i + k + n) % n];
    return sum / (2 * radius + 1);
  });
}

export function buildTrack(def: TrackDef): Track {
  const cp = def.controlPoints;
  const n = cp.length;
  const points: Vec3[] = [];
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
        y: Math.max(0, catmullRom(p0.y ?? 0, p1.y ?? 0, p2.y ?? 0, p3.y ?? 0, t)),
      });
    }
  }

  const count = points.length;
  const tangents: Vec2[] = [];
  const dists: number[] = [];
  let dist = 0;
  for (let i = 0; i < count; i++) {
    const prev = points[(i - 1 + count) % count];
    const next = points[(i + 1) % count];
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const len = Math.hypot(dx, dz);
    tangents.push({ x: dx / len, z: dz / len });
    if (i > 0) dist += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    dists.push(dist);
  }
  const length = dist + Math.hypot(points[0].x - points[count - 1].x, points[0].z - points[count - 1].z);

  // Curvature from how fast the tangent turns; positive = turning right (clockwise from above).
  const rawCurvature = tangents.map((_, i) => {
    const a = tangents[(i - 1 + count) % count];
    const b = tangents[(i + 1) % count];
    const ds = Math.hypot(points[(i + 1) % count].x - points[(i - 1 + count) % count].x, points[(i + 1) % count].z - points[(i - 1 + count) % count].z);
    const cross = a.z * b.x - a.x * b.z;
    return ds > 0 ? Math.asin(Math.max(-1, Math.min(1, cross))) / ds : 0;
  });
  const curvature = smooth(rawCurvature, 4);
  const banking = def.banking ?? 0;
  const bank = smooth(
    curvature.map((c) => banking * Math.max(-MAX_BANK, Math.min(MAX_BANK, c * BANK_GAIN))),
    6,
  );

  const samples: TrackSample[] = points.map((p, i) => {
    const prev = points[(i - 1 + count) % count];
    const next = points[(i + 1) % count];
    const run = Math.hypot(next.x - prev.x, next.z - prev.z);
    return {
      ...p,
      tx: tangents[i].x,
      tz: tangents[i].z,
      dist: dists[i],
      slope: run > 0 ? (next.y - prev.y) / run : 0,
      bank: bank[i],
      curvature: curvature[i],
    };
  });

  const hw = def.width / 2;
  const leftEdge: Vec3[] = [];
  const rightEdge: Vec3[] = [];
  for (const s of samples) {
    const r = rightOf(s.tx, s.tz);
    const across = hw * Math.cos(s.bank);
    const rise = hw * Math.sin(s.bank);
    leftEdge.push({ x: s.x - r.x * across, y: s.y + rise, z: s.z - r.z * across });
    rightEdge.push({ x: s.x + r.x * across, y: s.y - rise, z: s.z + r.z * across });
  }

  const walls = [
    ...buildWalls(leftEdge, samples, -1, def.wallThickness),
    ...buildWalls(rightEdge, samples, 1, def.wallThickness),
  ];

  const xs = samples.map((s) => s.x);
  const zs = samples.map((s) => s.z);
  const bounds = {
    minX: Math.min(...xs) - hw,
    maxX: Math.max(...xs) + hw,
    minZ: Math.min(...zs) - hw,
    maxZ: Math.max(...zs) + hw,
    maxY: Math.max(...samples.map((s) => s.y)),
  };

  return { def, samples, length, leftEdge, rightEdge, walls, bounds };
}

/** One box per edge segment, pushed outward by half the wall thickness, slightly overlapping. */
function buildWalls(edge: Vec3[], samples: TrackSample[], side: 1 | -1, thickness: number): WallSegment[] {
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
      y: (a.y + b.y) / 2,
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

const LOCAL_SEARCH = 12;


/**
 * Like nearestSampleIndex, but searches a small window around `hint` first (a car rarely
 * moves more than a sample or two per tick). Falls back to the full search if the local
 * answer isn't on the road, so a stale hint (teleport, snapshot) can't give a wrong result
 * unless two parts of the track are within a road width of each other.
 */
export function nearestSampleIndexNear(track: Track, x: number, z: number, hint: number): number {
  const n = track.samples.length;
  let best = -1;
  let bestD = Infinity;
  for (let k = -LOCAL_SEARCH; k <= LOCAL_SEARCH; k++) {
    const i = (((hint + k) % n) + n) % n;
    const s = track.samples[i];
    const d = (s.x - x) ** 2 + (s.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (bestD > track.def.width * track.def.width) return nearestSampleIndex(track, x, z);
  return best;
}

/** Starting grid: two columns, staggered behind the start line (sample 0). */
export function gridSlot(track: Track, slot: number): { x: number; y: number; z: number; yaw: number } {
  const s0 = track.samples[0];
  const r = rightOf(s0.tx, s0.tz);
  const back = 8 + Math.floor(slot / 2) * 8 + (slot % 2) * 3;
  const side = slot % 2 === 0 ? -3 : 3;
  const x = s0.x - s0.tx * back + r.x * side;
  const z = s0.z - s0.tz * back + r.z * side;
  return { x, y: roadHeightAt(track, x, z), z, yaw: Math.atan2(s0.tx, s0.tz) };
}

/**
 * Height of the road surface at a point on (or near) the road, including banking. Used for
 * spawning and placement; driving uses the physics raycast against the road collider.
 */
export function roadHeightAt(track: Track, x: number, z: number, hint?: number): number {
  const i = hint === undefined ? nearestSampleIndex(track, x, z) : nearestSampleIndexNear(track, x, z, hint);
  const s = track.samples[i];
  const r = rightOf(s.tx, s.tz);
  const across = (x - s.x) * r.x + (z - s.z) * r.z;
  return s.y - Math.tan(s.bank) * across;
}
