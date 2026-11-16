import * as THREE from 'three';
import { CAR_RIDE_HEIGHT, inTunnel, nearestSampleIndex, nearestSampleIndexNear, profileSlope, roadHeightAt, yawOf, type SimWorld, type Track } from '@benzina/shared';

const MAX_MARKS = 1600;
const MAX_SMOKE = 700;
/** Rear wheel contact points in car space (x across, z along). */
const REAR_WHEELS: [number, number][] = [
  [-0.88, -1.28],
  [0.88, -1.28],
];

interface Trail {
  /** Last mark end per rear wheel, or null if not currently sliding. */
  last: (THREE.Vector3 | null)[];
  sampleHint: number;
}

/**
 * Skid marks and tyre smoke, driven by each car's simulated motion (works for remote cars too,
 * since they're predicted locally). Purely cosmetic.
 */
export class Effects {
  private readonly marks: THREE.InstancedMesh;
  private markIndex = 0;
  private readonly smoke: THREE.Points;
  private readonly smokePos: Float32Array;
  private readonly smokeCol: Float32Array;
  private readonly smokeVel: Float32Array;
  private readonly smokeAge: Float32Array;
  private smokeIndex = 0;
  private readonly trails = new Map<string, Trail>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly sim: SimWorld,
    private readonly track: Track,
  ) {
    const markMat = new THREE.MeshBasicMaterial({
      color: 0x111111,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -16,
    });
    const markGeo = new THREE.PlaneGeometry(0.28, 1);
    markGeo.rotateX(-Math.PI / 2);
    this.marks = new THREE.InstancedMesh(markGeo, markMat, MAX_MARKS);
    this.marks.count = 0;
    this.marks.frustumCulled = false;
    this.marks.renderOrder = -6;
    scene.add(this.marks);

    this.smokePos = new Float32Array(MAX_SMOKE * 3);
    this.smokeCol = new Float32Array(MAX_SMOKE * 4);
    this.smokeVel = new Float32Array(MAX_SMOKE * 3);
    this.smokeAge = new Float32Array(MAX_SMOKE).fill(99);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.smokePos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.smokeCol, 4));
    this.smoke = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 2.2,
        map: puffTexture(),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.smoke.frustumCulled = false;
    scene.add(this.smoke);
  }

  dispose(): void {
    this.scene.remove(this.marks, this.smoke);
    this.marks.geometry.dispose();
    (this.marks.material as THREE.Material).dispose();
    this.smoke.geometry.dispose();
    (this.smoke.material as THREE.PointsMaterial).map?.dispose();
    (this.smoke.material as THREE.Material).dispose();
  }

  /** Call once per rendered frame. */
  update(dt: number): void {
    for (const [id, car] of this.sim.cars) {
      let trail = this.trails.get(id);
      if (!trail) {
        trail = { last: [null, null], sampleHint: 0 };
        this.trails.set(id, trail);
      }
      const p = car.body.translation();
      trail.sampleHint = nearestSampleIndexNear(this.track, p.x, p.z, trail.sampleHint);
      const v = car.body.linvel();
      const yaw = yawOf(car.body.rotation());
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const vF = v.x * fx + v.z * fz;
      const vL = v.x * -fz + v.z * fx;
      const speed = Math.hypot(vF, vL);
      // Sliding: sideways speed, a spin, or locked-up hard braking.
      // In a bobsled channel sliding up the walls is normal driving: only real spins count.
      const sliding = this.track.def.pipe
        ? car.grounded && speed > 6 && car.upset > 0.25
        : car.grounded && speed > 6 && (Math.abs(vL) > 4.5 || car.upset > 0.25 || Math.abs(car.body.angvel().y) > 2.4);
      const intensity = sliding ? Math.min(1, (Math.abs(vL) - 3) / 8 + car.upset) : 0;

      // Rain: spray off the rear tyres at speed, a burst through puddles (none in the tunnel).
      if (this.wet && car.grounded && speed > 10 && !inTunnel(this.track, trail.sampleHint)) {
        const rate = Math.min(1, (speed - 10) / 35) * 0.25 + (car.puddle ? 1.2 : 0);
        for (const [ox, oz] of REAR_WHEELS) {
          if (Math.random() > rate * dt * 60 * 0.5) continue;
          const x = p.x + fz * ox + fx * oz;
          const z = p.z - fx * ox + fz * oz;
          this.spray(new THREE.Vector3(x, p.y - CAR_RIDE_HEIGHT + 0.1, z), v, car.puddle);
        }
      }

      for (let w = 0; w < REAR_WHEELS.length; w++) {
        if (!sliding) {
          trail.last[w] = null;
          continue;
        }
        const [ox, oz] = REAR_WHEELS[w];
        // Car-space (x left, z forward); right vector is (-fz, fx), so +x is (fz, -fx).
        const x = p.x + fz * ox + fx * oz;
        const z = p.z - fx * ox + fz * oz;
        const y = this.groundY(trail, x, z, p.y);
        const here = new THREE.Vector3(x, y, z);
        const last = trail.last[w];
        if (last && here.distanceToSquared(last) > 0.04) {
          this.addMark(last, here);
          trail.last[w] = here;
          if (Math.random() < intensity * 0.9) this.puff(here, v);
        } else if (!last) {
          trail.last[w] = here;
        }
      }
    }
    for (const id of this.trails.keys()) if (!this.sim.cars.has(id)) this.trails.delete(id);
    this.updateSmoke(dt);
  }

  private groundY(trail: Trail, x: number, z: number, carY: number): number {
    const road = roadHeightAt(this.track, x, z, trail.sampleHint);
    // Off the road (e.g. test arenas) fall back to under the car.
    return Math.abs(road - (carY - CAR_RIDE_HEIGHT)) < 1.5 ? road + 0.035 : carY - CAR_RIDE_HEIGHT + 0.035;
  }

  private addMark(a: THREE.Vector3, b: THREE.Vector3): void {
    const len = a.distanceTo(b);
    if (len > 3) return; // teleport (reset/correction), not a skid
    // Marks are laid flat: none up a channel's steep walls.
    if (this.onWall(b)) return;
    const mid = a.clone().add(b).multiplyScalar(0.5);
    this.q.setFromAxisAngle(this.up, Math.atan2(b.x - a.x, b.z - a.z));
    this.m.compose(mid, this.q, new THREE.Vector3(1, 1, len + 0.05));
    this.marks.setMatrixAt(this.markIndex, this.m);
    this.markIndex = (this.markIndex + 1) % MAX_MARKS;
    this.marks.count = Math.max(this.marks.count, this.markIndex === 0 ? MAX_MARKS : this.markIndex);
    this.marks.instanceMatrix.needsUpdate = true;
  }

  /** Weather sets this: spray behind cars on a wet road. */
  wet = false;

  private spray(at: THREE.Vector3, v: { x: number; z: number }, big: boolean): void {
    const i = this.smokeIndex;
    this.smokeIndex = (i + 1) % MAX_SMOKE;
    this.smokePos.set([at.x, at.y, at.z], i * 3);
    const up = big ? 1.6 + Math.random() * 1.4 : 0.5 + Math.random() * 0.7;
    const spread = big ? 2.5 : 0.8;
    this.smokeVel.set([v.x * 0.35 + (Math.random() - 0.5) * spread, up, v.z * 0.35 + (Math.random() - 0.5) * spread], i * 3);
    // Spray fades faster than smoke: start it part-way through its life.
    this.smokeAge[i] = big ? 0.6 : 1.05;
  }

  private onWall(p: THREE.Vector3): boolean {
    if (!this.track.def.pipe) return false;
    const s = this.track.samples[nearestSampleIndex(this.track, p.x, p.z)];
    const lat = (p.x - s.x) * -s.tz + (p.z - s.z) * s.tx;
    return Math.abs(profileSlope(this.track.def, lat)) > 0.15;
  }

  private puff(at: THREE.Vector3, v: { x: number; z: number }): void {
    const i = this.smokeIndex;
    this.smokeIndex = (i + 1) % MAX_SMOKE;
    this.smokePos.set([at.x, at.y + 0.3, at.z], i * 3);
    this.smokeVel.set([v.x * 0.25 + (Math.random() - 0.5), 0.9 + Math.random() * 0.6, v.z * 0.25 + (Math.random() - 0.5)], i * 3);
    this.smokeAge[i] = 0;
  }

  private updateSmoke(dt: number): void {
    const life = 1.6;
    for (let i = 0; i < MAX_SMOKE; i++) {
      const age = (this.smokeAge[i] += dt);
      const k = i * 3;
      if (age < life) {
        this.smokePos[k] += this.smokeVel[k] * dt;
        this.smokePos[k + 1] += this.smokeVel[k + 1] * dt;
        this.smokePos[k + 2] += this.smokeVel[k + 2] * dt;
        this.smokeVel[k] *= 1 - dt * 1.5;
        this.smokeVel[k + 2] *= 1 - dt * 1.5;
      }
      const alpha = age < life ? 0.45 * (1 - age / life) : 0;
      this.smokeCol.set([0.85, 0.85, 0.85, alpha], i * 4);
    }
    this.smoke.geometry.getAttribute('position').needsUpdate = true;
    this.smoke.geometry.getAttribute('color').needsUpdate = true;
  }
}

function puffTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
