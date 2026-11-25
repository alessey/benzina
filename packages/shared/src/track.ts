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
  /**
   * Bank angle here, degrees; positive raises the left edge (right-hand turns), negative the
   * right. Set on any point and the track's banking comes only from these (eased between
   * points), steep enough to be felt: a banked turn holds the car in.
   */
  bank?: number;
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
  /** Spline resolution per control-point segment (samples are then evened out by distance). */
  samplesPerSegment: number;
  /** 0..1: how much corners are banked (outside edge raised), scaled by how tight they are. */
  banking?: number;
  /** The track has jumps: steeper ramps and airtime are intended (relaxes validation). */
  jumps?: boolean;
  /** Scenery style: open countryside (default), a city street circuit, snow, a speedway. */
  scenery?: 'country' | 'city' | 'snow' | 'speedway';
  /** A covered section, from one control point to another (indices into controlPoints). */
  tunnel?: [number, number];
  /** A dirt section, from one control point to another: loose grip, mud in the rain. */
  dirt?: [number, number];
  /**
   * The whole road is packed snow: loose like dirt (white), and rain falls as snow. The tunnel,
   * if any, is bare tarmac.
   */
  snow?: boolean;
  /**
   * A chasm: no road between these two control points (the takeoff lip and the landing). Cars
   * jump it; one that falls in is put back on the road before the gap.
   */
  gap?: [number, number];
  /**
   * A U-shaped channel instead of a flat road (bobsled run): a flat floor `floor` metres
   * either side of the centre, then curved walls of `radius` rising to `angle` radians at the
   * top. `width` must equal 2 × (floor + radius × sin(angle)).
   */
  pipe?: PipeProfile;
  /** Areas of open water (harbour), as x/z rectangles. Visual only. */
  water?: { minX: number; maxX: number; minZ: number; maxZ: number }[];
}

export interface PipeProfile {
  floor: number;
  radius: number;
  angle: number;
}

/** Half width of a pipe profile (floor plus the walls' horizontal reach). */
export function pipeHalfWidth(p: PipeProfile): number {
  return p.floor + p.radius * Math.sin(p.angle);
}

/** Height of the cross-section above the centre line at lateral offset `lat` (0 when flat). */
export function profileHeight(def: TrackDef, lat: number): number {
  const p = def.pipe;
  if (!p) return 0;
  const u = Math.min(Math.max(0, Math.abs(lat) - p.floor), p.radius * Math.sin(p.angle));
  return p.radius - Math.sqrt(p.radius * p.radius - u * u);
}

/** Slope of the cross-section (rise per metre to the right) at lateral offset `lat`. */
export function profileSlope(def: TrackDef, lat: number): number {
  const p = def.pipe;
  if (!p) return 0;
  const u = Math.abs(lat) - p.floor;
  if (u <= 0) return 0;
  const uc = Math.min(u, p.radius * Math.sin(p.angle));
  return Math.sign(lat) * (uc / Math.sqrt(p.radius * p.radius - uc * uc));
}

/**
 * Where on a pipe wall the cross-section has slope `m` (rise per metre outward): distance from
 * the centre line, capped short of the top. 0 on flat roads.
 */
export function pipeOffsetForSlope(def: TrackDef, m: number, topFraction = 0.85): number {
  const p = def.pipe;
  if (!p || m <= 0) return 0;
  const u = (p.radius * m) / Math.sqrt(1 + m * m);
  return p.floor + Math.min(u, p.radius * Math.sin(p.angle) * topFraction);
}

/**
 * Lateral positions across the road, as fractions of the half width (-1 = left edge, 1 =
 * right). Flat roads need only the edges; a pipe needs its floor edges and the curved walls.
 */
export function crossSection(def: TrackDef): number[] {
  const p = def.pipe;
  if (!p) return [-1, 1];
  const hw = pipeHalfWidth(p);
  const steps = 8;
  const right: number[] = [];
  for (let k = 0; k <= steps; k++) right.push((p.floor + (p.radius * Math.sin((p.angle * k) / steps))) / hw);
  return [...right.slice().reverse().map((f) => -f), ...right];
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
  /** Climb angle along the segment (radians, positive = rising in the driving direction). */
  pitch: number;
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
  /** Covered section as sample indices [from, to] in driving order (may wrap), or null. */
  tunnel: [number, number] | null;
  /** Dirt section as sample indices [from, to] in driving order (may wrap), or null. */
  dirt: [number, number] | null;
  /** Chasm as sample indices [lip, landing]: no road between them. Never wraps. */
  gap: [number, number] | null;
  /** Banking is set per turn (ControlPoint.bank) and the physics feels it. */
  steepBanks: boolean;
}

/**
 * Banked turns: extra cornering grip, as a multiple of the bank's share of gravity
 * (g·sin θ), when turning toward the low side. Arcade-strong, so banked turns can be taken
 * flat out where flat ones of the same radius need a lift.
 */
export const BANK_GRIP = 1.6;

/**
 * Extra cornering grip (m/s²) a track's bank gives at sample `i`, turning toward its low
 * side (`turn` > 0: right). Only tracks with per-turn banking (`steepBanks`).
 */
export function bankGrip(track: Track, i: number, turn: number, gravity: number): number {
  if (!track.steepBanks) return 0;
  const b = track.samples[i].bank;
  return b * turn > 0 ? gravity * Math.sin(Math.abs(b)) * BANK_GRIP : 0;
}

/** Is there no road between sample i and the next (a chasm)? */
export function gapAfter(track: Track, i: number): boolean {
  return !!track.gap && i >= track.gap[0] && i < track.gap[1];
}

/** Is sample i out over a chasm (strictly between the lip and the landing)? */
export function overGap(track: Track, i: number): boolean {
  return !!track.gap && i > track.gap[0] && i < track.gap[1];
}

/** Is sample i on loose ground: the track's dirt section, or anywhere on a snow road outside its tunnel? */
export function onDirt(track: Track, i: number): boolean {
  const within = (r: [number, number] | null) => !!r && (r[0] <= r[1] ? i >= r[0] && i <= r[1] : i >= r[0] || i <= r[1]);
  if (track.def.snow) return !within(track.tunnel);
  return within(track.dirt);
}

/** Distance between centre line samples, metres. */
const SAMPLE_SPACING = 3;

/** Lowest a road edge may sit above y = 0 (the physics ground), metres. */
const EDGE_CLEARANCE = 0.05;

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
  // Sample the spline densely, then resample evenly by distance (~SAMPLE_SPACING apart), so
  // sample density doesn't depend on how far apart the control points are (short segments,
  // e.g. around a jump, would otherwise pack samples tightly and break windowed lookups).
  const cp = def.controlPoints;
  const n = cp.length;
  const dense: Vec3[] = [];
  const steepBanks = cp.some((c) => c.bank !== undefined);
  const denseBank: number[] = [];
  const perSegment = Math.max(def.samplesPerSegment, 8) * 4;
  for (let i = 0; i < n; i++) {
    const p0 = cp[(i - 1 + n) % n];
    const p1 = cp[i];
    const p2 = cp[(i + 1) % n];
    const p3 = cp[(i + 2) % n];
    for (let s = 0; s < perSegment; s++) {
      const t = s / perSegment;
      dense.push({
        x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
        z: catmullRom(p0.z, p1.z, p2.z, p3.z, t),
        y: Math.max(0, catmullRom(p0.y ?? 0, p1.y ?? 0, p2.y ?? 0, p3.y ?? 0, t)),
      });
      // Eased (smoothstep) between points, so a bank never overshoots like the spline can.
      const e = t * t * (3 - 2 * t);
      denseBank.push((((p1.bank ?? 0) * (1 - e) + (p2.bank ?? 0) * e) * Math.PI) / 180);
    }
  }
  const cumulative = [0];
  for (let i = 1; i <= dense.length; i++) {
    const a = dense[i - 1];
    const b = dense[i % dense.length];
    cumulative.push(cumulative[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const total = cumulative[dense.length];
  const sampleCount = Math.max(16, Math.round(total / SAMPLE_SPACING));
  const points: Vec3[] = [];
  const authoredBank: number[] = [];
  let k = 0;
  for (let i = 0; i < sampleCount; i++) {
    const target = (i / sampleCount) * total;
    while (cumulative[k + 1] < target) k++;
    const a = dense[k];
    const b = dense[(k + 1) % dense.length];
    const f = (target - cumulative[k]) / Math.max(1e-9, cumulative[k + 1] - cumulative[k]);
    points.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f });
    authoredBank.push(denseBank[k] + (denseBank[(k + 1) % dense.length] - denseBank[k]) * f);
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
    const cross = a.x * b.z - a.z * b.x;
    return ds > 0 ? Math.asin(Math.max(-1, Math.min(1, cross))) / ds : 0;
  });
  const curvature = smooth(rawCurvature, 4);
  const banking = def.banking ?? 0;
  const bank = steepBanks
    ? smooth(authoredBank, 5)
    : smooth(
        curvature.map((c) => banking * Math.max(-MAX_BANK, Math.min(MAX_BANK, c * BANK_GAIN))),
        6,
      );

  // Banking lowers the inside edge below the centre line. Where the track is near ground level
  // that would put the edge underground (below the physics ground, and under the scenery's
  // ground plane), so lift the road there, smoothly, until both edges sit at or above y = 0.
  const hw = def.width / 2;
  const needed = points.map((p, i) => Math.max(0, hw * Math.sin(Math.abs(bank[i])) + EDGE_CLEARANCE - p.y));
  // Steep banks pivot on the inside edge, like a real banked turn: it stays at ground level and
  // only the outside climbs. (The bank itself is eased in, so this lift is smooth too.)
  const lift = steepBanks ? needed : smooth(needed, 12).map((v, i) => Math.max(v, needed[i]));
  points.forEach((p, i) => (p.y += lift[i]));

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

  const leftEdge: Vec3[] = [];
  const rightEdge: Vec3[] = [];
  for (const s of samples) {
    const r = rightOf(s.tx, s.tz);
    const across = hw * Math.cos(s.bank);
    const rise = hw * Math.sin(s.bank);
    const wall = profileHeight(def, hw);
    leftEdge.push({ x: s.x - r.x * across, y: s.y + rise + wall, z: s.z - r.z * across });
    rightEdge.push({ x: s.x + r.x * across, y: s.y - rise + wall, z: s.z + r.z * across });
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

  const nearest = (p: Vec2) => {
    let best = 0;
    let bestD = Infinity;
    samples.forEach((s, i) => {
      const d = (s.x - p.x) ** 2 + (s.z - p.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };
  const tunnel: [number, number] | null = def.tunnel ? [nearest(cp[def.tunnel[0]]), nearest(cp[def.tunnel[1]])] : null;
  const dirt: [number, number] | null = def.dirt ? [nearest(cp[def.dirt[0]]), nearest(cp[def.dirt[1]])] : null;
  const gap: [number, number] | null = def.gap ? [nearest(cp[def.gap[0]]), nearest(cp[def.gap[1]])] : null;

  return { def, samples, length, leftEdge, rightEdge, walls, bounds, tunnel, dirt, gap, steepBanks };
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
      pitch: Math.atan2(b.y - a.y, Math.hypot(dx, dz)),
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

/**
 * Starting grid: two columns, staggered behind the start line (sample 0). Slots follow the
 * road backwards, so the grid stays on the track even if a corner comes just before the line.
 */
export function gridSlot(track: Track, slot: number): { x: number; y: number; z: number; yaw: number } {
  const back = 8 + Math.floor(slot / 2) * 8 + (slot % 2) * 3;
  const side = slot % 2 === 0 ? -3 : 3;
  const n = track.samples.length;
  // Walk back along the centre line until we've covered `back` metres.
  let i = 0;
  let covered = 0;
  while (covered < back) {
    const prev = (i - 1 + n) % n;
    covered += Math.hypot(track.samples[i].x - track.samples[prev].x, track.samples[i].z - track.samples[prev].z);
    i = prev;
  }
  const s = track.samples[i];
  const r = rightOf(s.tx, s.tz);
  const x = s.x + r.x * side;
  const z = s.z + r.z * side;
  return { x, y: roadHeightAt(track, x, z, i), z, yaw: Math.atan2(s.tx, s.tz) };
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
  return s.y - Math.tan(s.bank) * across + profileHeight(track.def, across);
}

/**
 * A point on the road surface at sample i, `frac` of the half width across (-1..1, see
 * crossSection), following banking and the pipe profile. Used to build road meshes.
 */
export function roadPoint(track: Track, i: number, frac: number, lift = 0): Vec3 {
  const s = track.samples[i];
  const r = rightOf(s.tx, s.tz);
  const hw = track.def.width / 2;
  const across = frac * hw * Math.cos(s.bank);
  return {
    x: s.x + r.x * across,
    y: s.y - Math.tan(s.bank) * across + profileHeight(track.def, frac * hw) + lift,
    z: s.z + r.z * across,
  };
}
