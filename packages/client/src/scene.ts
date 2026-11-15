import * as THREE from 'three';
import { nearestSampleIndex, type Track, type Vec2 } from '@benzina/shared';

export interface GameScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
}

const SKY = 0x9cc7e8;

export function createScene(track: Track): GameScene {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 150, 600);

  const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 1500);
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  scene.add(new THREE.HemisphereLight(0xdff1ff, 0x5a7a3a, 1.4));
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -60;
  sc.right = 60;
  sc.top = 60;
  sc.bottom = -60;
  sc.near = 1;
  sc.far = 200;
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000),
    new THREE.MeshLambertMaterial({ color: 0x6f9a45 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  scene.add(buildRoad(track));
  scene.add(buildCurbs(track));
  scene.add(buildStartLine(track));
  scene.add(buildWalls(track));
  scene.add(buildTrees(track));

  return { renderer, scene, camera, sun };
}

/**
 * Flat ribbon between two closed polylines at height y, facing up. Each quad gets its own
 * vertices so per-quad colours (curb stripes) stay crisp instead of blending.
 */
function stripGeometry(a: Vec2[], b: Vec2[], y: number, colorOf?: (i: number) => THREE.Color): THREE.BufferGeometry {
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
    pos.push(a[i].x, y, a[i].z, b[i].x, y, b[i].z, a[j].x, y, a[j].z, b[j].x, y, b[j].z);
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
  const mesh = new THREE.Mesh(
    stripGeometry(track.leftEdge, track.rightEdge, 0.01),
    new THREE.MeshLambertMaterial({ color: 0x3d3f44 }),
  );
  mesh.receiveShadow = true;
  return mesh;
}

function offsetEdge(track: Track, edge: Vec2[], amount: number): Vec2[] {
  return edge.map((p, i) => {
    const s = track.samples[i];
    // Inward = toward the centre line.
    const dx = s.x - p.x;
    const dz = s.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: p.x + (dx / len) * amount, z: p.z + (dz / len) * amount };
  });
}

function buildCurbs(track: Track): THREE.Group {
  const red = new THREE.Color(0xd23a2e);
  const white = new THREE.Color(0xf2f2f2);
  const stripe = (i: number) => (Math.floor(i / 2) % 2 === 0 ? red : white);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const group = new THREE.Group();
  for (const edge of [track.leftEdge, track.rightEdge]) {
    const mesh = new THREE.Mesh(stripGeometry(edge, offsetEdge(track, edge, 0.9), 0.02, stripe), mat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
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
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(track.def.width, track.def.width / 4),
    new THREE.MeshLambertMaterial({ map: tex }),
  );
  mesh.rotation.order = 'YXZ';
  mesh.rotation.y = Math.atan2(s0.tx, s0.tz);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(s0.x, 0.03, s0.z);
  mesh.receiveShadow = true;
  return mesh;
}

function buildWalls(track: Track): THREE.InstancedMesh {
  const { wallHeight, wallThickness } = track.def;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(wallThickness, wallHeight, 1),
    new THREE.MeshLambertMaterial({ color: 0xe8e4da }),
    track.walls.length,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  track.walls.forEach((w, i) => {
    q.setFromAxisAngle(up, w.yaw);
    m.compose(new THREE.Vector3(w.x, wallHeight / 2, w.z), q, new THREE.Vector3(1, 1, w.length));
    mesh.setMatrixAt(i, m);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
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

/** Scatter low-poly trees around the circuit for a sense of speed. */
function buildTrees(track: Track): THREE.Group {
  const rand = mulberry32(42);
  const xs = track.samples.map((s) => s.x);
  const zs = track.samples.map((s) => s.z);
  const minX = Math.min(...xs) - 120;
  const maxX = Math.max(...xs) + 120;
  const minZ = Math.min(...zs) - 120;
  const maxZ = Math.max(...zs) + 120;
  const clearance = track.def.width / 2 + 8;

  const spots: THREE.Vector3[] = [];
  for (let tries = 0; spots.length < 260 && tries < 5000; tries++) {
    const x = minX + rand() * (maxX - minX);
    const z = minZ + rand() * (maxZ - minZ);
    const s = track.samples[nearestSampleIndex(track, x, z)];
    if (Math.hypot(s.x - x, s.z - z) < clearance) continue;
    spots.push(new THREE.Vector3(x, 0, z));
  }

  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.3, 0.4, 2, 6),
    new THREE.MeshLambertMaterial({ color: 0x6b4a2f }),
    spots.length,
  );
  const crowns = new THREE.InstancedMesh(
    new THREE.ConeGeometry(2.2, 6, 7),
    new THREE.MeshLambertMaterial({ color: 0x2f6b33 }),
    spots.length,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  spots.forEach((p, i) => {
    const scale = 0.7 + rand() * 0.8;
    const sv = new THREE.Vector3(scale, scale, scale);
    m.compose(new THREE.Vector3(p.x, 1 * scale, p.z), q, sv);
    trunks.setMatrixAt(i, m);
    m.compose(new THREE.Vector3(p.x, 5 * scale, p.z), q, sv);
    crowns.setMatrixAt(i, m);
  });
  trunks.castShadow = crowns.castShadow = true;
  const group = new THREE.Group();
  group.add(trunks, crowns);
  return group;
}
