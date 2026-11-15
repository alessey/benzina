import * as THREE from 'three';
import { nearestSampleIndex, type Track, type Vec3 } from '@benzina/shared';

export interface GameScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  /** Swap the circuit: terrain, road, walls, scenery. */
  setTrack(track: Track): void;
  /** Ground height (terrain or road) at a point, for placing things. */
  heightAt(x: number, z: number): number;
  /** Call each frame before rendering (keeps the sky centred on the camera). */
  update(): void;
  /** Countdown gantry: how many red lights are lit (0–5), or all green. */
  setStartLights(red: number, green: boolean): void;
}

const HORIZON = new THREE.Color(0xcfe3f2);
const ZENITH = new THREE.Color(0x5d9bd6);

export interface SceneOptions {
  /** Phones/tablets: cheaper settings (MSAA off on dense screens, smaller shadow map, coarser terrain). */
  mobile: boolean;
}

/**
 * Draw order for things lying on the ground. The terrain writes depth; the road, curbs and
 * start line are drawn right after it, depth-tested (so hills in front still hide them) but
 * not depth-writing, so each layer paints cleanly over the one below without z-fighting on
 * 16-bit depth buffers (common on mobile). The terrain sits a little below the road surface.
 */
const ORDER = { sky: -20, terrain: -10, road: -9, curb: -8, start: -7 } as const;

function surfaceMaterial(params: THREE.MeshLambertMaterialParameters): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    ...params,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -8,
  });
}

export function createScene(opts: SceneOptions): GameScene {
  // Dense phone screens don't need MSAA, and it's expensive on mobile GPUs.
  const antialias = !opts.mobile || window.devicePixelRatio < 2;
  const renderer = new THREE.WebGLRenderer({ antialias, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = HORIZON.clone();
  scene.fog = new THREE.Fog(HORIZON.clone(), 220, 900);

  // A near plane of 0.5 m (the camera never gets closer to anything) keeps depth precision up.
  const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.5, 2500);
  const resize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize);
  // Mobile browsers sometimes report the old size during the resize event after rotating.
  screen.orientation?.addEventListener('change', () => setTimeout(resize, 150));

  scene.add(new THREE.HemisphereLight(0xe4f2ff, 0x5a7a3a, 1.3));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  sun.castShadow = true;
  const shadowSize = opts.mobile ? 1024 : 2048;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  const sc = sun.shadow.camera;
  sc.left = -60;
  sc.right = 60;
  sc.top = 60;
  sc.bottom = -60;
  sc.near = 1;
  sc.far = 220;
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  const sky = buildSky();
  scene.add(sky);

  let trackGroup: THREE.Group | null = null;
  let terrain: Terrain | null = null;
  let lights: StartLights | null = null;

  return {
    renderer,
    scene,
    camera,
    sun,
    setTrack(track: Track) {
      if (terrain?.track === track) return;
      if (trackGroup) {
        scene.remove(trackGroup);
        disposeTree(trackGroup);
      }
      terrain = new Terrain(track, opts.mobile ? 9 : 7);
      trackGroup = buildTrackScenery(track, terrain);
      lights = new StartLights(track);
      trackGroup.add(lights.group);
      trackGroup.add(buildGrandstand(track, terrain));
      scene.add(trackGroup);
    },
    setStartLights(red, green) {
      lights?.set(red, green);
    },
    heightAt(x, z) {
      return terrain ? terrain.heightAt(x, z) : 0;
    },
    update() {
      sky.position.copy(camera.position);
    },
  };
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) {
      (m as THREE.MeshBasicMaterial).map?.dispose();
      m.dispose();
    }
  });
}

/** Gradient sky dome that follows the camera. */
function buildSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(2000, 24, 12);
  const colors: number[] = [];
  const pos = geo.getAttribute('position');
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, pos.getY(i) / 2000);
    c.copy(HORIZON).lerp(ZENITH, Math.pow(t, 0.6));
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const sky = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  sky.renderOrder = ORDER.sky;
  return sky;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Visual terrain: the land hugs the road (slightly below it, so the road sits on an embankment
 * or in a cutting) and relaxes into gentle rolling hills away from it. Cars never leave the
 * road, so this is purely visual and has no collider.
 */
class Terrain {
  readonly minX: number;
  readonly minZ: number;
  readonly cols: number;
  readonly rows: number;
  readonly heights: Float32Array;
  readonly roadDist: Float32Array;

  constructor(
    readonly track: Track,
    readonly cell: number,
  ) {
    const margin = 260;
    const b = track.bounds;
    this.minX = b.minX - margin;
    this.minZ = b.minZ - margin;
    this.cols = Math.ceil((b.maxX + margin - this.minX) / cell) + 1;
    this.rows = Math.ceil((b.maxZ + margin - this.minZ) / cell) + 1;
    this.heights = new Float32Array(this.cols * this.rows);
    this.roadDist = new Float32Array(this.cols * this.rows);
    const hw = track.def.width / 2;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const x = this.minX + c * cell;
        const z = this.minZ + r * cell;
        const i = nearestSampleIndex(track, x, z);
        const s = track.samples[i];
        const d = Math.hypot(x - s.x, z - s.z);
        // Just below the road surface under and beside the road. Beside it, continue the
        // bank only as far as the edge: on the inside of a banked corner the edge is well
        // below the centre line, and terrain at centre height would poke through.
        const across = (x - s.x) * -s.tz + (z - s.z) * s.tx;
        const nearRoad = s.y - Math.tan(s.bank) * Math.max(-hw, Math.min(hw, across)) - 0.45;
        // Edges of the terrain fade to y = 0 to meet the far ground plane.
        const edge = Math.min(c, r, this.cols - 1 - c, this.rows - 1 - r) * cell;
        const natural = this.hills(x, z) * smoothstep(0, 120, edge);
        const w = smoothstep(hw + 4, hw + 50, d);
        this.heights[r * this.cols + c] = nearRoad * (1 - w) + natural * w;
        this.roadDist[r * this.cols + c] = d - hw;
      }
    }
  }

  /** Rolling hills from a few octaves of sine waves (cheap, deterministic). */
  private hills(x: number, z: number): number {
    const h =
      Math.sin(x * 0.011 + 1.3) * Math.cos(z * 0.013 + 0.4) * 4 +
      Math.sin(x * 0.027 + z * 0.019) * 1.6 +
      Math.cos(x * 0.051 - z * 0.043 + 2.1) * 0.6;
    return Math.max(-1, h + 2);
  }

  heightAt(x: number, z: number): number {
    const fx = (x - this.minX) / this.cell;
    const fz = (z - this.minZ) / this.cell;
    const c = Math.max(0, Math.min(this.cols - 2, Math.floor(fx)));
    const r = Math.max(0, Math.min(this.rows - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - c));
    const tz = Math.max(0, Math.min(1, fz - r));
    const h = (cc: number, rr: number) => this.heights[rr * this.cols + cc];
    return (
      h(c, r) * (1 - tx) * (1 - tz) + h(c + 1, r) * tx * (1 - tz) + h(c, r + 1) * (1 - tx) * tz + h(c + 1, r + 1) * tx * tz
    );
  }

  mesh(): THREE.Mesh {
    const geo = new THREE.PlaneGeometry((this.cols - 1) * this.cell, (this.rows - 1) * this.cell, this.cols - 1, this.rows - 1);
    geo.rotateX(-Math.PI / 2);
    // PlaneGeometry rows run from -z to +z after rotation; map each vertex to our grid.
    const pos = geo.getAttribute('position');
    const colors: number[] = [];
    const grass = new THREE.Color(0x6f9a45);
    const grassDark = new THREE.Color(0x587f36);
    const dirt = new THREE.Color(0x9a8a62);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + this.minX + ((this.cols - 1) * this.cell) / 2;
      const z = pos.getZ(i) + this.minZ + ((this.rows - 1) * this.cell) / 2;
      const col = Math.round((x - this.minX) / this.cell);
      const row = Math.round((z - this.minZ) / this.cell);
      const k = row * this.cols + col;
      pos.setXYZ(i, x, this.heights[k], z);
      const n = Math.sin(x * 0.07) * Math.cos(z * 0.06) * 0.5 + 0.5;
      c.copy(grass).lerp(grassDark, n * 0.7);
      // A worn verge right beside the walls.
      c.lerp(dirt, 1 - smoothstep(0.5, 4, this.roadDist[k]));
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.receiveShadow = true;
    mesh.renderOrder = ORDER.terrain;
    return mesh;
  }
}

function buildTrackScenery(track: Track, terrain: Terrain): THREE.Group {
  const group = new THREE.Group();
  group.add(terrain.mesh());
  group.add(buildFarGround(track));
  group.add(buildRoad(track));
  for (const curb of buildCurbs(track)) group.add(curb);
  group.add(buildStartLine(track));
  group.add(buildWalls(track));
  group.add(buildTrees(track, terrain));
  group.add(buildMountains(track));
  return group;
}

/** Flat ground beyond the terrain, out to the fog. */
function buildFarGround(track: Track): THREE.Mesh {
  const b = track.bounds;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshLambertMaterial({ color: 0x6a9442 }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set((b.minX + b.maxX) / 2, -0.05, (b.minZ + b.maxZ) / 2);
  mesh.renderOrder = ORDER.terrain;
  return mesh;
}

/**
 * Ribbon between two closed edge polylines, lifted slightly, facing up. Each quad gets its own
 * vertices so per-quad colours (curb stripes) stay crisp instead of blending.
 */
function stripGeometry(a: Vec3[], b: Vec3[], lift: number, colorOf?: (i: number) => THREE.Color): THREE.BufferGeometry {
  const n = a.length;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  // Triangle (a0, a1, b0) faces up when the cross product's y component is positive.
  // Which way round that is depends on track direction and which edge is which.
  const cy = (a[1].z - a[0].z) * (b[0].x - a[0].x) - (a[1].x - a[0].x) * (b[0].z - a[0].z);
  const flip = cy < 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const v = pos.length / 3;
    // Vertex order: a_i, b_i, a_j, b_j.
    pos.push(a[i].x, a[i].y + lift, a[i].z, b[i].x, b[i].y + lift, b[i].z, a[j].x, a[j].y + lift, a[j].z, b[j].x, b[j].y + lift, b[j].z);
    if (flip) idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    else idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    if (colorOf) {
      const c = colorOf(i);
      for (let k = 0; k < 4; k++) col.push(c.r, c.g, c.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (colorOf) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildRoad(track: Track): THREE.Mesh {
  const mesh = new THREE.Mesh(stripGeometry(track.leftEdge, track.rightEdge, 0.02), surfaceMaterial({ color: 0x3d3f44 }));
  mesh.receiveShadow = true;
  mesh.renderOrder = ORDER.road;
  return mesh;
}

function offsetEdge(track: Track, edge: Vec3[], amount: number): Vec3[] {
  return edge.map((p, i) => {
    const s = track.samples[i];
    // Inward = toward the centre line (heights follow the bank linearly).
    const dx = s.x - p.x;
    const dy = s.y - p.y;
    const dz = s.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: p.x + (dx / len) * amount, y: p.y + (dy / len) * amount, z: p.z + (dz / len) * amount };
  });
}

/** One mesh per side, red and white stripes. */
function buildCurbs(track: Track): THREE.Mesh[] {
  const red = new THREE.Color(0xd23a2e);
  const white = new THREE.Color(0xf2f2f2);
  const stripe = (i: number) => (Math.floor(i / 2) % 2 === 0 ? red : white);
  const mat = surfaceMaterial({ vertexColors: true });
  return [track.leftEdge, track.rightEdge].map((edge) => {
    const mesh = new THREE.Mesh(stripGeometry(edge, offsetEdge(track, edge, 0.9), 0.04, stripe), mat);
    mesh.receiveShadow = true;
    mesh.renderOrder = ORDER.curb;
    return mesh;
  });
}

function buildStartLine(track: Track): THREE.Mesh {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size * 8;
  canvas.height = size * 2;
  const ctx = canvas.getContext('2d')!;
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 2; y++) {
      ctx.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
      ctx.fillRect(x * size, y * size, size, size);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s0 = track.samples[0];
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(track.def.width, track.def.width / 4), surfaceMaterial({ map: tex }));
  mesh.rotation.order = 'YXZ';
  mesh.rotation.y = Math.atan2(s0.tx, s0.tz);
  mesh.rotation.x = -Math.PI / 2 - Math.atan(s0.slope);
  mesh.position.set(s0.x, s0.y + 0.06, s0.z);
  mesh.receiveShadow = true;
  mesh.renderOrder = ORDER.start;
  return mesh;
}

function buildWalls(track: Track): THREE.InstancedMesh {
  const { wallHeight, wallThickness } = track.def;
  // Boxes reach a little below the road so stepped segments on slopes leave no gaps.
  const below = 0.8;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(wallThickness, wallHeight + below, 1),
    new THREE.MeshLambertMaterial({ color: 0xe8e4da }),
    track.walls.length,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  track.walls.forEach((w, i) => {
    q.setFromAxisAngle(up, w.yaw);
    m.compose(new THREE.Vector3(w.x, w.y + (wallHeight - below) / 2, w.z), q, new THREE.Vector3(1, 1, w.length));
    mesh.setMatrixAt(i, m);
  });
  // Wall shadows are barely visible but would cost ~9k triangles in the shadow pass.
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

/** Scatter low-poly trees (pines and round ones) over the terrain for a sense of speed. */
function buildTrees(track: Track, terrain: Terrain): THREE.Group {
  const rand = mulberry32(track.def.id.length * 7919 + 42);
  const b = track.bounds;
  const minX = b.minX - 160;
  const maxX = b.maxX + 160;
  const minZ = b.minZ - 160;
  const maxZ = b.maxZ + 160;
  const clearance = track.def.width / 2 + 8;

  const spots: { x: number; y: number; z: number; s: number; round: boolean }[] = [];
  for (let tries = 0; spots.length < 340 && tries < 8000; tries++) {
    const x = minX + rand() * (maxX - minX);
    const z = minZ + rand() * (maxZ - minZ);
    const s = track.samples[nearestSampleIndex(track, x, z)];
    if (Math.hypot(s.x - x, s.z - z) < clearance) continue;
    spots.push({ x, y: terrain.heightAt(x, z), z, s: 0.7 + rand() * 0.8, round: rand() < 0.35 });
  }
  const pines = spots.filter((p) => !p.round);
  const rounds = spots.filter((p) => p.round);

  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2f });
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.3, 0.4, 2, 6), trunkMat, spots.length);
  const pineCrowns = new THREE.InstancedMesh(
    new THREE.ConeGeometry(2.2, 6, 7),
    new THREE.MeshLambertMaterial({ color: 0x2f6b33 }),
    pines.length,
  );
  const roundCrowns = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(2.6, 0),
    new THREE.MeshLambertMaterial({ color: 0x4f8a3a, flatShading: true }),
    rounds.length,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  spots.forEach((p, i) => {
    m.compose(new THREE.Vector3(p.x, p.y + p.s, p.z), q, new THREE.Vector3(p.s, p.s, p.s));
    trunks.setMatrixAt(i, m);
  });
  pines.forEach((p, i) => {
    m.compose(new THREE.Vector3(p.x, p.y + 5 * p.s, p.z), q, new THREE.Vector3(p.s, p.s, p.s));
    pineCrowns.setMatrixAt(i, m);
  });
  rounds.forEach((p, i) => {
    m.compose(new THREE.Vector3(p.x, p.y + 3.6 * p.s, p.z), q, new THREE.Vector3(p.s, p.s * 0.9, p.s));
    roundCrowns.setMatrixAt(i, m);
  });
  trunks.castShadow = pineCrowns.castShadow = roundCrowns.castShadow = true;
  const group = new THREE.Group();
  group.add(trunks, pineCrowns, roundCrowns);
  return group;
}

/** A ring of hazy low-poly mountains on the horizon. */
function buildMountains(track: Track): THREE.Mesh {
  const b = track.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const radius = 1400;
  const rand = mulberry32(track.def.id.charCodeAt(0) * 31 + 5);
  const segments = 72;
  const pos: number[] = [];
  const col: number[] = [];
  const base = new THREE.Color(0x8fa7bd);
  const peak = new THREE.Color(0xeef3f7);
  const heights = Array.from({ length: segments }, () => 80 + rand() * 220);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const h = heights[i];
    const pts = [
      [cx + Math.cos(a0) * radius, -10, cz + Math.sin(a0) * radius],
      [cx + Math.cos(am) * (radius - 60), h, cz + Math.sin(am) * (radius - 60)],
      [cx + Math.cos(a1) * radius, -10, cz + Math.sin(a1) * radius],
    ];
    for (const [k, p] of pts.entries()) {
      pos.push(p[0], p[1], p[2]);
      const c = k === 1 && h > 200 ? peak : base;
      col.push(c.r, c.g, c.b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
}

/** Gantry over the start line with five countdown lights. */
class StartLights {
  readonly group = new THREE.Group();
  private readonly lamps: THREE.MeshStandardMaterial[] = [];
  private state = '';

  constructor(track: Track) {
    const s0 = track.samples[0];
    const hw = track.def.width / 2;
    const span = hw + 1.6;
    const height = 6.5;
    const steel = new THREE.MeshLambertMaterial({ color: 0x2b2f36 });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      this.group.add(m);
      return m;
    };
    for (const side of [-1, 1]) add(new THREE.BoxGeometry(0.5, height, 0.5), steel, side * span, height / 2, 0);
    add(new THREE.BoxGeometry(span * 2 + 0.5, 0.9, 0.6), steel, 0, height, 0);
    // Banner on the beam.
    const banner = document.createElement('canvas');
    banner.width = 512;
    banner.height = 64;
    const ctx = banner.getContext('2d')!;
    ctx.fillStyle = '#c8281e';
    ctx.fillRect(0, 0, 512, 64);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 44px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('B E N Z I N A', 256, 34);
    const tex = new THREE.CanvasTexture(banner);
    tex.colorSpace = THREE.SRGBColorSpace;
    add(new THREE.PlaneGeometry(span * 1.4, 0.75), new THREE.MeshBasicMaterial({ map: tex }), 0, height + 0.95, -0.31).rotation.y = Math.PI;
    // Five lamps facing the grid (which sits behind the line, i.e. toward -z here).
    const housing = new THREE.MeshLambertMaterial({ color: 0x111111 });
    for (let i = 0; i < 5; i++) {
      // Local +x is the driver's left (they look along +z), so lamp 0 lights on the left.
      const x = (2 - i) * 1.1;
      add(new THREE.BoxGeometry(0.8, 0.8, 0.4), housing, x, height - 0.85, -0.2);
      const lamp = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0x000000 });
      const disc = add(new THREE.CircleGeometry(0.3, 12), lamp, x, height - 0.85, -0.41);
      disc.rotation.y = Math.PI;
      disc.castShadow = false;
      this.lamps.push(lamp);
    }
    this.group.position.set(s0.x, s0.y, s0.z);
    this.group.rotation.y = Math.atan2(s0.tx, s0.tz);
  }

  set(red: number, green: boolean): void {
    const key = `${red}${green}`;
    if (key === this.state) return;
    this.state = key;
    this.lamps.forEach((m, i) => {
      const on = green || i < red;
      m.color.set(green ? 0x0a3a12 : on ? 0x3a0606 : 0x1a0404);
      m.emissive.set(green ? 0x33ff66 : on ? 0xff2a1a : 0x000000);
      m.emissiveIntensity = on ? 2.2 : 0;
    });
  }
}

/** A grandstand with a crowd beside the main straight, just before the start line. */
function buildGrandstand(track: Track, terrain: Terrain): THREE.Group {
  const n = track.samples.length;
  const at = track.samples[(n - Math.round(n * 0.03)) % n];
  const r = { x: -at.tz, z: at.tx };
  const hw = track.def.width / 2;
  // On the outside (right-hand side) of the straight, behind the wall.
  const offset = hw + 9;
  const cx = at.x + r.x * offset;
  const cz = at.z + r.z * offset;
  const base = Math.min(at.y, terrain.heightAt(cx, cz));
  const group = new THREE.Group();
  const concrete = new THREE.MeshLambertMaterial({ color: 0xbab5aa });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0xc8281e });
  const length = 44;
  const tiers = 6;
  for (let t = 0; t < tiers; t++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(length, 0.9 * (t + 1), 1.4), concrete);
    step.position.set(0, (0.9 * (t + 1)) / 2, t * 1.4);
    step.castShadow = step.receiveShadow = true;
    group.add(step);
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(length + 2, 0.3, tiers * 1.4 + 2), roofMat);
  roof.position.set(0, tiers * 0.9 + 3.2, (tiers * 1.4) / 2 - 0.5);
  roof.rotation.x = -0.08;
  roof.castShadow = true;
  group.add(roof);
  for (const x of [-length / 2, 0, length / 2]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, tiers * 0.9 + 3.2, 0.3), concrete);
    post.position.set(x, (tiers * 0.9 + 3.2) / 2, tiers * 1.4 - 0.4);
    group.add(post);
  }
  // Crowd: one little box per seat, random shirt colours.
  const rand = mulberry32(7);
  const perRow = 50;
  const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.45, 0.8, 0.4), new THREE.MeshLambertMaterial(), perRow * tiers);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  let k = 0;
  for (let t = 0; t < tiers; t++) {
    for (let i = 0; i < perRow; i++) {
      if (rand() < 0.15) continue;
      m.compose(new THREE.Vector3(-length / 2 + 0.6 + i * ((length - 1.2) / perRow), 0.9 * (t + 1) + 0.4, t * 1.4), q, new THREE.Vector3(1, 0.8 + rand() * 0.4, 1));
      crowd.setMatrixAt(k, m);
      crowd.setColorAt(k, c.setHSL(rand(), 0.6, 0.45 + rand() * 0.2));
      k++;
    }
  }
  crowd.count = k;
  group.add(crowd);
  group.position.set(cx, base, cz);
  // Face the track: the stand's front (-z) toward the road.
  group.rotation.y = Math.atan2(r.x, r.z);
  return group;
}
