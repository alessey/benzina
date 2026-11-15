import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAR_RIDE_HEIGHT } from '@benzina/shared';

/** Car body spans 2.0 m × 4.0 m (the collider); heights in specs are above the road. */
const ROAD = -CAR_RIDE_HEIGHT;

export type BodyStyle = 'gt' | 'hatch' | 'muscle' | 'coupe';
export const BODY_STYLES: readonly BodyStyle[] = ['gt', 'hatch', 'muscle', 'coupe'];

/** (z, value) keyframes along the car, front (+z) to back (−z) or any order. */
type Keys = [number, number][];

interface CabinStation {
  z: number;
  /** Height where the glasshouse meets the body, and of the roof (centre line). */
  base: number;
  top: number;
  /** Half widths at the base and at the roof edge (less = tumblehome). */
  bhw: number;
  thw: number;
}

type WheelStyle = 'wire' | 'dial' | 'slot' | 'rally';

interface Spec {
  /** Body top on the centre line (bonnet, deck). */
  top: Keys;
  /** Beltline height at the side. */
  belt: Keys;
  /** Half width at the beltline, and of the top's flat part. */
  hw: Keys;
  thw: Keys;
  /** Bottom of the sides (rocker) and underside, above the road. */
  sill: number;
  floor: number;
  /** Wheel centres (z), radius, tyre widths and track (x of the wheel centre). */
  wheelZ: [number, number];
  wheelR: number;
  tyreW: [number, number];
  track: [number, number];
  /** Extra half width over the wheels; box flares have flat tops, others are rounded. */
  flare: number;
  boxFlare: boolean;
  /** Lower sides in black (rally cars). */
  lowerTrim: boolean;
  cabin: CabinStation[];
  /** Cabin segments (between stations i and i+1) with glass on top, and with paint on the sides. */
  roofGlass: number[];
  sidePaint: number[];
  /** Twin stripes over the bonnet, roof and deck. */
  stripes: boolean;
  wheel: WheelStyle;
  rimColor: number;
  /** Style-specific parts (lights, wings, scoops...). */
  parts: (b: Builder) => void;
}

/** Linear interpolation through keyframes, clamped at the ends. */
function sample(keys: Keys, z: number): number {
  const k = [...keys].sort((a, b) => a[0] - b[0]);
  if (z <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (z <= k[i][0]) {
      const t = (z - k[i - 1][0]) / (k[i][0] - k[i - 1][0]);
      return k[i - 1][1] + (k[i][1] - k[i - 1][1]) * t;
    }
  }
  return k[k.length - 1][1];
}

const ARCH_GAP = 0.1;

// ---------------------------------------------------------------------------------- geometry

/** Collects triangles per material, oriented outward from a reference axis. */
class Builder {
  readonly buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private tris = new Map<THREE.Material, number[]>();

  constructor(
    readonly spec: Spec,
    readonly mats: Mats,
  ) {}

  /** Add a triangle; flipped if its normal points towards `inside`. */
  tri(mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, inside: THREE.Vector3): void {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (n.lengthSq() < 1e-12) return;
    const centre = new THREE.Vector3().add(a).add(b).add(c).multiplyScalar(1 / 3);
    const out = n.dot(centre.sub(inside)) >= 0;
    const list = this.tris.get(mat) ?? [];
    this.tris.set(mat, list);
    for (const p of out ? [a, b, c] : [a, c, b]) list.push(p.x, p.y, p.z);
  }

  /** Add a triangle with the given winding (counter-clockwise seen from outside). */
  raw(mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void {
    const list = this.tris.get(mat) ?? [];
    this.tris.set(mat, list);
    for (const p of [a, b, c]) list.push(p.x, p.y, p.z);
  }

  /**
   * A strip quad between ring points j, j+1 at station a (front) and station b (behind). Rings
   * run from the top centre outward and down, so on the right side (a_j, a_j+1, b_j+1) faces out;
   * the left side is mirrored, so its winding flips.
   */
  strip(mat: THREE.Material, aj: THREE.Vector3, aj1: THREE.Vector3, bj1: THREE.Vector3, bj: THREE.Vector3, side: number): void {
    if (side > 0) {
      this.raw(mat, aj, aj1, bj1);
      this.raw(mat, aj, bj1, bj);
    } else {
      this.raw(mat, aj, bj1, aj1);
      this.raw(mat, aj, bj, bj1);
    }
  }

  quad(mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, inside: THREE.Vector3): void {
    this.tri(mat, a, b, c, inside);
    this.tri(mat, a, c, d, inside);
  }

  /** Flush loose triangles into smooth-shaded geometry with crisp creases. */
  flushTris(): void {
    for (const [mat, list] of this.tris) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
      this.push(mat, toCreasedNormals(g, Math.PI / 5));
    }
    this.tris.clear();
  }

  push(mat: THREE.Material, geo: THREE.BufferGeometry): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    const list = this.buckets.get(mat) ?? [];
    this.buckets.set(mat, list);
    list.push(g);
  }

  /** Box centred at (x, h above road, z), rotated (rx, ry, rz); mirrored to −x when `pair`. */
  box(mat: THREE.Material, size: [number, number, number], at: [number, number, number], rot: [number, number, number] = [0, 0, 0], pair = false): void {
    for (const s of pair ? [1, -1] : [1]) {
      const g = new THREE.BoxGeometry(...size);
      g.rotateX(rot[0]);
      g.rotateY(rot[1] * s);
      g.rotateZ(rot[2] * s);
      g.translate(at[0] * s, ROAD + at[1], at[2]);
      this.push(mat, g);
    }
  }

  /** Cylinder with its axis along z (lights, exhausts), optionally squashed into an ellipse. */
  disc(mat: THREE.Material, r: number, depth: number, at: [number, number, number], pair = false, scale: [number, number] = [1, 1], tilt = 0, segs = 14): void {
    for (const s of pair ? [1, -1] : [1]) {
      const g = new THREE.CylinderGeometry(r, r, depth, segs);
      g.rotateX(Math.PI / 2);
      g.scale(scale[0], scale[1], 1);
      g.rotateX(tilt);
      g.translate(at[0] * s, ROAD + at[1], at[2]);
      this.push(mat, g);
    }
  }

  /** Body surface heights at z (after wheel-arch fenders), for placing parts. */
  bodyAt(z: number): { top: number; belt: number; hw: number } {
    return section(this.spec, z);
  }
}

interface Mats {
  paint: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
  head: THREE.MeshStandardMaterial;
  brake: THREE.MeshStandardMaterial;
  stripe: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  rim: THREE.MeshStandardMaterial;
  amber: THREE.MeshStandardMaterial;
}

/** One body cross-section: heights and half widths at z, with fenders over the wheels. */
function section(spec: Spec, z: number) {
  let top = sample(spec.top, z);
  let belt = sample(spec.belt, z);
  let hw = sample(spec.hw, z);
  let thw = sample(spec.thw, z);
  let sideBottom = spec.sill;
  const ra = spec.wheelR + ARCH_GAP;
  for (const wz of spec.wheelZ) {
    const d = Math.abs(z - wz);
    if (d < ra) sideBottom = Math.max(sideBottom, spec.wheelR + Math.sqrt(ra * ra - d * d));
    // Fender: rounded hump, or a flat-topped box flare.
    const reach = ra + 0.2;
    const f = spec.boxFlare
      ? THREE.MathUtils.clamp((reach - d) / 0.16, 0, 1)
      : d < reach
        ? 0.5 + 0.5 * Math.cos((Math.PI * d) / reach)
        : 0;
    if (f > 0) {
      const need = spec.wheelR + ra + 0.07;
      belt = Math.max(belt, belt + (need - belt) * f);
      hw += spec.flare * f;
    }
  }
  belt = Math.max(belt, sideBottom + 0.05);
  thw = Math.min(thw, hw - 0.03);
  return { top, belt, hw, thw, sideBottom };
}

/** Points around one side of a cross-section, from the top centre down to the bottom centre. */
function ring(spec: Spec, z: number): THREE.Vector2[] {
  const { top, belt, hw, thw, sideBottom } = section(spec, z);
  const t2 = top - 0.025;
  // Shoulder: a quadratic curve from the top's edge to the beltline, bulging outward when the
  // top is above the belt, rising into a fender crest when the belt is higher.
  const ctrl = t2 >= belt ? new THREE.Vector2(hw, t2) : new THREE.Vector2(thw, belt);
  const bez = (t: number) =>
    new THREE.Vector2(
      (1 - t) ** 2 * thw + 2 * t * (1 - t) * ctrl.x + t * t * hw,
      (1 - t) ** 2 * t2 + 2 * t * (1 - t) * ctrl.y + t * t * belt,
    );
  const tuck = 0.04;
  return [
    new THREE.Vector2(0, top),
    new THREE.Vector2(thw * 0.5, top - 0.008),
    new THREE.Vector2(thw, t2),
    bez(0.35),
    bez(0.7),
    new THREE.Vector2(hw, belt),
    new THREE.Vector2(hw - tuck * 0.35, belt + (sideBottom - belt) * 0.6),
    new THREE.Vector2(hw - tuck, sideBottom),
    new THREE.Vector2(Math.min(0.58, hw - 0.3), spec.floor),
    new THREE.Vector2(0, spec.floor),
  ];
}

/** Stations along the car: an even grid, plus extra around the wheels for round arches. */
function stations(spec: Spec): number[] {
  const front = Math.max(...spec.top.map((k) => k[0]));
  const rear = Math.min(...spec.top.map((k) => k[0]));
  const ra = spec.wheelR + ARCH_GAP;
  const zs: number[] = [front, rear];
  for (let z = front - 0.08; z > rear + 0.05; z -= 0.2) {
    if (spec.wheelZ.every((w) => Math.abs(z - w) > ra + 0.12)) zs.push(z);
  }
  for (const w of spec.wheelZ) {
    for (const d of [-1.24, -1, -0.82, -0.6, -0.32, 0, 0.32, 0.6, 0.82, 1, 1.24]) {
      const z = w + d * ra * (Math.abs(d) > 1 ? 1 : 1);
      if (z < front && z > rear) zs.push(z);
    }
  }
  // Keyframe positions too, so creases land where the spec puts them.
  for (const keys of [spec.top, spec.belt, spec.hw]) for (const [z] of keys) if (z < front && z > rear) zs.push(z);
  const sorted = [...new Set(zs.map((z) => Math.round(z * 1000) / 1000))].sort((a, b) => b - a);
  return sorted.filter((z, i) => i === 0 || sorted[i - 1] - z > 0.03);
}

function buildBody(b: Builder): void {
  const { spec, mats } = b;
  const zs = stations(spec);
  const rings = zs.map((z) => ring(spec, z));
  const n = rings[0].length;
  const v = (p: THREE.Vector2, z: number, side: number) => new THREE.Vector3(p.x * side, ROAD + p.y, z);
  const segMat = (j: number) => (j >= n - 3 ? mats.trim : j === n - 4 && spec.lowerTrim ? mats.trim : mats.paint);

  for (let i = 0; i < zs.length - 1; i++) {
    const za = zs[i];
    const zb = zs[i + 1];
    const ra = rings[i];
    const rb = rings[i + 1];
    for (const side of [1, -1]) {
      for (let j = 0; j < n - 1; j++) {
        b.strip(segMat(j), v(ra[j], za, side), v(ra[j + 1], za, side), v(rb[j + 1], zb, side), v(rb[j], zb, side), side);
      }
    }
  }
  // End caps (nose and tail) as fans.
  for (const [k, dir] of [[0, 1], [zs.length - 1, -1]] as const) {
    const r = rings[k];
    const z = zs[k];
    const centre = new THREE.Vector3(0, ROAD + (r[0].y + spec.floor) / 2, z);
    for (const side of [1, -1]) {
      for (let j = 0; j < n - 1; j++) {
        const m = j >= n - 3 ? mats.trim : mats.paint;
        const p = v(r[j], z, side);
        const q = v(r[j + 1], z, side);
        // Facing +z at the nose, −z at the tail; mirrored on the left.
        if (dir * side > 0) b.raw(m, centre, q, p);
        else b.raw(m, centre, p, q);
      }
    }
  }
}

function buildCabin(b: Builder): void {
  const { spec, mats } = b;
  const st = spec.cabin;
  const cring = (s: CabinStation) => [
    new THREE.Vector2(0, s.top),
    new THREE.Vector2(Math.max(0, s.thw - 0.08), s.top - 0.012),
    new THREE.Vector2(s.thw, s.top - 0.035),
    new THREE.Vector2(s.bhw, s.base),
  ];
  const v = (p: THREE.Vector2, z: number, side: number) => new THREE.Vector3(p.x * side, ROAD + p.y, z);
  for (let i = 0; i < st.length - 1; i++) {
    const a = cring(st[i]);
    const c = cring(st[i + 1]);
    const za = st[i].z;
    const zb = st[i + 1].z;
    const roof = spec.roofGlass.includes(i) ? mats.glass : mats.paint;
    const sideMat = spec.sidePaint.includes(i) ? mats.paint : mats.glass;
    for (const side of [1, -1]) {
      b.strip(roof, v(a[0], za, side), v(a[1], za, side), v(c[1], zb, side), v(c[0], zb, side), side);
      b.strip(mats.paint, v(a[1], za, side), v(a[2], za, side), v(c[2], zb, side), v(c[1], zb, side), side);
      b.strip(sideMat, v(a[2], za, side), v(a[3], za, side), v(c[3], zb, side), v(c[2], zb, side), side);
    }
  }
  if (spec.stripes) buildStripes(b);
}

/** Twin stripes following the centre line over bonnet, roof and deck (skipping glass). */
function buildStripes(b: Builder): void {
  const { spec, mats } = b;
  const st = spec.cabin;
  const cabinTop = (z: number): { h: number; glass: boolean } | null => {
    for (let i = 0; i < st.length - 1; i++) {
      if (z <= st[i].z && z >= st[i + 1].z) {
        const t = (st[i].z - z) / (st[i].z - st[i + 1].z);
        return { h: st[i].top + (st[i + 1].top - st[i].top) * t, glass: spec.roofGlass.includes(i) };
      }
    }
    return null;
  };
  const zs = [...new Set([...stations(spec), ...st.map((s) => s.z)])].sort((a, b) => b - a);
  const height = (z: number) => {
    const body = section(spec, z).top;
    const c = cabinTop(z);
    return c && c.h > body ? { h: c.h, glass: c.glass } : { h: body, glass: false };
  };
  for (let i = 0; i < zs.length - 1; i++) {
    const a = height(zs[i]);
    const c = height(zs[i + 1]);
    if (a.glass || c.glass) continue;
    for (const [x0, x1] of [[0.07, 0.22], [-0.22, -0.07]]) {
      const p = (x: number, z: number, h: number) => new THREE.Vector3(x, ROAD + h + 0.006, z);
      b.quad(
        mats.stripe,
        p(x0, zs[i], a.h),
        p(x1, zs[i], a.h),
        p(x1, zs[i + 1], c.h),
        p(x0, zs[i + 1], c.h),
        new THREE.Vector3(0, ROAD + Math.min(a.h, c.h) - 1, (zs[i] + zs[i + 1]) / 2),
      );
    }
  }
}

/** A wheel: tyre, rim face in the style, brake disc. Outer face towards +x. */
function buildWheel(spec: Spec, mats: Mats, width: number): THREE.Group {
  const r = spec.wheelR;
  const group = new THREE.Group();
  const rr = r * 0.66;
  const face = width / 2 + 0.004;
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const add = (m: THREE.Material, g: THREE.BufferGeometry) => {
    g = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    (buckets.get(m) ?? buckets.set(m, []).get(m)!).push(g);
  };
  const axisX = (g: THREE.BufferGeometry) => g.rotateZ(Math.PI / 2);

  // Tyre with a rounded shoulder: a wide tread band plus slightly narrower sidewalls.
  add(mats.rubber, axisX(new THREE.CylinderGeometry(r, r, width * 0.86, 20, 1, true)));
  add(mats.rubber, axisX(new THREE.CylinderGeometry(r * 0.94, r * 0.94, width, 20)));
  // Dark recess behind the spokes.
  add(mats.trim, axisX(new THREE.CylinderGeometry(rr, rr, 0.01, 16)).translate(face - 0.02, 0, 0));
  const ringGeo = (inner: number, outer: number) => {
    const g = new THREE.RingGeometry(inner, outer, 20);
    g.rotateY(Math.PI / 2);
    return g;
  };
  const spokes = (count: number, w: number, len: number, from: number, mat: THREE.Material, phase = 0) => {
    for (let i = 0; i < count; i++) {
      const g = new THREE.BoxGeometry(0.02, len, w);
      g.translate(face - 0.008, from + len / 2, 0);
      g.rotateX(phase + (i / count) * Math.PI * 2);
      add(mat, g);
    }
  };
  const hub = (radius: number, mat: THREE.Material) =>
    add(mat, axisX(new THREE.CylinderGeometry(radius, radius, 0.05, 10)).translate(face, 0, 0));

  switch (spec.wheel) {
    case 'wire': {
      add(mats.rim, ringGeo(rr * 0.82, rr).translate(face, 0, 0));
      spokes(18, 0.012, rr * 0.8, rr * 0.12, mats.rim);
      hub(rr * 0.2, mats.chrome);
      // Knock-off spinner ears.
      for (let i = 0; i < 2; i++) {
        const g = new THREE.BoxGeometry(0.03, rr * 0.55, 0.035);
        g.translate(face + 0.03, 0, 0);
        g.rotateX(Math.PI / 4 + i * (Math.PI / 2));
        add(mats.chrome, g);
      }
      break;
    }
    case 'dial': {
      // Solid face with round holes, like a telephone dial.
      add(mats.rim, ringGeo(0, rr).translate(face, 0, 0));
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const g = new THREE.CircleGeometry(rr * 0.2, 10);
        g.rotateY(Math.PI / 2);
        g.translate(face + 0.003, Math.cos(a) * rr * 0.58, Math.sin(a) * rr * 0.58);
        add(mats.trim, g);
      }
      hub(rr * 0.18, mats.trim);
      break;
    }
    case 'slot': {
      add(mats.rim, ringGeo(rr * 0.8, rr).translate(face, 0, 0));
      spokes(5, rr * 0.38, rr * 0.7, rr * 0.18, mats.rim);
      hub(rr * 0.28, mats.chrome);
      break;
    }
    case 'rally': {
      add(mats.rim, ringGeo(0, rr).translate(face, 0, 0));
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const g = new THREE.CircleGeometry(rr * 0.15, 8);
        g.rotateY(Math.PI / 2);
        g.translate(face + 0.003, Math.cos(a) * rr * 0.62, Math.sin(a) * rr * 0.62);
        add(mats.trim, g);
      }
      hub(rr * 0.22, mats.trim);
      break;
    }
  }
  for (const [mat, geos] of buckets) {
    const mesh = new THREE.Mesh(mergeGeometries(geos.map((g) => (g.attributes.normal ? g : (g.computeVertexNormals(), g)))), mat);
    mesh.castShadow = mat === mats.rubber;
    group.add(mesh);
  }
  return group;
}

// ---------------------------------------------------------------------------------- the four cars

/** Classic 60s GT: long bonnet with bulging fenders, oval mouth, fastback, wire wheels. */
const COUPE: Spec = {
  top: [[2.02, 0.5], [1.9, 0.6], [1.5, 0.7], [0.8, 0.77], [0.3, 0.81], [-0.4, 0.84], [-1.5, 0.82], [-1.88, 0.72], [-2.02, 0.55]],
  belt: [[2.02, 0.48], [1.9, 0.56], [1.4, 0.65], [0.5, 0.72], [-1.0, 0.76], [-1.88, 0.68], [-2.02, 0.52]],
  hw: [[2.02, 0.5], [1.92, 0.72], [1.7, 0.85], [1.0, 0.89], [0, 0.9], [-1.0, 0.91], [-1.8, 0.86], [-2.02, 0.7]],
  thw: [[2.02, 0.36], [1.7, 0.52], [0, 0.6], [-1.6, 0.62], [-2.02, 0.5]],
  sill: 0.25,
  floor: 0.22,
  wheelZ: [1.32, -1.3],
  wheelR: 0.35,
  tyreW: [0.26, 0.28],
  track: [0.82, 0.83],
  flare: 0.06,
  boxFlare: false,
  lowerTrim: false,
  cabin: [
    { z: 0.42, base: 0.78, top: 0.8, bhw: 0.66, thw: 0.64 },
    { z: -0.22, base: 0.82, top: 1.2, bhw: 0.73, thw: 0.52 },
    { z: -0.65, base: 0.83, top: 1.22, bhw: 0.75, thw: 0.54 },
    { z: -0.95, base: 0.83, top: 1.17, bhw: 0.75, thw: 0.56 },
    { z: -1.7, base: 0.78, top: 0.84, bhw: 0.7, thw: 0.6 },
  ],
  roofGlass: [0, 3],
  sidePaint: [3],
  stripes: false,
  wheel: 'wire',
  rimColor: 0xd9dde2,
  parts: (b) => {
    const { paint, trim, chrome, head, brake, amber } = b.mats;
    // Oval mouth with a chrome bar.
    b.disc(trim, 0.2, 0.06, [0, 0.4, 2.0], false, [1.55, 0.62]);
    b.box(chrome, [0.5, 0.025, 0.03], [0, 0.4, 2.035]);
    // Covered round headlights in the fender noses.
    b.disc(head, 0.1, 0.08, [0.6, 0.55, 1.88], true, [1, 1], 0.35);
    b.disc(chrome, 0.115, 0.05, [0.6, 0.55, 1.86], true, [1, 1], 0.35);
    // Slim chrome bumpers.
    b.box(chrome, [0.7, 0.03, 0.05], [0, 0.27, 1.99]);
    b.box(chrome, [1.2, 0.05, 0.08], [0, 0.4, -2.0]);
    b.box(amber, [0.08, 0.05, 0.03], [0.62, 0.36, 1.97], [0, 0, 0], true);
    // Bonnet power bulge.
    b.box(paint, [0.34, 0.07, 1.25], [0, b.bodyAt(1.15).top + 0.005, 1.15], [0.11, 0, 0]);
    // Round tail lights, twin exhausts, mirrors.
    b.disc(brake, 0.06, 0.04, [0.55, 0.6, -2.0], true);
    b.disc(amber, 0.04, 0.04, [0.68, 0.55, -1.98], true);
    b.disc(chrome, 0.04, 0.2, [0.13, 0.28, -2.02], true);
    b.disc(chrome, 0.045, 0.06, [0.8, 0.88, 0.3], true, [1, 0.8]);
  },
};

/** 80s wedge supercar: knife-edge nose, pop-up lights, side intakes, louvres, big wing. */
const WEDGE: Spec = {
  top: [[2.02, 0.42], [1.85, 0.54], [1.3, 0.64], [0.55, 0.74], [-0.9, 0.84], [-1.6, 0.86], [-1.94, 0.84], [-2.02, 0.62]],
  belt: [[2.02, 0.4], [1.8, 0.5], [1.0, 0.62], [0, 0.7], [-1.2, 0.79], [-1.9, 0.8], [-2.02, 0.62]],
  hw: [[2.02, 0.8], [1.85, 0.9], [1.5, 0.95], [0.5, 0.96], [-0.5, 0.97], [-1.9, 0.99], [-2.02, 0.94]],
  thw: [[2.02, 0.62], [1.6, 0.72], [0, 0.72], [-1.5, 0.82], [-2.02, 0.8]],
  sill: 0.24,
  floor: 0.21,
  wheelZ: [1.3, -1.26],
  wheelR: 0.35,
  tyreW: [0.28, 0.4],
  track: [0.84, 0.82],
  flare: 0.03,
  boxFlare: true,
  lowerTrim: false,
  cabin: [
    { z: 0.62, base: 0.72, top: 0.74, bhw: 0.66, thw: 0.64 },
    { z: -0.28, base: 0.78, top: 1.08, bhw: 0.75, thw: 0.56 },
    { z: -0.78, base: 0.8, top: 1.08, bhw: 0.77, thw: 0.56 },
    { z: -1.25, base: 0.83, top: 0.92, bhw: 0.78, thw: 0.66 },
    { z: -1.45, base: 0.84, top: 0.87, bhw: 0.78, thw: 0.76 },
  ],
  roofGlass: [0, 2],
  sidePaint: [2, 3],
  stripes: false,
  wheel: 'dial',
  rimColor: 0xcfd3d8,
  parts: (b) => {
    const { paint, trim, chrome, head, brake, amber } = b.mats;
    // Pop-up headlights, raised.
    const hz = 1.42;
    const hTop = b.bodyAt(hz).top;
    b.box(paint, [0.42, 0.15, 0.24], [0.56, hTop + 0.05, hz], [-0.12, 0, 0], true);
    b.box(head, [0.36, 0.09, 0.02], [0.56, hTop + 0.06, hz + 0.125], [-0.12, 0, 0], true);
    // Nose: slim indicators, black lip.
    b.box(amber, [0.26, 0.04, 0.02], [0.58, 0.36, 2.02], [0, 0, 0], true);
    b.box(trim, [1.5, 0.04, 0.16], [0, 0.23, 1.96]);
    // Side intakes behind the doors.
    for (const s of [1, -1]) {
      const z = -0.72;
      const { hw } = b.bodyAt(z);
      b.box(trim, [0.02, 0.17, 0.55], [s * (hw + 0.005), 0.62, z], [0.32, 0, 0]);
    }
    // Air boxes behind the cabin, engine cover louvres.
    b.box(paint, [0.3, 0.16, 0.5], [0.62, 0.9, -1.12], [0.12, 0, 0], true);
    b.box(trim, [0.24, 0.1, 0.02], [0.62, 0.93, -0.86], [0, 0, 0], true);
    for (let i = 0; i < 5; i++) {
      const z = -1.5 - i * 0.09;
      b.box(trim, [0.9, 0.012, 0.035], [0, b.bodyAt(z).top + 0.004, z]);
    }
    // Wing on two posts.
    b.box(paint, [1.9, 0.05, 0.42], [0, 1.16, -1.82], [-0.1, 0, 0]);
    b.box(paint, [0.03, 0.16, 0.44], [0.95, 1.12, -1.82], [0, 0, 0], true);
    b.box(trim, [0.06, 0.3, 0.14], [0.5, 1.0, -1.78], [0.25, 0, 0], true);
    // Full-width tail light band, quad exhausts, diffuser, mirrors.
    b.box(brake, [1.6, 0.11, 0.03], [0, 0.68, -2.025]);
    b.box(trim, [1.7, 0.06, 0.03], [0, 0.58, -2.02]);
    for (const x of [0.25, 0.37]) b.disc(chrome, 0.045, 0.12, [x, 0.33, -2.01], true);
    b.box(trim, [1.4, 0.08, 0.24], [0, 0.25, -1.92]);
    b.box(paint, [0.14, 0.07, 0.1], [0.84, 0.82, 0.3], [0, 0.2, 0], true);
  },
};

/** 60s/70s muscle fastback: flat bonnet with a scoop, full-width grille, quad lamps, stripes. */
const MUSCLE: Spec = {
  top: [[2.02, 0.78], [1.95, 0.84], [0.7, 0.88], [0.4, 0.9], [-1.5, 0.9], [-1.94, 0.93], [-2.02, 0.88]],
  belt: [[2.02, 0.76], [1.95, 0.8], [0, 0.83], [-1.8, 0.86], [-2.02, 0.84]],
  hw: [[2.02, 0.9], [1.95, 0.94], [0, 0.96], [-1.9, 0.97], [-2.02, 0.95]],
  thw: [[2.02, 0.82], [0, 0.86], [-2.02, 0.88]],
  sill: 0.26,
  floor: 0.22,
  wheelZ: [1.3, -1.28],
  wheelR: 0.36,
  tyreW: [0.28, 0.38],
  track: [0.84, 0.83],
  flare: 0.02,
  boxFlare: false,
  lowerTrim: false,
  cabin: [
    { z: 0.4, base: 0.87, top: 0.89, bhw: 0.74, thw: 0.72 },
    { z: -0.15, base: 0.89, top: 1.27, bhw: 0.8, thw: 0.6 },
    { z: -0.7, base: 0.89, top: 1.28, bhw: 0.8, thw: 0.6 },
    { z: -0.86, base: 0.89, top: 1.25, bhw: 0.8, thw: 0.61 },
    { z: -1.75, base: 0.9, top: 0.94, bhw: 0.8, thw: 0.74 },
  ],
  roofGlass: [0, 3],
  sidePaint: [2, 3],
  stripes: true,
  wheel: 'slot',
  rimColor: 0xd0d4d8,
  parts: (b) => {
    const { paint, trim, chrome, head, brake } = b.mats;
    // Full-width grille with quad round headlights.
    b.box(trim, [1.66, 0.28, 0.03], [0, 0.6, 2.015]);
    for (const x of [0.56, 0.75]) {
      b.disc(head, 0.075, 0.03, [x, 0.6, 2.03], true);
      b.disc(chrome, 0.088, 0.02, [x, 0.6, 2.022], true);
    }
    b.box(chrome, [0.5, 0.02, 0.02], [0, 0.6, 2.032]);
    // Chrome bumpers front and back.
    b.box(chrome, [1.9, 0.1, 0.12], [0, 0.4, 2.02]);
    b.box(chrome, [1.9, 0.1, 0.12], [0, 0.4, -2.02]);
    // Bonnet scoop.
    b.box(paint, [0.5, 0.09, 0.62], [0, b.bodyAt(1.0).top + 0.035, 1.0]);
    b.box(trim, [0.4, 0.055, 0.02], [0, b.bodyAt(1.3).top + 0.04, 1.31]);
    // Tail light bar, twin exhausts, mirrors.
    b.box(trim, [1.7, 0.18, 0.03], [0, 0.68, -2.02]);
    b.box(brake, [0.72, 0.11, 0.02], [0.44, 0.68, -2.035], [0, 0, 0], true);
    b.disc(chrome, 0.05, 0.16, [0.52, 0.27, -2.0], true);
    b.disc(chrome, 0.045, 0.06, [0.86, 0.95, 0.25], true, [1, 0.8]);
  },
};

/** 80s rally hatch: boxy and upright, box flares, roof spoiler, spot lamps, mud flaps. */
const RALLY: Spec = {
  top: [[2.0, 0.66], [1.92, 0.76], [1.0, 0.85], [0.75, 0.89], [-1.85, 0.93], [-1.97, 0.93]],
  belt: [[2.0, 0.62], [1.92, 0.72], [0.8, 0.85], [-1.85, 0.91], [-1.97, 0.89]],
  hw: [[2.0, 0.82], [1.9, 0.87], [-1.9, 0.89], [-1.97, 0.86]],
  thw: [[2.0, 0.7], [0, 0.78], [-1.97, 0.78]],
  sill: 0.26,
  floor: 0.22,
  wheelZ: [1.3, -1.3],
  wheelR: 0.35,
  tyreW: [0.3, 0.3],
  track: [0.86, 0.86],
  flare: 0.1,
  boxFlare: true,
  lowerTrim: true,
  cabin: [
    { z: 0.78, base: 0.87, top: 0.89, bhw: 0.8, thw: 0.78 },
    { z: 0.04, base: 0.89, top: 1.42, bhw: 0.84, thw: 0.7 },
    { z: -0.1, base: 0.89, top: 1.43, bhw: 0.84, thw: 0.7 },
    { z: -1.5, base: 0.92, top: 1.44, bhw: 0.86, thw: 0.72 },
    { z: -1.66, base: 0.92, top: 1.43, bhw: 0.86, thw: 0.72 },
    { z: -1.93, base: 0.93, top: 1.0, bhw: 0.86, thw: 0.8 },
  ],
  roofGlass: [0, 4],
  sidePaint: [2, 4],
  stripes: false,
  wheel: 'rally',
  rimColor: 0xd9b04a,
  parts: (b) => {
    const { paint, trim, chrome, head, brake, stripe } = b.mats;
    // Square headlights either side of a black grille.
    for (const x of [0.44, 0.66]) b.box(head, [0.18, 0.12, 0.02], [x, 0.6, 2.008], [0, 0, 0], true);
    b.box(trim, [0.6, 0.12, 0.02], [0, 0.6, 2.008]);
    // Black bumper with four spot lamps.
    b.box(trim, [1.84, 0.2, 0.16], [0, 0.34, 1.98]);
    for (const x of [0.22, 0.5]) {
      b.disc(trim, 0.095, 0.08, [x, 0.5, 2.02], true);
      b.disc(head, 0.08, 0.02, [x, 0.5, 2.065], true);
    }
    // Roof spoiler and vent.
    b.box(paint, [1.5, 0.05, 0.32], [0, 1.45, -1.8], [0.14, 0, 0]);
    b.box(trim, [0.42, 0.05, 0.2], [0, 1.45, -0.15]);
    // Mud flaps behind every wheel.
    for (const z of [1.3 - 0.5, -1.3 - 0.5]) b.box(trim, [0.3, 0.26, 0.02], [0.86, 0.2, z], [0, 0, 0], true);
    // Door stripe.
    for (const s of [1, -1]) {
      const { hw, belt } = b.bodyAt(-0.1);
      b.box(stripe, [0.012, 0.08, 1.1], [s * (hw - 0.004), belt - 0.12, -0.1]);
    }
    // Tail lights, black rear bumper, exhaust, mirrors.
    b.box(brake, [0.36, 0.16, 0.02], [0.6, 0.74, -1.98], [0, 0, 0], true);
    b.box(trim, [1.84, 0.18, 0.14], [0, 0.36, -1.94]);
    b.disc(chrome, 0.05, 0.16, [0.55, 0.26, -1.99]);
    b.box(paint, [0.14, 0.09, 0.1], [0.9, 1.0, 0.62], [0, 0.2, 0], true);
  },
};

const SPECS: Record<BodyStyle, Spec> = { coupe: COUPE, gt: WEDGE, muscle: MUSCLE, hatch: RALLY };

/** Light or dark stripes, whichever stands out against the paint. */
function stripeColor(paint: number): number {
  const c = new THREE.Color(paint);
  const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  return lum > 0.6 ? 0x1c1f24 : 0xf4f4f4;
}

/**
 * Procedural car: a body lofted through cross-sections (with wheel arches and fenders), a
 * glasshouse, style parts, and spoked wheels. Purely visual: it follows a sim state, it never
 * drives physics. Physics keeps cars level and hovering; the wheels sit on the road.
 */
export class CarView {
  readonly group = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly wheels: THREE.Object3D[] = [];
  private readonly frontPivots: THREE.Group[] = [];
  private readonly brakeMat: THREE.MeshStandardMaterial;
  private readonly fadeMats: THREE.Material[] = [];
  private readonly wheelR: number;
  private wheelSpin = 0;
  private brake = 0;
  private fade = 1;

  constructor(color = 0xd8262e, style: BodyStyle = 'gt') {
    const spec = SPECS[style];
    this.wheelR = spec.wheelR;
    const mats: Mats = {
      paint: new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.35 }),
      trim: new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.8 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x2a3946, roughness: 0.08, metalness: 0.3 }),
      chrome: new THREE.MeshStandardMaterial({ color: 0xe8ecf0, roughness: 0.22, metalness: 0.45 }),
      head: new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff2c0, emissiveIntensity: 0.6 }),
      brake: new THREE.MeshStandardMaterial({ color: 0x7a0d0d, emissive: 0xff1a1a, emissiveIntensity: 0.25 }),
      stripe: new THREE.MeshStandardMaterial({ color: stripeColor(color), roughness: 0.35, metalness: 0.2 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.95 }),
      rim: new THREE.MeshStandardMaterial({ color: spec.rimColor, roughness: 0.3, metalness: 0.45 }),
      amber: new THREE.MeshStandardMaterial({ color: 0xffa21f, emissive: 0xff8a00, emissiveIntensity: 0.3 }),
    };
    this.brakeMat = mats.brake;
    // Per car, so fading one car never affects another.
    this.fadeMats.push(...Object.values(mats));

    const b = new Builder(spec, mats);
    buildBody(b);
    buildCabin(b);
    b.flushTris();
    spec.parts(b);
    for (const [mat, geos] of b.buckets) {
      const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
      mesh.castShadow = mat === mats.paint || mat === mats.trim || mat === mats.glass;
      this.body.add(mesh);
    }
    this.group.add(this.body);

    const wheelY = ROAD + spec.wheelR;
    for (const [axle, front] of [[0, true], [1, false]] as const) {
      const proto = buildWheel(spec, mats, spec.tyreW[axle]);
      for (const side of [1, -1]) {
        const wheel = side === 1 ? proto : proto.clone();
        // Left wheels are mirrored so their rim faces outward.
        wheel.scale.x = side;
        const pivot = new THREE.Group();
        pivot.position.set(side * spec.track[axle], wheelY, spec.wheelZ[axle]);
        pivot.add(wheel);
        this.group.add(pivot);
        this.wheels.push(wheel);
        if (front) this.frontPivots.push(pivot);
      }
    }

    // When faded (transparent), the body is drawn first and still writes depth, so it hides
    // the wheels behind it; otherwise a faded car looks like an X-ray with its wheels inside.
    this.body.traverse((o) => (o.renderOrder = 1));
    for (const p of this.frontPivots) p.traverse((o) => (o.renderOrder = 2));
    for (const w of this.wheels) w.traverse((o) => (o.renderOrder = 2));
  }

  /**
   * @param speed forward speed m/s
   * @param steer -1..1, positive right
   * @param braking 0..1, how hard the car is slowing (drives the brake lights)
   */
  update(pos: THREE.Vector3, rot: THREE.Quaternion, speed: number, steer: number, dt: number, braking = 0): void {
    this.group.position.copy(pos);
    this.group.quaternion.copy(rot);
    this.wheelSpin += (speed * dt) / this.wheelR;
    for (const w of this.wheels) w.rotation.x = this.wheelSpin;
    for (const p of this.frontPivots) p.rotation.y = -steer * 0.45;
    // A little body roll into corners sells the motion.
    const roll = steer * Math.min(Math.abs(speed) / 30, 1) * 0.05;
    this.body.rotation.z = THREE.MathUtils.lerp(this.body.rotation.z, roll, 1 - Math.exp(-8 * dt));
    this.brake += (braking - this.brake) * (1 - Math.exp(-15 * dt));
    this.brakeMat.emissiveIntensity = 0.25 + this.brake * 2.5;
  }

  /** Fade the car out (e.g. when it's between the camera and your car). 1 = solid. */
  setFade(alpha: number): void {
    if (Math.abs(alpha - this.fade) < 0.01) return;
    this.fade = alpha;
    for (const m of this.fadeMats) {
      m.transparent = alpha < 0.99;
      m.opacity = alpha;
    }
  }
}
