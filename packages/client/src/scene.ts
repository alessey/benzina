import { buildSpeedway } from './speedway';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { crossSection, gapAfter, nearestSampleIndex, onDirt, overGap, rightOf, roadPoint, type Track, type Vec3, type Weather } from '@benzina/shared';
import { buildPuddles, cameraInTunnel, LOOKS, paintSky, Rain, skyEnvironment, type WeatherLook } from './weatherFx';

export interface GameScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  /** Swap the circuit: terrain, road, walls, scenery. */
  setTrack(track: Track): void;
  /** Ground height (terrain or road) at a point, for placing things. */
  heightAt(x: number, z: number): number;
  /** Call each frame before rendering (keeps the sky centred on the camera, moves the rain). */
  update(dt?: number): void;
  /** Sky, light, fog, wet road and rain for the race conditions. */
  setWeather(weather: Weather): void;
  readonly look: WeatherLook;
  /** Countdown gantry: how many red lights are lit (0–5), or all green. */
  setStartLights(red: number, green: boolean): void;
}

const HORIZON = new THREE.Color(0xcfe3f2);
/**
 * The flat ground beyond the terrain sits well below anything near the road, so it can never
 * cover the road surface (it extends under the whole circuit).
 */
const FAR_GROUND_Y = -2;
/** Harbour water surface and the sea bed beneath it. */
const WATER_Y = -0.7;
const WATER_FLOOR = -4;

function inWater(track: Track, x: number, z: number): boolean {
  return (track.def.water ?? []).some((w) => x >= w.minX && x <= w.maxX && z >= w.minZ && z <= w.maxZ);
}
const ZENITH = new THREE.Color(0x5d9bd6);

export interface SceneOptions {
  /** Phones/tablets: cheaper settings (MSAA off on dense screens, smaller shadow map, coarser terrain). */
  mobile: boolean;
}

/**
 * Draw order for things lying on the ground: terrain, then road, curbs, start line, each
 * drawn after the layer beneath. Every layer writes depth (so the road hides wall bases and
 * anything else below its surface), and each is pulled toward the camera with a stronger
 * polygon offset than the one below, so the stack wins its depth tests cleanly even on 16-bit
 * depth buffers. The terrain also sits 0.45 m under the road.
 */
const ORDER = { sky: -20, terrain: -10, road: -9, curb: -8, start: -7 } as const;

/** Like surfaceMaterial, but glossy (wet road, puddles). */
function surfaceMaterialStd(layer: number, params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    ...params,
    polygonOffset: true,
    polygonOffsetFactor: -2 * layer,
    polygonOffsetUnits: -8 * layer,
  });
}

function surfaceMaterial(layer: number, params: THREE.MeshLambertMaterialParameters): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    ...params,
    polygonOffset: true,
    polygonOffsetFactor: -2 * layer,
    polygonOffsetUnits: -8 * layer,
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

  const hemi = new THREE.HemisphereLight(0xe4f2ff, 0x5a7a3a, 1.3);
  scene.add(hemi);
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

  // Weather.
  let weather: Weather = 'clear';
  let look = LOOKS.clear;
  let env: THREE.Texture | null = null;
  const rain = new Rain(opts.mobile);
  scene.add(rain.lines);
  const wetRoad = surfaceMaterialStd(1, { color: 0x2c2e33, roughness: 0.28, metalness: 0.05, envMapIntensity: 1.1 });
  const puddleMat = surfaceMaterialStd(3, { color: 0x46525d, roughness: 0.03, metalness: 0.6, envMapIntensity: 1.15, side: THREE.DoubleSide });
  let dryRoad: THREE.Material | null = null;
  // Dirt, and the mud it turns into in the rain: darker and glossy.
  const dirtMat = surfaceMaterial(1, { vertexColors: true });
  const mudMat = surfaceMaterialStd(1, { vertexColors: true, color: 0xb09a84, roughness: 0.42, metalness: 0, envMapIntensity: 0.6 });

  /** Apply the weather to the current track's meshes (road surface, puddles, mountains). */
  const dressTrack = () => {
    if (!trackGroup) return;
    const road = trackGroup.getObjectByName('road') as THREE.Mesh | undefined;
    if (road) {
      dryRoad ??= road.material as THREE.Material;
      if (road.material !== wetRoad && road.material !== dryRoad) dryRoad = road.material as THREE.Material;
      // A bobsled channel is ice, not asphalt: it keeps its own surface in the rain.
      road.material = look.wet && !terrain?.track.def.pipe ? wetRoad : dryRoad;
    }
    const dirtRoad = trackGroup.getObjectByName('dirtRoad') as THREE.Mesh | undefined;
    // Dirt turns to mud in the rain; snow just gets fresh snow on it.
    if (dirtRoad) dirtRoad.material = look.wet && !terrain?.track.def.snow ? mudMat : dirtMat;
    const puddles = trackGroup.getObjectByName('puddles');
    if (puddles) puddles.visible = look.wet;
    const mountains = trackGroup.getObjectByName('mountains') as THREE.Mesh | undefined;
    if (mountains) {
      mountains.visible = look.mountains !== null;
      if (look.mountains !== null) (mountains.material as THREE.MeshBasicMaterial).color.setHex(look.mountains);
    }
  };

  return {
    renderer,
    scene,
    camera,
    sun,
    get look() {
      return look;
    },
    setWeather(w: Weather) {
      if (w === weather && env) return;
      weather = w;
      look = LOOKS[w];
      (scene.background as THREE.Color).setHex(look.horizon);
      const fog = scene.fog as THREE.Fog;
      fog.color.setHex(look.horizon);
      fog.near = look.fogNear;
      fog.far = look.fogFar;
      hemi.color.setHex(look.hemiSky);
      hemi.groundColor.setHex(look.hemiGround);
      hemi.intensity = look.hemiIntensity;
      sun.color.setHex(look.sunColor);
      sun.intensity = look.sunIntensity;
      renderer.toneMappingExposure = look.exposure;
      paintSky(sky.geometry, look);
      env?.dispose();
      env = skyEnvironment(renderer, look);
      wetRoad.envMap = env;
      puddleMat.envMap = env;
      mudMat.envMap = env;
      mudMat.needsUpdate = true;
      wetRoad.needsUpdate = true;
      puddleMat.needsUpdate = true;
      dressTrack();
    },
    setTrack(track: Track) {
      if (terrain?.track === track) return;
      if (trackGroup) {
        // Shared weather materials outlive the track: detach them before disposing.
        const road = trackGroup.getObjectByName('road') as THREE.Mesh | undefined;
        if (road && dryRoad) road.material = dryRoad;
        // The dirt surface's materials are shared too: take its mesh out before disposing.
        const oldDirt = trackGroup.getObjectByName('dirtRoad') as THREE.Mesh | undefined;
        if (oldDirt) {
          oldDirt.removeFromParent();
          oldDirt.geometry.dispose();
        }
        const oldPuddles = trackGroup.getObjectByName('puddles') as THREE.Mesh | undefined;
        if (oldPuddles) {
          oldPuddles.removeFromParent();
          oldPuddles.geometry.dispose();
        }
        scene.remove(trackGroup);
        disposeTree(trackGroup);
      }
      terrain = new Terrain(track, opts.mobile ? 9 : 7);
      trackGroup = buildTrackScenery(track, terrain);
      lights = new StartLights(track);
      trackGroup.add(lights.group);
      if (track.def.scenery !== 'speedway') trackGroup.add(buildGrandstand(track, terrain));
      const dirtRoad = buildDirtRoad(track, dirtMat);
      if (dirtRoad) trackGroup.add(dirtRoad);
      const puddles = buildPuddles(track, puddleMat);
      if (puddles) {
        puddles.name = 'puddles';
        puddles.renderOrder = ORDER.start + 0.5;
        puddles.receiveShadow = true;
        trackGroup.add(puddles);
      }
      dryRoad = null;
      scene.add(trackGroup);
      dressTrack();
    },
    setStartLights(red, green) {
      lights?.set(red, green);
    },
    heightAt(x, z) {
      return terrain ? terrain.heightAt(x, z) : 0;
    },
    update(dt = 1 / 60) {
      sky.position.copy(camera.position);
      rain.update(weather === 'rain' && !cameraInTunnel(terrain?.track ?? null, camera), camera, dt, !!terrain?.track.def.snow);
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
const RAVINE_ROCK = new THREE.Color(0x5f646c);
/** Lighter layers in a ravine's rock, near the top. */
const RAVINE_STRATA = new THREE.Color(0x8c9097);
/** Deep in a ravine, out of the light. */
const RAVINE_DEEP = new THREE.Color(0x30343a);
/** Snow-dusted rock on a ravine's floor. */
const RAVINE_FLOOR = new THREE.Color(0xaab3bd);

/**
 * A chasm's ravine: a gorge across the track between the lip and the landing, running out to
 * either side (narrowing and shallowing at its ends), its floor far below the road.
 */
function chasmRavine(track: Track): { carve: (x: number, z: number, margin?: number) => number; floor: number; top: number } | null {
  if (!track.gap) return null;
  const [a, b] = track.gap;
  const lip = track.samples[a];
  const land = track.samples[b];
  const mx = (lip.x + land.x) / 2;
  const mz = (lip.z + land.z) / 2;
  const len = Math.hypot(land.x - lip.x, land.z - lip.z);
  const tx = (land.x - lip.x) / len;
  const tz = (land.z - lip.z) / len;
  const half = len / 2;
  return {
    floor: Math.min(lip.y, land.y) - 32,
    top: Math.min(lip.y, land.y),
    /** How far (x, z) is carved in (0..1); `margin` widens it (for colouring the rock rim). */
    carve: (x: number, z: number, margin = 0) => {
      const along = (x - mx) * tx + (z - mz) * tz;
      const lat = (x - mx) * -tz + (z - mz) * tx;
      // The gorge's walls drop away right at the lip and the landing (the road ends at a cliff
      // edge); away from the road it wanders a little and widens.
      const off = smoothstep(12, 60, Math.abs(lat));
      const width = half - 0.5 + margin + off * (3 + 1.5 * Math.sin(lat * 0.08));
      const across = 1 - smoothstep(width, width + 5, Math.abs(along - off * 2 * Math.sin(lat * 0.05)));
      const ends = 1 - smoothstep(55 + margin, 90 + margin, Math.abs(lat));
      return across * ends;
    },
  };
}

/** Box blur of a grid in place, `radius` cells each way (separable, edges clamped). */
function blurGrid(grid: Float32Array, cols: number, rows: number, radius: number): void {
  const tmp = new Float32Array(grid.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += grid[r * cols + Math.min(cols - 1, Math.max(0, c + k))];
      tmp[r * cols + c] = sum / (2 * radius + 1);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += tmp[Math.min(rows - 1, Math.max(0, r + k)) * cols + c];
      grid[r * cols + c] = sum / (2 * radius + 1);
    }
  }
}

class Terrain {
  readonly minX: number;
  readonly minZ: number;
  readonly cols: number;
  readonly rows: number;
  readonly heights: Float32Array;
  readonly roadDist: Float32Array;
  /** 0..1 how far each point has been carved into a chasm's ravine (bare rock, not snow). */
  readonly rock: Float32Array;

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
    this.rock = new Float32Array(this.cols * this.rows);
    const hw = track.def.width / 2;
    const count = this.cols * this.rows;
    const nearRoads = new Float32Array(count);
    const naturals = new Float32Array(count);
    const blends = new Float32Array(count);
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
        const clamped = Math.max(-hw, Math.min(hw, across));
        // (A bobsled channel stands on ground at its floor level, walls and all: the terrain
        // grid is too coarse to follow its curved walls without cutting through them.)
        // Under a steeply banked turn the road surface curves around the corner while the coarse
        // terrain triangles cut straight across it, so they'd poke through near the edges: sink
        // the ground under the road a little more the steeper the bank (hidden by the road).
        const sink = track.steepBanks ? Math.tan(Math.abs(s.bank)) * 3 * (1 - smoothstep(hw - 0.5, hw + 0.5, Math.abs(across))) : 0;
        const nearRoad = s.y - Math.tan(s.bank) * clamped - 0.45 - sink;
        // Edges of the terrain fade down to the far ground plane.
        const edge = Math.min(c, r, this.cols - 1 - c, this.rows - 1 - r) * cell;
        const fade = smoothstep(0, 120, edge);
        const wet = inWater(track, x, z);
        // Countryside rolls; a city climbs the hillside with its streets; the harbour is deep.
        const scenery = track.def.scenery;
        // A speedway sits on flat, levelled ground; the hills start well away from it.
        const land =
          scenery === 'city'
            ? s.y * 0.9
            : scenery === 'snow'
              ? s.y * 0.85 + this.hills(x, z) * 1.6
              : scenery === 'speedway'
                ? this.hills(x, z) * smoothstep(90, 260, d)
                : this.hills(x, z);
        const natural = wet ? WATER_FLOOR : land * fade + FAR_GROUND_Y * (1 - fade);
        // At the water's edge the land drops sharply (a quay wall) instead of a long bank.
        const w = wet ? smoothstep(hw + 2, hw + 9, d) : smoothstep(hw + 4, hw + 50, d);
        nearRoads[r * this.cols + c] = nearRoad;
        naturals[r * this.cols + c] = natural;
        blends[r * this.cols + c] = w;
        this.roadDist[r * this.cols + c] = d - hw;
      }
    }
    // A mountainside follows the road's height, taken from the nearest stretch of road; between
    // two legs of a switchback that jumps from one leg's height to the other's, leaving cliffs.
    // Smooth it into a slope (the road itself, and the ground right beside it, aren't affected).
    if (track.def.scenery === 'snow') {
      for (let pass = 0; pass < 3; pass++) blurGrid(naturals, this.cols, this.rows, Math.max(1, Math.round(21 / cell)));
    }
    // The mountain a tunnel goes through rises out of the land around it.
    const mountain = tunnelMountain(track);
    if (mountain) {
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) naturals[r * this.cols + c] += mountain(this.minX + c * cell, this.minZ + r * cell);
      }
    }
    for (let k = 0; k < count; k++) this.heights[k] = nearRoads[k] * (1 - blends[k]) + naturals[k] * blends[k];
    // A chasm: a deep ravine across the road between the lip and the landing.
    const ravine = chasmRavine(track);
    if (ravine) {
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const k = r * this.cols + c;
          const x = this.minX + c * cell;
          const z = this.minZ + r * cell;
          // Rock colour reaches a little past the carve, so the coarse grid's walls are rock
          // from the rim down instead of fading from snow.
          this.rock[k] = ravine.carve(x, z, cell * 0.8);
          const carve = ravine.carve(x, z);
          if (carve <= 0) continue;
          this.heights[k] += (ravine.floor - this.heights[k]) * carve;
        }
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

  /**
   * Height of the rendered terrain surface. Interpolates within the same two triangles the
   * mesh uses per cell (PlaneGeometry splits each cell along the (c, r+1)–(c+1, r) diagonal),
   * so this matches what's drawn exactly.
   */
  heightAt(x: number, z: number): number {
    const fx = (x - this.minX) / this.cell;
    const fz = (z - this.minZ) / this.cell;
    const c = Math.max(0, Math.min(this.cols - 2, Math.floor(fx)));
    const r = Math.max(0, Math.min(this.rows - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - c));
    const tz = Math.max(0, Math.min(1, fz - r));
    const h = (cc: number, rr: number) => this.heights[rr * this.cols + cc];
    if (tx + tz <= 1) {
      // Triangle (c, r), (c+1, r), (c, r+1).
      return h(c, r) + (h(c + 1, r) - h(c, r)) * tx + (h(c, r + 1) - h(c, r)) * tz;
    }
    // Triangle (c+1, r+1), (c, r+1), (c+1, r).
    return h(c + 1, r + 1) + (h(c, r + 1) - h(c + 1, r + 1)) * (1 - tx) + (h(c + 1, r) - h(c + 1, r + 1)) * (1 - tz);
  }

  mesh(): THREE.Mesh {
    const geo = new THREE.PlaneGeometry((this.cols - 1) * this.cell, (this.rows - 1) * this.cell, this.cols - 1, this.rows - 1);
    geo.rotateX(-Math.PI / 2);
    // PlaneGeometry rows run from -z to +z after rotation; map each vertex to our grid.
    const pos = geo.getAttribute('position');
    const colors: number[] = [];
    const scenery = this.track.def.scenery ?? 'country';
    const palette = {
      country: [0x6f9a45, 0x587f36, 0x9a8a62],
      city: [0xbdb4a2, 0xa69d8b, 0x8c8a86],
      snow: [0xf2f5f8, 0xdbe4ec, 0xcdd7e0],
      speedway: [0x74a64a, 0x669a40, 0x9a8a62],
    }[scenery];
    const grass = new THREE.Color(palette[0]);
    const grassDark = new THREE.Color(palette[1]);
    const dirt = new THREE.Color(palette[2]);
    const c = new THREE.Color();
    const ravine = chasmRavine(this.track);
    const rockColor = new THREE.Color();
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
      // Bare rock down the walls of a ravine: layered, and darker the deeper it goes.
      if (this.rock[k] > 0 && ravine) {
        const y = this.heights[k];
        const depth = Math.min(1, Math.max(0, (ravine.top - y) / (ravine.top - ravine.floor)));
        const band = Math.sin(y * 0.9 + Math.sin(x * 0.05) * 1.5) > 0.35 ? 1 : 0;
        // Darker down the walls, but the floor collects snow: a lighter surface at the bottom
        // shows how far down it is.
        rockColor.copy(RAVINE_ROCK).lerp(RAVINE_STRATA, band * 0.6 * (1 - depth)).lerp(RAVINE_DEEP, depth * 0.5);
        rockColor.lerp(RAVINE_FLOOR, smoothstep(0.8, 0.97, depth));
        c.lerp(rockColor, Math.min(1, this.rock[k] * 3));
      }
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
  const bales = buildHayBales(track, terrain);
  if (bales) group.add(bales);
  const edges = buildChasmEdges(track);
  if (edges) group.add(edges);
  for (const curb of buildCurbs(track)) group.add(curb);
  group.add(buildStartLine(track));
  for (const ramp of buildRampMarkings(track)) group.add(ramp);
  group.add(buildWalls(track));
  if (track.def.pipe) group.add(buildChannelSides(track));
  if (track.def.scenery === 'city') {
    group.add(buildBuildings(track, terrain));
  } else {
    group.add(buildTrees(track, terrain));
  }
  if (track.def.scenery === 'speedway') group.add(buildSpeedway(track, (x, z) => terrain.heightAt(x, z)));
  for (const water of buildWater(track)) group.add(water);
  const tunnel = buildTunnel(track, terrain);
  if (tunnel) group.add(tunnel);
  const mountains = buildMountains(track);
  mountains.name = 'mountains';
  group.add(mountains);
  return group;
}

/** Flat ground beyond the terrain, out to the fog. */
function buildFarGround(track: Track): THREE.Mesh {
  const b = track.bounds;
  const color = track.def.scenery === 'city' ? 0xb3aa98 : track.def.scenery === 'snow' ? 0xe9eef2 : track.def.scenery === 'speedway' ? 0x6c9c44 : 0x6a9442;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshLambertMaterial({ color }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set((b.minX + b.maxX) / 2, FAR_GROUND_Y, (b.minZ + b.maxZ) / 2);
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

/** Remove the quads over a chasm from a strip built one quad (6 indices) per sample. */
function dropGapQuads(track: Track, geo: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!track.gap) return geo;
  const index = Array.from(geo.getIndex()!.array);
  const keep: number[] = [];
  for (let q = 0; q * 6 < index.length; q++) if (!gapAfter(track, q)) keep.push(...index.slice(q * 6, q * 6 + 6));
  geo.setIndex(keep);
  return geo;
}

/** Samples either side of a dirt section over which the surface blends from tarmac to dirt. */
const DIRT_BLEND = 4;

/** How much dirt there is at sample i: 1 on the dirt section, fading to 0 over DIRT_BLEND. */
function dirtAmount(track: Track, i: number): number {
  if (!track.dirt && !track.def.snow) return 0;
  const n = track.samples.length;
  for (let k = 0; k <= DIRT_BLEND; k++) {
    if (onDirt(track, (i + k) % n) || onDirt(track, (i - k + n) % n)) return 1 - k / (DIRT_BLEND + 1);
  }
  return 0;
}

function buildRoad(track: Track): THREE.Mesh {
  const geo = track.def.pipe ? channelGeometry(track) : stripGeometry(track.leftEdge, track.rightEdge, 0.02);
  if (track.dirt || track.def.snow) {
    // The dirt or snow (and its blend into the tarmac) is a mesh of its own.
    const index = Array.from(geo.getIndex()!.array);
    const keep: number[] = [];
    for (let q = 0; q < track.samples.length; q++) if (dirtAmount(track, q) === 0) keep.push(...index.slice(q * 6, q * 6 + 6));
    geo.setIndex(keep);
  }
  dropGapQuads(track, geo);
  const mat = track.def.pipe ? surfaceMaterial(1, { vertexColors: true }) : surfaceMaterial(1, { color: 0x3d3f44 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'road';
  mesh.receiveShadow = true;
  mesh.renderOrder = ORDER.road;
  return mesh;
}

/**
 * The dirt section's surface: brown with blotches, darker ruts worn along the racing lines,
 * blending into the tarmac at either end. Several columns across, so the ruts show.
 */
function buildDirtRoad(track: Track, material: THREE.Material): THREE.Mesh | null {
  if (!track.dirt && !track.def.snow) return null;
  const n = track.samples.length;
  const cols = 12;
  const asphalt = new THREE.Color(0x3d3f44);
  // Packed snow is white with grey-blue ruts; dirt is brown with darker ruts.
  const snow = !!track.def.snow;
  const dirt = new THREE.Color(snow ? 0xeef2f6 : 0x9b7a52);
  const dark = new THREE.Color(snow ? 0xa9b6c2 : 0x6e5236);
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();
  let rows = 0;
  let prevIncluded = false;
  for (let k = 0; k <= n; k++) {
    const i = k % n;
    const amount = dirtAmount(track, i);
    const next = dirtAmount(track, (i + 1) % n);
    // Include a row if it or a neighbour touches dirt, so the mesh covers each quad once.
    const included = amount > 0 || next > 0 || dirtAmount(track, (i - 1 + n) % n) > 0;
    if (!included) {
      prevIncluded = false;
      continue;
    }
    const s = track.samples[i];
    for (let j = 0; j <= cols; j++) {
      const f = -1 + (2 * j) / cols;
      const p = roadPoint(track, i, f, 0.02);
      pos.push(p.x, p.y, p.z);
      // Blotches (from position, so they don't swim) and two ruts each side of centre.
      const blotch = Math.sin(p.x * 0.31 + Math.cos(p.z * 0.17) * 2) * Math.cos(p.z * 0.27 - p.x * 0.05) * 0.5 + 0.5;
      const rut = Math.max(0, 1 - Math.abs(Math.abs(f) - 0.32) / 0.12) * (0.75 + 0.25 * Math.sin(s.dist * 0.4 + j));
      const edge = Math.max(0, (Math.abs(f) - 0.85) / 0.15);
      c.copy(dirt).lerp(dark, Math.min(1, blotch * 0.45 + rut * 0.7 + edge * 0.3));
      c.lerp(asphalt, 1 - amount);
      col.push(c.r, c.g, c.b);
    }
    if (prevIncluded && rows > 0) {
      const a = (rows - 1) * (cols + 1);
      const b = rows * (cols + 1);
      // (No surface across a chasm.)
      if (!gapAfter(track, (i - 1 + n) % n)) for (let j = 0; j < cols; j++) idx.push(a + j, b + j, a + j + 1, a + j + 1, b + j, b + j + 1);
    }
    rows++;
    prevIncluded = true;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Face up whichever way round the rows run.
  if (geo.getAttribute('normal').getY(0) < 0) {
    geo.setIndex(idx.map((_, k) => idx[k - (k % 3) + [0, 2, 1][k % 3]]));
    geo.computeVertexNormals();
  }
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'dirtRoad';
  mesh.receiveShadow = true;
  mesh.renderOrder = ORDER.road;
  return mesh;
}

/**
 * Hay bales lined up outside the walls along the dirt section.
 */
function buildHayBales(track: Track, terrain: Terrain): THREE.InstancedMesh | null {
  if (track.def.snow) return buildSnowPoles(track, terrain);
  if (!track.dirt) return null;
  const n = track.samples.length;
  const rand = mulberry32(91);
  const spots: THREE.Matrix4[] = [];
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let i = 0; i < n; i += 2) {
    if (!onDirt(track, i)) continue;
    for (const [edge, side] of [
      [track.leftEdge, -1],
      [track.rightEdge, 1],
    ] as const) {
      if (rand() < 0.45) continue;
      const s = track.samples[i];
      const r = rightOf(s.tx, s.tz);
      const out = side * (track.def.wallThickness + 1.1);
      const x = edge[i].x + r.x * out;
      const z = edge[i].z + r.z * out;
      // Lying on its side, along the track.
      q.setFromEuler(e.set(0, Math.atan2(s.tx, s.tz), Math.PI / 2, 'YXZ'));
      spots.push(new THREE.Matrix4().compose(new THREE.Vector3(x, terrain.heightAt(x, z) + 0.62, z), q, new THREE.Vector3(1, 1, 1)));
    }
  }
  const geo = new THREE.CylinderGeometry(0.65, 0.65, 1.4, 10);
  geo.rotateX(Math.PI / 2);
  geo.rotateZ(Math.PI / 2);
  const bales = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xd2ad5c }), spots.length);
  spots.forEach((m, k) => bales.setMatrixAt(k, m));
  bales.castShadow = true;
  bales.receiveShadow = true;
  return bales;
}

/**
 * Rock cliff edges just under the chasm's lip and its landing: a few metres of bare rock with
 * a ragged bottom, so the white road ends at a crisp rock edge you can see from the air.
 * (Shallow: below them the ravine's own rock walls take over.)
 */
function buildChasmEdges(track: Track): THREE.Mesh | null {
  if (!track.gap) return null;
  const hw = track.def.width / 2 + track.def.wallThickness + 1.5;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const top = new THREE.Color(0x7b8088);
  const bottom = new THREE.Color(0x3a3e44);
  const [lip, landing] = track.gap;
  for (const i of [lip, landing]) {
    const s = track.samples[i];
    const r = rightOf(s.tx, s.tz);
    // Face the gap: the lip's face looks forward, the landing's back toward the lip.
    const out = i === lip ? 0.05 : -0.05;
    const cols = 14;
    const base = pos.length / 3;
    for (let k = 0; k <= cols; k++) {
      const lat = -hw + (2 * hw * k) / cols;
      const x = s.x + r.x * lat + s.tx * out;
      const z = s.z + r.z * lat + s.tz * out;
      const y = s.y - Math.tan(s.bank) * Math.max(-track.def.width / 2, Math.min(track.def.width / 2, lat));
      const ragged = 3.2 + 1.6 * Math.abs(Math.sin(k * 2.7 + i)) + (k === 0 || k === cols ? -2 : 0);
      pos.push(x, y + 0.03, z, x + s.tx * out * 20, y - ragged, z + s.tz * out * 20);
      col.push(top.r, top.g, top.b, bottom.r, bottom.g, bottom.b);
      if (k > 0) {
        const a = base + (k - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  const flat = geo.toNonIndexed();
  flat.computeVertexNormals();
  const mesh = new THREE.Mesh(flat, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }));
  mesh.receiveShadow = true;
  return mesh;
}

/** Orange marker poles along both sides of a snow road, so its edges read in snowfall and fog. */
function buildSnowPoles(track: Track, terrain: Terrain): THREE.InstancedMesh {
  const n = track.samples.length;
  const spots: THREE.Matrix4[] = [];
  for (let i = 0; i < n; i += 4) {
    if (!onDirt(track, i) || overGap(track, i)) continue;
    for (const [edge, side] of [
      [track.leftEdge, -1],
      [track.rightEdge, 1],
    ] as const) {
      const s = track.samples[i];
      const r = rightOf(s.tx, s.tz);
      const out = side * (track.def.wallThickness + 0.4);
      const x = edge[i].x + r.x * out;
      const z = edge[i].z + r.z * out;
      const base = Math.max(terrain.heightAt(x, z), edge[i].y - 0.5);
      spots.push(new THREE.Matrix4().makeTranslation(x, base + 1.1, z));
    }
  }
  const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.06, 2.2, 5), new THREE.MeshLambertMaterial({ color: 0xf06a1f }), spots.length);
  spots.forEach((m, k) => poles.setMatrixAt(k, m));
  return poles;
}

/**
 * A bobsled channel's ice: the cross-section swept along the track, pale blue on the floor
 * shading to white up the walls, with a faint blue guide line down each side of the floor.
 */
function channelGeometry(track: Track): THREE.BufferGeometry {
  const cols = crossSection(track.def);
  const n = track.samples.length;
  const m = cols.length;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const floor = new THREE.Color(0xeef5fa);
  const wall = new THREE.Color(0xffffff);
  const line = new THREE.Color(0x7fa8d4);
  const c = new THREE.Color();
  const pipe = track.def.pipe!;
  const hw = track.def.width / 2;
  for (let i = 0; i < n; i++) {
    cols.forEach((f) => {
      const p = roadPoint(track, i, f, 0.02);
      pos.push(p.x, p.y, p.z);
      const up = Math.max(0, Math.abs(f * hw) - pipe.floor) / (hw - pipe.floor);
      c.copy(floor).lerp(wall, Math.min(1, up * 1.4));
      // The floor's edges (where the walls begin) carry a blue line.
      if (Math.abs(Math.abs(f * hw) - pipe.floor) < 1e-3) c.copy(line);
      col.push(c.r, c.g, c.b);
    });
  }
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    for (let j = 0; j < m - 1; j++) {
      const a = i * m + j;
      const b = next * m + j;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Face up whichever way round the columns run.
  if (geo.getAttribute('normal').getY(Math.floor(m / 2)) < 0) {
    geo.setIndex(idx.map((_, k) => idx[k - (k % 3) + [0, 2, 1][k % 3]]));
    geo.computeVertexNormals();
  }
  return geo;
}

/** The outside faces of a bobsled channel's walls, from the lip down into the ground. */
function buildChannelSides(track: Track): THREE.Mesh {
  const n = track.samples.length;
  const pos: number[] = [];
  const idx: number[] = [];
  for (const [edge, side] of [[track.leftEdge, -1], [track.rightEdge, 1]] as const) {
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const e = edge[i];
      const s = track.samples[i];
      const r = rightOf(s.tx, s.tz);
      // Slightly outside the lip, so the face never shows through the ice.
      const x = e.x + r.x * side * 0.05;
      const z = e.z + r.z * side * 0.05;
      pos.push(x, e.y, z, x, s.y - 1.2, z);
    }
    for (let i = 0; i < n; i++) {
      const a = base + i * 2;
      const b = base + ((i + 1) % n) * 2;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xd9e1e8, side: THREE.DoubleSide }));
  mesh.receiveShadow = true;
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
  // Ice channels get a blue-and-white lip instead of red-and-white curbs.
  const red = new THREE.Color(track.def.pipe ? 0x3a78c0 : 0xd23a2e);
  const white = new THREE.Color(0xf2f2f2);
  // On dirt, a low earth berm instead of painted curbs.
  const berm = new THREE.Color(track.def.snow ? 0xf6f9fb : 0x7a5c3c);
  const stripe = (i: number) => (onDirt(track, i) ? berm : Math.floor(i / 2) % 2 === 0 ? red : white);
  const mat = surfaceMaterial(2, { vertexColors: true });
  // A channel's lip follows the curved wall, so it's built from points on the surface.
  const lip = (side: number) => {
    const inner = 1 - 0.9 / (track.def.width / 2);
    return track.samples.map((_, i) => roadPoint(track, i, side * inner));
  };
  return [track.leftEdge, track.rightEdge].map((edge, k) => {
    const inner = track.def.pipe ? lip(k === 0 ? -1 : 1) : offsetEdge(track, edge, 0.9);
    const mesh = new THREE.Mesh(dropGapQuads(track, stripGeometry(edge, inner, 0.04, stripe)), mat);
    mesh.receiveShadow = true;
    mesh.renderOrder = ORDER.curb;
    return mesh;
  });
}

/**
 * Yellow/black hazard stripes on the approach to each jump lip, so ramps read at speed.
 * Lips are found from the track itself: a steep climb straight into a drop.
 */
function buildRampMarkings(track: Track): THREE.Mesh[] {
  if (!track.def.jumps) return [];
  const n = track.samples.length;
  const at = (i: number) => track.samples[((i % n) + n) % n];
  const yellow = new THREE.Color(0xf2c41a);
  const black = new THREE.Color(0x1a1a1a);
  const meshes: THREE.Mesh[] = [];
  for (let i = 0; i < n; i++) {
    const isLip = at(i - 2).slope > 0.08 && at(i + 2).slope < 0 && at(i).y >= at(i - 1).y && at(i).y >= at(i + 1).y;
    if (!isLip) continue;
    // Stripes over the last ~12 m of the ramp, inset from the curbs.
    const from = i - 4;
    const left = [];
    const right = [];
    for (let k = from; k <= i; k++) {
      const s = at(k);
      const l = track.leftEdge[((k % n) + n) % n];
      const r = track.rightEdge[((k % n) + n) % n];
      const inset = 1.3 / (track.def.width);
      left.push({ x: l.x + (r.x - l.x) * inset, y: l.y + (r.y - l.y) * inset, z: l.z + (r.z - l.z) * inset });
      right.push({ x: r.x + (l.x - r.x) * inset, y: r.y + (l.y - r.y) * inset, z: r.z + (l.z - r.z) * inset });
      void s;
    }
    // stripGeometry closes the loop; build an open strip by trimming the wrap-around quad.
    const geo = stripGeometry(left, right, 0.05, (q) => (q % 2 === 0 ? yellow : black));
    const index = geo.getIndex()!;
    geo.setIndex(Array.from(index.array).slice(0, (left.length - 1) * 6));
    const mesh = new THREE.Mesh(geo, surfaceMaterial(2, { vertexColors: true }));
    mesh.receiveShadow = true;
    mesh.renderOrder = ORDER.curb;
    meshes.push(mesh);
  }
  return meshes;
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
  // A strip lying exactly on the road: corners come from the road's own (banked, sloped) edges,
  // so the line never floats above or sinks into the surface.
  const s0 = track.samples[0];
  const half = track.def.width / 8; // the line is a quarter of the road width deep
  const lift = 0.06;
  const cols = track.def.pipe ? 24 : 8;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const [row, along] of [-half, half].entries()) {
    for (let c = 0; c <= cols; c++) {
      const t = c / cols;
      // On the road surface across its width (following a channel's curved walls).
      const p = roadPoint(track, 0, -1 + 2 * t);
      pos.push(p.x + s0.tx * along, p.y + s0.slope * along + lift, p.z + s0.tz * along);
      uv.push(t, row);
    }
  }
  for (let c = 0; c < cols; c++) {
    const a = c;
    const b = c + 1;
    const d = c + cols + 1;
    const e = c + cols + 2;
    idx.push(a, d, b, b, d, e);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Make sure it faces up whichever way round the edges are.
  if (geo.getAttribute('normal').getY(0) < 0) {
    geo.setIndex(idx.map((_, i) => idx[i - (i % 3) + [0, 2, 1][i % 3]]));
    geo.computeVertexNormals();
  }
  const mesh = new THREE.Mesh(geo, surfaceMaterial(3, { map: tex }));
  mesh.receiveShadow = true;
  mesh.renderOrder = ORDER.start;
  return mesh;
}

function buildWalls(track: Track): THREE.InstancedMesh {
  const { wallHeight, wallThickness } = track.def;
  // Boxes reach down to terrain level (0.45 m under the road) so stepped segments on slopes
  // leave no gaps; the road surface hides the part below it.
  const below = 0.5;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(wallThickness, wallHeight + below, 1),
    new THREE.MeshLambertMaterial({ color: 0xe8e4da }),
    track.walls.length,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(0, 0, 0, 'YXZ');
  const n = track.samples.length;
  // Snow roads are lined with ploughed snowbanks instead.
  const wood = new THREE.Color(track.def.snow ? 0xfafcff : 0x8a6440);
  const concrete = new THREE.Color(0xffffff);
  track.walls.forEach((w, i) => {
    // Along the dirt the walls are wooden fencing (left walls first, then right).
    mesh.setColorAt(i, onDirt(track, i % n) ? wood : concrete);
    // Tilted to the road's slope so walls run smoothly up ramps instead of stepping.
    // (Rotation about local +X tips +Z down, so climbing is a negative angle.)
    q.setFromEuler(e.set(-w.pitch, w.yaw, 0));
    // No visible wall across a chasm (the invisible physics walls still keep cars in line).
    const across = gapAfter(track, i % n) ? 0 : 1;
    m.compose(new THREE.Vector3(w.x, w.y + (wallHeight - below) / 2, w.z), q, new THREE.Vector3(across, across, w.length * across));
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
  // Keep a speedway's stands, pits and light towers clear of trees.
  const clearance = track.def.width / 2 + (track.def.scenery === 'speedway' ? 75 : 8);

  const spots: { x: number; y: number; z: number; s: number; round: boolean }[] = [];
  for (let tries = 0; spots.length < 340 && tries < 8000; tries++) {
    const x = minX + rand() * (maxX - minX);
    const z = minZ + rand() * (maxZ - minZ);
    const s = track.samples[nearestSampleIndex(track, x, z)];
    if (Math.hypot(s.x - x, s.z - z) < clearance) continue;
    // Snowy mountainsides grow only pines.
    const round = track.def.scenery !== 'snow' && rand() < 0.35;
    spots.push({ x, y: terrain.heightAt(x, z), z, s: 0.7 + rand() * 0.8, round });
  }
  const pines = spots.filter((p) => !p.round);
  const rounds = spots.filter((p) => p.round);

  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2f });
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.3, 0.4, 2, 6), trunkMat, spots.length);
  const pineCrowns = new THREE.InstancedMesh(
    new THREE.ConeGeometry(2.2, 6, 7),
    new THREE.MeshLambertMaterial({ color: track.def.scenery === 'snow' ? 0x3f6650 : 0x2f6b33 }),
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

function buildWater(track: Track): THREE.Mesh[] {
  const mat = new THREE.MeshStandardMaterial({ color: 0x23668f, roughness: 0.25, metalness: 0.35 });
  return (track.def.water ?? []).map((w) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w.maxX - w.minX, w.maxZ - w.minZ), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((w.minX + w.maxX) / 2, WATER_Y, (w.minZ + w.maxZ) / 2);
    mesh.receiveShadow = true;
    return mesh;
  });
}

/** One window cell, tiled across building faces and tinted per building. */
function windowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#5b6b7c';
  ctx.fillRect(14, 12, 36, 34);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(14, 12, 36, 6);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * City blocks lining the circuit: boxes of varied size and pastel colour, windows tiled to
 * their real size, all merged into a single mesh (one draw call, for phones).
 */
function buildBuildings(track: Track, terrain: Terrain): THREE.Mesh {
  const rand = mulberry32(911);
  const hw = track.def.width / 2;
  const n = track.samples.length;
  const palette = [0xf2e3c6, 0xe9c9a8, 0xf4f0e8, 0xe7b9a0, 0xd9d2c0, 0xf0d9a6, 0xc9d6dc];
  const placed: { x: number; z: number; r: number }[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const tint = new THREE.Color();
  const clearOfRoad = (x: number, z: number) => {
    const s = track.samples[nearestSampleIndex(track, x, z)];
    return Math.hypot(s.x - x, s.z - z) > hw + 2;
  };
  const inTunnel = (i: number) => {
    if (!track.tunnel) return false;
    const [a, b] = track.tunnel;
    return a <= b ? i >= a - 3 && i <= b + 3 : i >= a - 3 || i <= b + 3;
  };

  for (let i = 0; i < n; i += 3) {
    if (inTunnel(i)) continue;
    const s = track.samples[i];
    const r = { x: -s.tz, z: s.tx };
    for (const side of [-1, 1]) {
      if (rand() < 0.25) continue;
      const width = 8 + rand() * 8; // along the street
      const depth = 8 + rand() * 6;
      const height = 7 + rand() * (s.y > 6 ? 22 : 14);
      const off = side * (hw + 3.2 + depth / 2);
      const cx = s.x + r.x * off;
      const cz = s.z + r.z * off;
      const radius = Math.hypot(width, depth) / 2;
      // Footprint must be clear of every part of the road, the harbour, and other blocks.
      const corners = [
        [width / 2, depth / 2],
        [-width / 2, depth / 2],
        [width / 2, -depth / 2],
        [-width / 2, -depth / 2],
      ].map(([a, b]) => [cx + s.tx * a + r.x * b, cz + s.tz * a + r.z * b]);
      if (!corners.every(([x, z]) => clearOfRoad(x, z) && !inWater(track, x, z))) continue;
      if (placed.some((p) => Math.hypot(p.x - cx, p.z - cz) < p.r + radius * 0.8)) continue;
      placed.push({ x: cx, z: cz, r: radius });

      const geo = new THREE.BoxGeometry(width, height, depth);
      // Windows at a real-world size (one per 4 m × 3.5 m); roofs sample the plain wall.
      const uv = geo.getAttribute('uv');
      const normal = geo.getAttribute('normal');
      for (let k = 0; k < uv.count; k++) {
        const nx = Math.abs(normal.getX(k));
        const ny = Math.abs(normal.getY(k));
        if (ny > 0.5) uv.setXY(k, 0.02, 0.02);
        else uv.setXY(k, uv.getX(k) * ((nx > 0.5 ? depth : width) / 4), uv.getY(k) * (height / 3.5));
      }
      const colors = new Float32Array(uv.count * 3);
      tint.set(palette[Math.floor(rand() * palette.length)]);
      for (let k = 0; k < uv.count; k++) colors.set([tint.r, tint.g, tint.b], k * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const base = terrain.heightAt(cx, cz) - 1;
      geo.rotateY(Math.atan2(s.tx, s.tz));
      geo.translate(cx, base + height / 2, cz);
      geos.push(geo);
    }
  }
  const mesh = new THREE.Mesh(
    geos.length ? mergeGeometries(geos) : new THREE.BufferGeometry(),
    new THREE.MeshLambertMaterial({ map: windowTexture(), vertexColors: true }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  for (const g of geos) g.dispose();
  return mesh;
}

/** Vertical ribbon between two polylines (bottom and top), visible from both sides. */
function ribbon(bottom: Vec3[], top: Vec3[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < bottom.length; i++) {
    pos.push(bottom[i].x, bottom[i].y, bottom[i].z, top[i].x, top[i].y, top[i].z);
    if (i < bottom.length - 1) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * The covered section: side walls up from the barriers, a ceiling with lights, and a roof
 * slab, following the road's curve and slope. Visual only (cars can't leave the road there).
 * The roof casts the sun's shadow, so it's properly dim inside.
 */
/**
 * The mountain a snowy track's tunnel goes through: a peak rising over the middle of the tunnel,
 * falling away along the road (so the portals sit low on its flanks) and more gently to either
 * side. Returns the height it adds to the land at (x, z), or null when there's no such tunnel.
 */
function tunnelMountain(track: Track): ((x: number, z: number) => number) | null {
  if (!track.tunnel || track.def.scenery !== 'snow') return null;
  const n = track.samples.length;
  const [a, b] = track.tunnel;
  const span = (b - a + n) % n;
  const mid = track.samples[(a + Math.round(span / 2)) % n];
  const r = rightOf(mid.tx, mid.tz);
  const halfLength = (span * track.length) / n / 2;
  const peak = 40;
  return (x: number, z: number) => {
    const along = (x - mid.x) * mid.tx + (z - mid.z) * mid.tz;
    const lat = (x - mid.x) * r.x + (z - mid.z) * r.z;
    const ridge = Math.exp(-((along / (halfLength * 0.8)) ** 2)) * Math.exp(-((lat / 85) ** 2));
    // A few crags so it isn't a perfect dome.
    const crags = 1 + 0.12 * Math.sin(x * 0.09 + z * 0.05) + 0.08 * Math.cos(x * 0.04 - z * 0.11);
    return peak * ridge * crags;
  };
}

/**
 * The mountainside over a tunnel: a surface across the road at every tunnel sample, following
 * the mountain's shape and meeting the terrain on either side, with a rock face around each
 * portal from the opening up to the slope.
 */
function mountainCover(
  track: Track,
  indices: number[],
  roof: number,
  thick: number,
  terrain: Terrain,
  mountain: (x: number, z: number) => number,
): THREE.Mesh {
  const hw = track.def.width / 2;
  const K = 28;
  const reach = hw + 52;
  const snow = new THREE.Color(0xf1f4f7);
  const rock = new THREE.Color(0x8a8e96);
  const rockDark = new THREE.Color(0x6c7078);
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();
  const push = (x: number, y: number, z: number, color: THREE.Color) => {
    pos.push(x, y, z);
    col.push(color.r, color.g, color.b);
    return pos.length / 3 - 1;
  };
  /** Cross-section point k (0 = far left, K = far right) at sample i: on the mountainside. */
  const point = (i: number, k: number) => {
    const s = track.samples[i];
    const r = rightOf(s.tx, s.tz);
    // Denser near the road, where the shape changes fastest.
    const u = -1 + (2 * k) / K;
    const lat = Math.sign(u) * Math.abs(u) ** 1.6 * reach;
    const x = s.x + r.x * lat;
    const z = s.z + r.z * lat;
    const b = smoothstep(hw + 4, hw + 50, Math.abs(lat));
    let y = (s.y - 0.45 + mountain(x, z)) * (1 - b) + terrain.heightAt(x, z) * b + 0.25;
    // Always clear of the tunnel's roof, sloping down past its sides.
    y = Math.max(y, s.y + roof + 0.8 - Math.max(0, Math.abs(lat) - (hw + thick)) * 1.2);
    return { x, y, z };
  };
  const rows: number[][] = [];
  for (const i of indices) rows.push(Array.from({ length: K + 1 }, (_, k) => {
    const p = point(i, k);
    return push(p.x, p.y, p.z, snow);
  }));
  for (let rI = 1; rI < rows.length; rI++) {
    for (let k = 0; k < K; k++) {
      const a = rows[rI - 1][k];
      const b = rows[rI][k];
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  // Portal faces: rock, from the opening's outline out to the mountainside's.
  for (const i of [indices[0], indices[indices.length - 1]]) {
    const s = track.samples[i];
    const r = rightOf(s.tx, s.tz);
    const w = hw + thick;
    const perim = roof * 2 + 2 * w;
    const inner: number[] = [];
    const outer: number[] = [];
    for (let k = 0; k <= K; k++) {
      let d = (k / K) * perim;
      let lat: number;
      let up: number;
      if (d < roof) {
        lat = -w;
        up = d;
      } else if ((d -= roof) < 2 * w) {
        lat = -w + d;
        up = roof;
      } else {
        lat = w;
        up = roof - (d - 2 * w);
      }
      const ix = s.x + r.x * lat;
      const iy = s.y + up - 0.6;
      const iz = s.z + r.z * lat;
      inner.push(push(ix, iy, iz, rockDark));
      // Bare rock right around the opening; further out the face is the snowy slope of the
      // cutting the road runs in.
      const p = point(i, k);
      const far = smoothstep(4, 14, Math.hypot(p.x - ix, p.y - iy, p.z - iz));
      outer.push(push(p.x, p.y, p.z, c.copy(rock).lerp(rockDark, ((k * 7) % 3) / 3).lerp(snow, far)));
    }
    // Rings between the opening and the slope, curving up (low near the portal, steep near
    // the top) so the face hugs the cutting's slope instead of spanning straight across it.
    const RINGS = 4;
    let prev = inner;
    for (let ring = 1; ring <= RINGS; ring++) {
      const t = ring / RINGS;
      const cur =
        ring === RINGS
          ? outer
          : inner.map((iv, k) => {
              const ov = outer[k];
              const x = pos[iv * 3] + (pos[ov * 3] - pos[iv * 3]) * t;
              const z = pos[iv * 3 + 2] + (pos[ov * 3 + 2] - pos[iv * 3 + 2]) * t;
              const yi = pos[iv * 3 + 1];
              const y = Math.max(yi + (pos[ov * 3 + 1] - yi) * t * t, terrain.heightAt(x, z) + 0.3);
              const far = smoothstep(4, 14, Math.hypot(x - pos[iv * 3], y - yi, z - pos[iv * 3 + 2]));
              return push(x, y, z, c.copy(rock).lerp(rockDark, ((k * 7 + ring) % 3) / 3).lerp(snow, far));
            });
      for (let k = 0; k < K; k++) idx.push(prev[k], cur[k], prev[k + 1], prev[k + 1], cur[k], cur[k + 1]);
      prev = cur;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  const flat = geo.toNonIndexed();
  flat.computeVertexNormals();
  const mesh = new THREE.Mesh(flat, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildTunnel(track: Track, terrain: Terrain): THREE.Group | null {
  if (!track.tunnel) return null;
  const n = track.samples.length;
  const [a, b] = track.tunnel;
  const indices: number[] = [];
  for (let i = a; ; i = (i + 1) % n) {
    indices.push(i);
    if (i === b || indices.length > n) break;
  }
  const height = 6;
  const slab = 1;
  const thick = 1.2;
  const at = (edge: Vec3[], i: number, out: number, up: number): Vec3 => {
    const s = track.samples[i];
    const e = edge[i];
    const dx = e.x - s.x;
    const dz = e.z - s.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: e.x + (dx / len) * out, y: s.y + up, z: e.z + (dz / len) * out };
  };
  const line = (edge: Vec3[], out: number, up: number) => indices.map((i) => at(edge, i, out, up));
  const wallTop = track.def.wallHeight;

  const inner = new THREE.MeshLambertMaterial({ color: 0x8f887c, side: THREE.DoubleSide });
  const outer = new THREE.MeshLambertMaterial({ color: 0xd8d0c0, side: THREE.DoubleSide });
  const group = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  };
  for (const edge of [track.leftEdge, track.rightEdge]) {
    // Inner face, above the barrier, up to the ceiling.
    add(ribbon(line(edge, 0, wallTop), line(edge, 0, height)), inner);
    // Outer face, from the ground to the top of the roof slab.
    add(ribbon(line(edge, thick, -0.6), line(edge, thick, height + slab)), outer);
    // Top of the side wall between inner and outer faces.
    add(ribbon(line(edge, 0, height), line(edge, thick, height)), outer);
  }
  // Ceiling and roof.
  add(ribbon(line(track.leftEdge, 0, height), line(track.rightEdge, 0, height)), inner);
  add(ribbon(line(track.leftEdge, thick, height + slab), line(track.rightEdge, thick, height + slab)), outer);

  // Portal headers at each end, and ceiling lights down the middle.
  const header = new THREE.MeshLambertMaterial({ color: 0xb8ab94 });
  for (const i of [indices[0], indices[indices.length - 1]]) {
    const s = track.samples[i];
    const beam = new THREE.Mesh(new THREE.BoxGeometry(track.def.width + thick * 2 + 0.6, slab + 0.6, 0.8), header);
    beam.position.set(s.x, s.y + height + slab / 2, s.z);
    beam.rotation.y = Math.atan2(s.tx, s.tz);
    beam.castShadow = true;
    group.add(beam);
  }
  // On a snowy track the tunnel goes through a mountain: cover it with the mountainside, with a
  // rock face around each portal.
  const mountain = tunnelMountain(track);
  if (mountain) group.add(mountainCover(track, indices, height + slab, thick, terrain, mountain));

  const lamp = new THREE.MeshStandardMaterial({ color: 0xfff3d0, emissive: 0xffe9b0, emissiveIntensity: 1.6 });
  const lampGeo = new THREE.BoxGeometry(0.5, 0.08, 1.6);
  for (let k = 0; k < indices.length; k += 2) {
    const s = track.samples[indices[k]];
    const m = new THREE.Mesh(lampGeo, lamp);
    m.position.set(s.x, s.y + height - 0.05, s.z);
    m.rotation.y = Math.atan2(s.tx, s.tz);
    group.add(m);
  }
  return group;
}
