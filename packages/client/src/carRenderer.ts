import * as THREE from 'three';
import { yawOf, type CarState, type Correction, type SimWorld } from '@benzina/shared';
import { CarView } from './carView';

/** How quickly visual correction offsets fade out (1/s). */
const SMOOTHING_RATE = 10;
/** Corrections bigger than this are teleports (resets, respawns): snap, don't glide. */
const SNAP_DISTANCE = 6;

const COLORS = [0xd8262e, 0x2e6fd8, 0xf2b705, 0x2fa84f, 0x9b3fd1, 0xf27405, 0x1fb5b5, 0xe8e8e8];

interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface Entry {
  view: CarView;
  tag: THREE.Sprite | null;
  prev: Pose;
  curr: Pose;
  speed: number;
  steer: number;
  /** Visual offset left over from corrections; decays to zero. */
  offset: Pose;
  /** Created this frame: skip correction smoothing. */
  fresh: boolean;
}

function poseOf(s: CarState): Pose {
  return { x: s.p[0], y: s.p[1], z: s.p[2], yaw: yawOf({ x: s.q[0], y: s.q[1], z: s.q[2], w: s.q[3] }) };
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function nameTag(name: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 30px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  const w = Math.min(250, ctx.measureText(name).width + 24);
  ctx.beginPath();
  ctx.roundRect(128 - w / 2, 10, w, 44, 12);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(name, 128, 33);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(4, 1, 1);
  sprite.position.y = 2;
  sprite.renderOrder = 10;
  return sprite;
}

/**
 * Draws every car in the sim. Interpolates between fixed ticks, and hides
 * reconciliation corrections by turning them into an offset that fades out over a few frames.
 */
export class CarRenderer {
  private readonly entries = new Map<string, Entry>();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpRot = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly sim: SimWorld,
    private readonly nameOf: (id: string) => string,
    private readonly localId: () => string | null,
  ) {}

  /** Create views for new cars, remove views for departed ones. */
  sync(): void {
    for (const [id, car] of this.sim.cars) {
      if (this.entries.has(id)) continue;
      const pose = poseOf(car.getState());
      const view = new CarView(COLORS[Number(id) % COLORS.length]);
      const tag = id === this.localId() ? null : nameTag(this.nameOf(id));
      if (tag) view.group.add(tag);
      this.scene.add(view.group);
      this.entries.set(id, {
        view,
        tag,
        prev: { ...pose },
        curr: { ...pose },
        speed: 0,
        steer: 0,
        offset: { x: 0, y: 0, z: 0, yaw: 0 },
        fresh: true,
      });
    }
    for (const [id, e] of this.entries) {
      if (this.sim.cars.has(id)) continue;
      this.scene.remove(e.view.group);
      this.entries.delete(id);
    }
  }

  /** Call after every live sim tick. */
  recordTick(): void {
    for (const [id, e] of this.entries) {
      const car = this.sim.cars.get(id);
      if (!car) continue;
      e.prev = e.curr;
      e.curr = poseOf(car.getState());
      e.speed = car.forwardSpeed();
      e.steer = car.steer;
    }
  }

  /**
   * After reconciliation the sim jumped from `before` to `after`. Shift the interpolation
   * window into the new timeline and carry the difference as a decaying visual offset,
   * so the car doesn't visibly pop.
   */
  applyCorrections(corrections: Correction[]): void {
    for (const c of corrections) {
      const e = this.entries.get(c.id);
      if (!e) continue;
      const before = poseOf(c.before);
      const after = poseOf(c.after);
      const d = {
        x: before.x - after.x,
        y: before.y - after.y,
        z: before.z - after.z,
        yaw: wrapAngle(before.yaw - after.yaw),
      };
      const car = this.sim.cars.get(c.id)!;
      e.speed = car.forwardSpeed();
      e.steer = car.steer;
      if (e.fresh || Math.hypot(d.x, d.y, d.z) > SNAP_DISTANCE) {
        e.prev = { ...after };
        e.curr = { ...after };
        e.offset = { x: 0, y: 0, z: 0, yaw: 0 };
        continue;
      }
      e.prev = { x: e.prev.x - d.x, y: e.prev.y - d.y, z: e.prev.z - d.z, yaw: e.prev.yaw - d.yaw };
      e.curr = after;
      e.offset = { x: e.offset.x + d.x, y: e.offset.y + d.y, z: e.offset.z + d.z, yaw: e.offset.yaw + d.yaw };
    }
    for (const e of this.entries.values()) e.fresh = false;
  }

  /** Draw all cars at `alpha` (0..1) between the previous and current tick. */
  render(alpha: number, dt: number): void {
    const decay = Math.exp(-SMOOTHING_RATE * dt);
    for (const e of this.entries.values()) {
      e.fresh = false;
      const o = e.offset;
      o.x *= decay;
      o.y *= decay;
      o.z *= decay;
      o.yaw *= decay;
      this.tmpPos.set(
        e.prev.x + (e.curr.x - e.prev.x) * alpha + o.x,
        e.prev.y + (e.curr.y - e.prev.y) * alpha + o.y,
        e.prev.z + (e.curr.z - e.prev.z) * alpha + o.z,
      );
      const yaw = e.prev.yaw + wrapAngle(e.curr.yaw - e.prev.yaw) * alpha + o.yaw;
      this.tmpRot.setFromAxisAngle(this.up, yaw);
      e.view.update(this.tmpPos, this.tmpRot, e.speed, e.steer, dt);
    }
  }

  /** The rendered pose of a car (for the camera), or null. */
  poseOf(id: string | null): { pos: THREE.Vector3; rot: THREE.Quaternion; speed: number } | null {
    const e = id ? this.entries.get(id) : undefined;
    if (!e) return null;
    return { pos: e.view.group.position, rot: e.view.group.quaternion, speed: e.speed };
  }

  /** Visual offset magnitudes for the debug overlay. */
  offsetOf(id: string): number {
    const e = this.entries.get(id);
    return e ? Math.hypot(e.offset.x, e.offset.y, e.offset.z) : 0;
  }
}
