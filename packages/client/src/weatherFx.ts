import * as THREE from 'three';
import { inTunnel, nearestSampleIndex, trackPuddles, type Track, type Weather } from '@benzina/shared';

/** How each weather looks: sky, fog, light, road. */
export interface WeatherLook {
  horizon: number;
  zenith: number;
  fogNear: number;
  fogFar: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  sunColor: number;
  sunIntensity: number;
  /** Where the sun sits relative to the followed car (direction and height of shadows). */
  sunOffset: [number, number, number];
  /** Tint for the far mountains (they ignore fog), or null to hide them. */
  mountains: number | null;
  /** Wet, reflective road and puddles. */
  wet: boolean;
  /** Car headlight glow. */
  headlights: number;
  exposure: number;
}

export const LOOKS: Record<Weather, WeatherLook> = {
  clear: {
    horizon: 0xcfe3f2,
    zenith: 0x5d9bd6,
    fogNear: 220,
    fogFar: 900,
    hemiSky: 0xe4f2ff,
    hemiGround: 0x5a7a3a,
    hemiIntensity: 1.3,
    sunColor: 0xfff1dc,
    sunIntensity: 2.4,
    sunOffset: [30, 60, 20],
    mountains: 0xffffff,
    wet: false,
    headlights: 0.6,
    exposure: 1,
  },
  overcast: {
    horizon: 0xc3c9ce,
    zenith: 0x8c97a1,
    fogNear: 160,
    fogFar: 750,
    hemiSky: 0xdfe4e8,
    hemiGround: 0x5d6b52,
    hemiIntensity: 1.9,
    sunColor: 0xf2f2f2,
    sunIntensity: 0.8,
    sunOffset: [20, 70, 10],
    mountains: 0xc8ced3,
    wet: false,
    headlights: 0.9,
    exposure: 1,
  },
  rain: {
    horizon: 0x8e979e,
    zenith: 0x56606a,
    fogNear: 60,
    fogFar: 420,
    hemiSky: 0xc4ccd3,
    hemiGround: 0x48523f,
    hemiIntensity: 1.55,
    sunColor: 0xdfe6ee,
    sunIntensity: 0.45,
    sunOffset: [20, 70, 10],
    mountains: 0x9aa3ab,
    wet: true,
    headlights: 2.2,
    exposure: 0.95,
  },
  fog: {
    horizon: 0xc9ced2,
    zenith: 0xb9c0c6,
    fogNear: 12,
    fogFar: 135,
    hemiSky: 0xe8ecef,
    hemiGround: 0x6d7566,
    hemiIntensity: 1.8,
    sunColor: 0xffffff,
    sunIntensity: 0.6,
    sunOffset: [20, 70, 10],
    mountains: null,
    wet: false,
    headlights: 2.2,
    exposure: 1,
  },
  dusk: {
    horizon: 0xf0a06a,
    zenith: 0x34406e,
    fogNear: 200,
    fogFar: 850,
    hemiSky: 0xffc4a0,
    hemiGround: 0x3b3a4c,
    hemiIntensity: 1.05,
    sunColor: 0xff9550,
    sunIntensity: 2.1,
    // Low in the sky: long shadows.
    sunOffset: [70, 16, 45],
    mountains: 0xb98a7c,
    wet: false,
    headlights: 2.6,
    exposure: 1,
  },
};

/** Paint a sky dome's vertex colours from horizon to zenith. */
export function paintSky(geo: THREE.BufferGeometry, look: WeatherLook): void {
  const pos = geo.getAttribute('position');
  const horizon = new THREE.Color(look.horizon);
  const zenith = new THREE.Color(look.zenith);
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const r = (geo.boundingSphere ?? (geo.computeBoundingSphere(), geo.boundingSphere!)).radius;
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, pos.getY(i) / r);
    c.copy(horizon).lerp(zenith, Math.pow(t, 0.6));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * An environment map of the current sky, so the wet road and puddles reflect it. Rebuilt when
 * the weather changes (a few ms, once).
 */
export function skyEnvironment(renderer: THREE.WebGLRenderer, look: WeatherLook): THREE.Texture {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 24, 12);
  paintSky(geo, look);
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.02);
  pmrem.dispose();
  geo.dispose();
  return target.texture;
}

/**
 * Puddles as flat glossy patches on the road, matching the physics puddles (same positions and
 * widths). Rounded at the ends by narrowing over the first and last samples.
 */
export function buildPuddles(track: Track, material: THREE.Material): THREE.Mesh | null {
  const puddles = trackPuddles(track);
  if (puddles.length === 0) return null;
  const hw = track.def.width / 2;
  const pos: number[] = [];
  const idx: number[] = [];
  const pointAt = (i: number, lat: number) => {
    const l = track.leftEdge[i];
    const r = track.rightEdge[i];
    const t = (lat + hw) / (2 * hw);
    return [l.x + (r.x - l.x) * t, l.y + (r.y - l.y) * t + 0.035, l.z + (r.z - l.z) * t];
  };
  for (const p of puddles) {
    const count = p.i1 - p.i0 + 1;
    const base = pos.length / 3;
    for (let k = 0; k < count; k++) {
      const i = p.i0 + k;
      // Narrower at the ends (an oval-ish patch), wobbling a little.
      const u = count === 1 ? 0.5 : k / (count - 1);
      const w = p.halfWidth * (0.55 + 0.45 * Math.sin(Math.PI * u)) * (0.92 + 0.08 * Math.sin(i * 2.3));
      pos.push(...pointAt(i, p.lat - w), ...pointAt(i, p.lat + w));
      if (k > 0) {
        const a = base + (k - 1) * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Normals face up regardless of winding.
  const n = geo.getAttribute('normal');
  for (let i = 0; i < n.count; i++) if (n.getY(i) < 0) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  const mesh = new THREE.Mesh(geo, material);
  return mesh;
}

/** Falling rain: streaks in a box that travels with the camera, wrapped as they fall. */
export class Rain {
  readonly lines: THREE.LineSegments;
  private readonly drops: Float32Array;
  private readonly count: number;
  private readonly box = new THREE.Vector3(36, 22, 36);
  private readonly last = new THREE.Vector3();
  private opacity = 0;

  constructor(mobile: boolean) {
    this.count = mobile ? 900 : 2000;
    this.drops = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      this.drops.set([(Math.random() - 0.5) * this.box.x, Math.random() * this.box.y, (Math.random() - 0.5) * this.box.z], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.count * 6), 3));
    this.lines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0xd8e2ea, transparent: true, opacity: 0, depthWrite: false, fog: false }),
    );
    this.lines.frustumCulled = false;
    this.lines.visible = false;
  }

  /**
   * @param on raining, and the camera is out in it (not in a tunnel)
   * @param camera drops are kept around it; streaks lean back as the camera moves forward
   */
  update(on: boolean, camera: THREE.Camera, dt: number): void {
    this.opacity += ((on ? 0.38 : 0) - this.opacity) * (1 - Math.exp(-4 * dt));
    this.lines.visible = this.opacity > 0.01;
    (this.lines.material as THREE.LineBasicMaterial).opacity = this.opacity;
    if (!this.lines.visible) {
      this.last.copy(camera.position);
      return;
    }
    // Camera motion this frame: drops are in a camera-relative box, so moving through the rain
    // makes them stream past; streaks stretch along the relative velocity.
    const move = camera.position.clone().sub(this.last);
    this.last.copy(camera.position);
    if (move.length() > 5) move.set(0, 0, 0);
    const fall = 26 * dt;
    const vel = new THREE.Vector3(-move.x / Math.max(dt, 1e-3), -26, -move.z / Math.max(dt, 1e-3));
    const streak = vel.clone().multiplyScalar(0.035);
    const out = this.lines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = out.array as Float32Array;
    const { x: bx, y: by, z: bz } = this.box;
    const c = camera.position;
    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      let x = this.drops[k] - move.x;
      let y = this.drops[k + 1] - fall;
      let z = this.drops[k + 2] - move.z;
      // Wrap within the box around the camera.
      if (y < 0) y += by;
      x = ((((x + bx / 2) % bx) + bx) % bx) - bx / 2;
      z = ((((z + bz / 2) % bz) + bz) % bz) - bz / 2;
      this.drops[k] = x;
      this.drops[k + 1] = y;
      this.drops[k + 2] = z;
      const wx = c.x + x;
      const wy = c.y - by * 0.45 + y;
      const wz = c.z + z;
      const o = i * 6;
      arr[o] = wx;
      arr[o + 1] = wy;
      arr[o + 2] = wz;
      arr[o + 3] = wx - streak.x;
      arr[o + 4] = wy - streak.y;
      arr[o + 5] = wz - streak.z;
    }
    out.needsUpdate = true;
  }
}

/** Is the camera inside the track's tunnel (no rain falls there)? */
export function cameraInTunnel(track: Track | null, camera: THREE.Camera): boolean {
  if (!track?.tunnel) return false;
  const p = camera.position;
  const i = nearestSampleIndex(track, p.x, p.z);
  const s = track.samples[i];
  return inTunnel(track, i) && Math.hypot(p.x - s.x, p.z - s.z) < track.def.width && p.y < s.y + 7;
}
