import * as THREE from 'three';
import { nearestSampleIndex, rightOf, type Track } from '@benzina/shared';

/**
 * Speedway dressing: big grandstands on the outside of the front straight and the longest
 * other straight, pit lane and garages on the inside of the front straight, catch fencing
 * above the outside wall of banked turns, light towers around the circuit and a scoring pylon.
 * Placement is derived from the track (straights, banking, which side is outside), so it
 * follows the layout if the control points change.
 */
export function buildSpeedway(track: Track, groundAt: (x: number, z: number) => number): THREE.Group {
  const group = new THREE.Group();
  const hw = track.def.width / 2;
  const n = track.samples.length;
  // Clockwise circuits (net right turns) have their outside on the left.
  const turning = track.samples.reduce((sum, s) => sum + s.curvature, 0);
  const outside = turning > 0 ? -1 : 1; // -1: left of the driving direction
  const straights = findStraights(track);
  const main = straights.find((st) => contains(st, 0, n)) ?? straights[0];
  const others = straights.filter((st) => st !== main).sort((a, b) => b.length - a.length);
  // Keep-out boxes for light towers (stands, pits).
  const occupied: { x: number; z: number; r: number }[] = [];

  /** Is every point of a footprint (centre, along/across axes, half sizes) clear of the road? */
  const clear = (cx: number, cz: number, ax: number, az: number, halfLen: number, halfDepth: number, margin: number) => {
    for (let u = -1; u <= 1; u += 0.25) {
      for (let v = -1; v <= 1; v += 0.5) {
        const x = cx + ax * u * halfLen - az * v * halfDepth;
        const z = cz + az * u * halfLen + ax * v * halfDepth;
        const s = track.samples[nearestSampleIndex(track, x, z)];
        if (Math.hypot(s.x - x, s.z - z) < hw + margin) return false;
      }
    }
    return true;
  };

  if (main) {
    const frame = straightFrame(track, main);
    const len = Math.min(170, frame.length - 30);
    // Main grandstand on the outside.
    const standDepth = 16 * 1.5;
    const off = outside * (hw + 5 + standDepth / 2);
    const cx = frame.x + frame.rx * off;
    const cz = frame.z + frame.rz * off;
    if (len > 40 && clear(cx, cz, frame.tx, frame.tz, len / 2, standDepth / 2, 2)) {
      const stand = grandstand(len, 16, 101);
      place(stand, frame.x + frame.rx * outside * (hw + 5), frame.z + frame.rz * outside * (hw + 5), frame, outside, groundAt);
      group.add(stand);
      occupied.push({ x: cx, z: cz, r: len / 2 + 10 });
    }
    // Pits and paddock on the inside.
    const pits = pitComplex(len, track.def.wallThickness);
    const px = frame.x - frame.rx * outside * (hw + track.def.wallThickness);
    const pz = frame.z - frame.rz * outside * (hw + track.def.wallThickness);
    if (clear(px - frame.rx * outside * 25, pz - frame.rz * outside * 25, frame.tx, frame.tz, len / 2, 25, 0)) {
      place(pits, px, pz, frame, -outside, groundAt, frame.y);
      group.add(pits);
      occupied.push({ x: px - frame.rx * outside * 25, z: pz - frame.rz * outside * 25, r: len / 2 + 25 });
      // Scoring pylon behind the paddock, facing the main stand.
      const pylon = scoringPylon();
      const qx = frame.x - frame.rx * outside * (hw + 62);
      const qz = frame.z - frame.rz * outside * (hw + 62);
      if (clear(qx, qz, frame.tx, frame.tz, 3, 3, 4)) {
        place(pylon, qx, qz, frame, -outside, groundAt);
        group.add(pylon);
        occupied.push({ x: qx, z: qz, r: 8 });
      }
    }
  }

  // A second stand on the longest other straight.
  for (const st of others.slice(0, 1)) {
    const frame = straightFrame(track, st);
    const len = Math.min(110, frame.length - 30);
    const depth = 10 * 1.5;
    const cx = frame.x + frame.rx * outside * (hw + 5 + depth / 2);
    const cz = frame.z + frame.rz * outside * (hw + 5 + depth / 2);
    if (len < 40 || !clear(cx, cz, frame.tx, frame.tz, len / 2, depth / 2, 2)) continue;
    const stand = grandstand(len, 10, 202);
    place(stand, frame.x + frame.rx * outside * (hw + 5), frame.z + frame.rz * outside * (hw + 5), frame, outside, groundAt);
    group.add(stand);
    occupied.push({ x: cx, z: cz, r: len / 2 + 10 });
  }

  for (const fence of catchFences(track)) group.add(fence);
  group.add(lightTowers(track, outside, occupied, groundAt));
  return group;
}

interface Straight {
  /** First and last sample index (may wrap). */
  from: number;
  to: number;
  length: number;
}

function contains(st: Straight, i: number, n: number): boolean {
  const span = (st.to - st.from + n) % n;
  return (i - st.from + n) % n <= span;
}

/** Runs of nearly straight road longer than 50 m. */
function findStraights(track: Track): Straight[] {
  const n = track.samples.length;
  const spacing = track.length / n;
  const straight = track.samples.map((s) => Math.abs(s.curvature) < 0.004);
  // Start the scan at a bend, so a straight through sample 0 isn't split.
  const start = straight.findIndex((v) => !v);
  if (start < 0) return [];
  const out: Straight[] = [];
  let runFrom = -1;
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (straight[i] && runFrom < 0) runFrom = i;
    if ((!straight[i] || k === n) && runFrom >= 0) {
      const to = (i - 1 + n) % n;
      const length = (((to - runFrom + n) % n) + 1) * spacing;
      if (length > 50) out.push({ from: runFrom, to, length });
      runFrom = -1;
    }
  }
  return out;
}

/** Centre, direction and length of a straight (along the chord between its ends). */
function straightFrame(track: Track, st: Straight) {
  const a = track.samples[st.from];
  const b = track.samples[st.to];
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const tx = (b.x - a.x) / len;
  const tz = (b.z - a.z) / len;
  const r = rightOf(tx, tz);
  return { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y), z: (a.z + b.z) / 2, tx, tz, rx: r.x, rz: r.z, length: len };
}

/**
 * Put a structure built facing local -z (its front toward the road) alongside a straight,
 * on `side` (-1 left of the driving direction, 1 right), its front edge at (x, z).
 */
function place(
  obj: THREE.Object3D,
  x: number,
  z: number,
  frame: { tx: number; tz: number },
  side: number,
  groundAt: (x: number, z: number) => number,
  y?: number,
): void {
  // Local +z points away from the road: the side's direction.
  const r = rightOf(frame.tx, frame.tz);
  const awayX = r.x * side;
  const awayZ = r.z * side;
  obj.position.set(x, y ?? Math.min(groundAt(x, z), groundAt(x + awayX * 10, z + awayZ * 10)), z);
  obj.rotation.y = Math.atan2(awayX, awayZ);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A tiered stand `length` long, front at z = 0 rising toward +z, roofed, full of spectators. */
function grandstand(length: number, tiers: number, seed: number): THREE.Group {
  const group = new THREE.Group();
  const rise = 0.75;
  const tread = 1.5;
  const base = 2.2; // front wall: spectators sit above the catch fence line
  const concrete = new THREE.MeshLambertMaterial({ color: 0xc4c0b6 });
  const seats = new THREE.MeshLambertMaterial({ color: 0x2c5d9e });
  const steel = new THREE.MeshLambertMaterial({ color: 0x9aa0a8 });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0xe9ecef });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  // Front wall, then the stepped seating deck (each tier one box down to the ground).
  add(new THREE.BoxGeometry(length, base, 0.6), concrete, 0, base / 2, 0.3);
  for (let t = 0; t < tiers; t++) {
    const h = base + rise * (t + 1);
    add(new THREE.BoxGeometry(length, h, tread), t % 2 ? concrete : seats, 0, h / 2, 0.6 + tread * (t + 0.5));
  }
  const depth = 0.6 + tread * tiers;
  const top = base + rise * tiers;
  // Back wall and a cantilevered roof on columns.
  add(new THREE.BoxGeometry(length, top + 4.5, 0.5), concrete, 0, (top + 4.5) / 2, depth + 0.25);
  const roof = add(new THREE.BoxGeometry(length + 2, 0.35, depth * 0.85), roofMat, 0, top + 4.6, depth - depth * 0.42);
  roof.rotation.x = -0.06;
  for (let x = -length / 2; x <= length / 2 + 0.1; x += length / Math.max(1, Math.round(length / 25))) {
    add(new THREE.BoxGeometry(0.45, top + 4.6, 0.45), steel, x, (top + 4.6) / 2, depth - 0.2);
  }
  // Stairways: pale stripes across the tiers.
  for (let x = -length / 2 + 12; x < length / 2 - 6; x += 24) {
    for (let t = 0; t < tiers; t++) {
      add(new THREE.BoxGeometry(1.4, 0.05, tread), concrete, x, base + rise * (t + 1) + 0.03, 0.6 + tread * (t + 0.5)).castShadow = false;
    }
  }
  // Spectators: one small box per seat, random shirts, some empty seats.
  const rand = mulberry32(seed);
  const spacing = 0.62;
  const perRow = Math.floor(length / spacing);
  const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.75, 0.38), new THREE.MeshLambertMaterial(), perRow * tiers);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  let k = 0;
  for (let t = 0; t < tiers; t++) {
    for (let i = 0; i < perRow; i++) {
      const x = -length / 2 + spacing / 2 + i * spacing;
      if (rand() < 0.12 || Math.abs(((x + length / 2 - 12) % 24) - 0) < 0.9) continue;
      m.compose(new THREE.Vector3(x, base + rise * (t + 1) + 0.38, 0.6 + tread * t + 0.55), q, new THREE.Vector3(1, 0.85 + rand() * 0.3, 1));
      crowd.setMatrixAt(k, m);
      crowd.setColorAt(k, c.setHSL(rand(), 0.55, 0.42 + rand() * 0.25));
      k++;
    }
  }
  crowd.count = k;
  crowd.castShadow = false;
  group.add(crowd);
  // Banner panels along the front wall: plain coloured boards.
  const boards = ['#c8281e', '#f2f2f2', '#1f4f9a', '#f2c41a'];
  const boardMats = boards.map((color) => new THREE.MeshLambertMaterial({ color }));
  for (let x = -length / 2 + 4, b = 0; x < length / 2 - 3; x += 8, b++) {
    add(new THREE.BoxGeometry(7.4, 1.2, 0.05), boardMats[b % boardMats.length], x, base * 0.55, -0.03).castShadow = false;
  }
  return group;
}

/**
 * Pit lane, garages and paddock behind a straight's inside wall. Built facing local -z (the
 * track), origin at the track wall; extends toward +z.
 */
function pitComplex(length: number, wallThickness: number): THREE.Group {
  const group = new THREE.Group();
  const asphalt = new THREE.MeshLambertMaterial({ color: 0x45474c });
  const paddockMat = new THREE.MeshLambertMaterial({ color: 0x55575c });
  const white = new THREE.MeshLambertMaterial({ color: 0xf0f0f0 });
  const concrete = new THREE.MeshLambertMaterial({ color: 0xd8d4ca });
  const dark = new THREE.MeshLambertMaterial({ color: 0x1c1e22 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, shadow = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = shadow;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  const laneDepth = 12;
  const z0 = wallThickness / 2;
  // Pit lane slab (thick, so it never floats over dips in the ground), with a fast-lane line.
  add(new THREE.BoxGeometry(length + 30, 1, laneDepth), asphalt, 0, -0.5 + 0.02, z0 + laneDepth / 2, false);
  add(new THREE.BoxGeometry(length + 30, 0.02, 0.25), white, 0, 0.04, z0 + 4.5, false);
  // Pit wall extension above the track wall: a debris fence on posts.
  const fenceH = 2.2;
  for (let x = -length / 2; x <= length / 2; x += 6) add(new THREE.BoxGeometry(0.12, fenceH, 0.12), dark, x, 1.2 + fenceH / 2, -wallThickness / 2);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(length, fenceH), fenceMaterial(length / 0.4, fenceH / 0.4));
  mesh.position.set(0, 1.2 + fenceH / 2, -wallThickness / 2);
  group.add(mesh);
  // Garages: a long block with a door per team.
  const garageDepth = 11;
  const gz = z0 + laneDepth + garageDepth / 2;
  add(new THREE.BoxGeometry(length, 5, garageDepth), concrete, 0, 2.5, gz);
  add(new THREE.BoxGeometry(length + 1, 0.4, garageDepth + 2.5), white, 0, 5.2, gz - 1);
  const teamColors = [0xc8281e, 0x1f4f9a, 0xf2c41a, 0x2e8b57, 0xe46b1c, 0x6c3fa0, 0x111111, 0x1aa3c8];
  const teamMats = teamColors.map((color) => new THREE.MeshLambertMaterial({ color }));
  const doors = Math.floor(length / 7);
  for (let d = 0; d < doors; d++) {
    const x = -length / 2 + 3.5 + d * 7;
    add(new THREE.BoxGeometry(5, 3.4, 0.1), dark, x, 1.7, z0 + laneDepth - 0.05, false);
    add(new THREE.BoxGeometry(5.6, 0.7, 0.12), teamMats[d % teamMats.length], x, 4.1, z0 + laneDepth - 0.06, false);
    // Pit box outline on the lane.
    add(new THREE.BoxGeometry(0.15, 0.02, 6), white, x - 2.8, 0.04, z0 + laneDepth - 3, false);
  }
  // Paddock behind: asphalt, team trucks and motorhomes.
  const paddockDepth = 26;
  const pz = z0 + laneDepth + garageDepth + paddockDepth / 2;
  add(new THREE.BoxGeometry(length + 20, 1, paddockDepth), paddockMat, 0, -0.5 + 0.015, pz, false);
  const rand = mulberry32(55);
  const trailer = new THREE.BoxGeometry(2.5, 3.8, 13);
  const cab = new THREE.BoxGeometry(2.5, 3, 2.6);
  for (let x = -length / 2 + 6; x < length / 2 - 4; x += 9 + rand() * 4) {
    const mat = teamMats[Math.floor(rand() * teamMats.length)];
    const z = pz + (rand() - 0.5) * 4;
    add(trailer, white, x, 2.1, z);
    add(cab, mat, x, 1.7, z - 8);
  }
  return group;
}

/** A see-through diamond-mesh fence material, repeating every 2 m. */
function fenceMaterial(repeatU: number, repeatV: number): THREE.MeshLambertMaterial {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = 'rgba(70,74,80,1)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(size, size);
  ctx.moveTo(size, 0);
  ctx.lineTo(0, size);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatU, repeatV);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, depthWrite: false });
}

/** Tall catch fencing on posts above the outside wall wherever the track is steeply banked. */
function catchFences(track: Track): THREE.Object3D[] {
  const n = track.samples.length;
  const height = 4;
  const wallTop = track.def.wallHeight;
  const out: THREE.Object3D[] = [];
  const postMat = new THREE.MeshLambertMaterial({ color: 0x3a3e44 });
  const postGeo = new THREE.BoxGeometry(0.16, height, 0.16);
  const posts: THREE.Matrix4[] = [];
  const minBank = (5 * Math.PI) / 180;
  for (const side of [-1, 1] as const) {
    // Left edge is outside for right turns (positive bank).
    const edge = side < 0 ? track.leftEdge : track.rightEdge;
    const banked = (i: number) => track.samples[i].bank * -side > minBank;
    const start = Array.from({ length: n }, (_, i) => i).find((i) => !banked(i));
    if (start === undefined) continue;
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 3) out.push(fenceRibbon(track, edge, run, side, wallTop, height));
      run = [];
    };
    for (let k = 1; k <= n; k++) {
      const i = (start + k) % n;
      if (banked(i)) {
        run.push(i);
        if (i % 2 === 0) {
          const p = outward(track, edge, i, side);
          posts.push(new THREE.Matrix4().makeTranslation(p.x, p.y + wallTop + height / 2, p.z));
        }
      } else flush();
    }
    flush();
  }
  const inst = new THREE.InstancedMesh(postGeo, postMat, posts.length);
  posts.forEach((m, i) => inst.setMatrixAt(i, m));
  inst.castShadow = true;
  out.push(inst);
  return out;
}

/** An edge point pushed out to the middle of the wall. */
function outward(track: Track, edge: { x: number; y: number; z: number }[], i: number, side: number) {
  const s = track.samples[i];
  const r = rightOf(s.tx, s.tz);
  const off = (side * track.def.wallThickness) / 2;
  return { x: edge[i].x + r.x * off, y: edge[i].y, z: edge[i].z + r.z * off };
}

function fenceRibbon(
  track: Track,
  edge: { x: number; y: number; z: number }[],
  run: number[],
  side: number,
  base: number,
  height: number,
): THREE.Mesh {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let u = 0;
  run.forEach((i, k) => {
    const p = outward(track, edge, i, side);
    if (k > 0) {
      const q = outward(track, edge, run[k - 1], side);
      u += Math.hypot(p.x - q.x, p.z - q.z) / 2;
    }
    pos.push(p.x, p.y + base, p.z, p.x, p.y + base + height, p.z);
    uv.push(u, 0, u, height / 2);
    if (k > 0) {
      const a = (k - 1) * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // uv runs in 2 m units: about 0.4 m diamonds.
  return new THREE.Mesh(geo, fenceMaterial(5, 5));
}

/** Floodlight towers around the outside of the circuit, heads turned toward the track. */
function lightTowers(
  track: Track,
  outside: number,
  occupied: { x: number; z: number; r: number }[],
  groundAt: (x: number, z: number) => number,
): THREE.Group {
  const group = new THREE.Group();
  const hw = track.def.width / 2;
  const n = track.samples.length;
  const spacing = track.length / n;
  const every = Math.round(110 / spacing);
  const steel = new THREE.MeshLambertMaterial({ color: 0x8d939b });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xf4f1e6, emissive: 0xfff6d8, emissiveIntensity: 0.6 });
  const height = 26;
  for (let i = 0; i < n; i += every) {
    const s = track.samples[i];
    const r = rightOf(s.tx, s.tz);
    for (const side of [outside, -outside]) {
      const off = side * (hw + 16);
      const x = s.x + r.x * off;
      const z = s.z + r.z * off;
      const near = track.samples[nearestSampleIndex(track, x, z)];
      if (Math.hypot(near.x - x, near.z - z) < hw + 10) continue;
      if (occupied.some((o) => Math.hypot(o.x - x, o.z - z) < o.r)) continue;
      const tower = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.45, height, 8), steel);
      pole.position.y = height / 2;
      pole.castShadow = true;
      tower.add(pole);
      const head = new THREE.Mesh(new THREE.BoxGeometry(5, 2.6, 0.5), steel);
      head.position.set(0, height + 1, 0);
      tower.add(head);
      // Lamp face toward the track (local -z).
      const face = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 2.2), lamp);
      face.position.set(0, height + 1, -0.26);
      face.rotation.y = Math.PI;
      tower.add(face);
      tower.position.set(x, groundAt(x, z), z);
      // Face the road: local -z toward the centre line.
      tower.rotation.y = Math.atan2(x - s.x, z - s.z);
      group.add(tower);
      break;
    }
  }
  return group;
}

/** Tall scoring pylon: a column of position boards, lit. */
function scoringPylon(): THREE.Group {
  const group = new THREE.Group();
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#16181c';
  ctx.fillRect(0, 0, 128, 512);
  ctx.font = 'bold 40px ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 8; i++) {
    const y = 34 + i * 61;
    ctx.fillStyle = '#f2c41a';
    ctx.fillText(String(i + 1), 12, y);
    ctx.fillStyle = ['#ff5a4a', '#5ab4ff', '#fff', '#7dff9a', '#ffb35a', '#c79bff', '#ff8ad8', '#9af2ff'][i];
    ctx.fillRect(54, y - 16, 60, 32);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const steel = new THREE.MeshLambertMaterial({ color: 0x2b2f36 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(3.4, 14, 1.2), steel);
  body.position.y = 6 + 7;
  body.castShadow = true;
  group.add(body);
  const legs = new THREE.Mesh(new THREE.BoxGeometry(1, 6, 1), steel);
  legs.position.y = 3;
  group.add(legs);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(3, 13.4), new THREE.MeshBasicMaterial({ map: tex }));
  board.position.set(0, 13, -0.61);
  board.rotation.y = Math.PI;
  group.add(board);
  return group;
}
