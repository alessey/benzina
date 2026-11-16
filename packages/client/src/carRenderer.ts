import * as THREE from 'three';
import { nearestSampleIndexNear, rightOf, yawOf, type CarState, type Correction, type SimWorld, type Track } from '@benzina/shared';
import type { CarChoice, CarClass } from '@benzina/shared';
import { CarView, type BodyStyle } from './carView';

/** Each class has its own silhouette. */
const STYLE_FOR_CLASS: Record<CarClass, BodyStyle> = { equilibrio: 'coupe', bolide: 'gt', scatto: 'muscle', artiglio: 'hatch' };

/** How quickly visual correction offsets fade out (1/s). */
const SMOOTHING_RATE = 10;
/** Corrections bigger than this are teleports (resets, respawns): snap, don't glide. */
const SNAP_DISTANCE = 6;

/** Your car is always red; everyone else gets one of the others. */
const LOCAL_COLOR = 0xd8262e;
const OTHER_COLORS = [0x2e6fd8, 0xf2b705, 0x2fa84f, 0x9b3fd1, 0xf27405, 0x1fb5b5, 0xe8e8e8, 0xff7ab8];

/** Paint colour for a car (also used by the track map). */
export function carColor(id: string, local: boolean): number {
  return local ? LOCAL_COLOR : OTHER_COLORS[(Number(id) || 0) % OTHER_COLORS.length];
}

interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface Entry {
  id: string;
  view: CarView;
  /** What the view was built for; rebuilt if the owner changes car. */
  look: string;
  tag: THREE.Sprite | null;
  prev: Pose;
  curr: Pose;
  speed: number;
  steer: number;
  /** 0..1 how hard the car slowed last tick (brake lights). */
  braking: number;
  /** Visual offset left over from corrections; decays to zero. */
  offset: Pose;
  /** Created this frame: skip correction smoothing. */
  fresh: boolean;
  /** Visual pitch and roll following the road (physics keeps cars level). */
  pitch: number;
  roll: number;
  sampleHint: number;
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
  // Constant on-screen size: readable far away, not a billboard when a car is right behind the camera.
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false }));
  sprite.scale.set(0.24, 0.06, 1);
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
  private readonly tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(
    private readonly scene: THREE.Scene,
    private readonly sim: SimWorld,
    private readonly track: Track,
    private readonly nameOf: (id: string) => string,
    private readonly localId: () => string | null,
    /** The car (class + colour) a player chose, if known. */
    private readonly carOf: (id: string) => CarChoice | undefined = () => undefined,
  ) {}

  private lookOf(id: string): string {
    const car = this.carOf(id);
    const cls = this.sim.cars.get(id)?.carClass ?? car?.cls ?? 'equilibrio';
    return `${cls}/${car?.color ?? carColor(id, id === this.localId())}`;
  }

  /** Create views for new cars, remove views for departed ones, rebuild changed ones. */
  private headlights = 0.6;

  /** Headlight glow for every car (weather). */
  setHeadlights(intensity: number): void {
    if (intensity === this.headlights) return;
    this.headlights = intensity;
    for (const e of this.entries.values()) e.view.setHeadlights(intensity);
  }

  sync(): void {
    for (const [id, e] of this.entries) {
      if (this.sim.cars.has(id) && e.look !== this.lookOf(id)) {
        this.scene.remove(e.view.group);
        this.entries.delete(id);
      }
    }
    for (const [id, car] of this.sim.cars) {
      if (this.entries.has(id)) continue;
      const pose = poseOf(car.getState());
      const local = id === this.localId();
      const chosen = this.carOf(id);
      const view = new CarView(chosen?.color ?? carColor(id, local), STYLE_FOR_CLASS[car.carClass]);
      view.setHeadlights(this.headlights);
      const tag = local ? null : nameTag(this.nameOf(id));
      if (tag) view.group.add(tag);
      this.scene.add(view.group);
      this.entries.set(id, {
        id,
        view,
        look: this.lookOf(id),
        tag,
        prev: { ...pose },
        curr: { ...pose },
        speed: 0,
        steer: 0,
        braking: 0,
        offset: { x: 0, y: 0, z: 0, yaw: 0 },
        fresh: true,
        pitch: 0,
        roll: 0,
        sampleHint: 0,
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
      const speed = car.forwardSpeed();
      // Slowing by more than ~coasting (4 m/s²) while moving forward lights the brake lamps.
      const decel = (Math.abs(e.speed) - Math.abs(speed)) * 60;
      e.braking = Math.abs(speed) > 1 && decel > 6 ? Math.min(1, decel / 30) : 0;
      e.speed = speed;
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

  /**
   * Draw all cars at `alpha` (0..1) between the previous and current tick. Cars close to the
   * camera (but not the one it follows) fade out so they don't block the view.
   */
  render(alpha: number, dt: number, camera?: THREE.Camera, followed?: string | null): void {
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
      this.tiltToRoad(e, yaw, dt);
      this.tmpEuler.set(e.pitch, yaw, e.roll);
      this.tmpRot.setFromEuler(this.tmpEuler);
      e.view.update(this.tmpPos, this.tmpRot, e.speed, e.steer, dt, e.braking);
      if (camera) {
        const d = camera.position.distanceTo(this.tmpPos);
        const followedHere = [...this.entries].find(([, x]) => x === e)?.[0] === followed;
        e.view.setFade(followedHere ? 1 : THREE.MathUtils.clamp((d - 3) / 6, 0.25, 1));
      }
    }
  }

  /**
   * Physics keeps cars level; visually they follow the road's slope and banking. The road's
   * height gradient under the car gives pitch (along the car) and roll (across it).
   */
  private tiltToRoad(e: Entry, yaw: number, dt: number): void {
    const car = this.sim.cars.get(e.id);
    if (car && !car.grounded) {
      // In the air: the nose follows the flight path (up off the ramp, down toward landing).
      const v = car.body.linvel();
      const along = Math.max(5, Math.abs(car.forwardSpeed()));
      const k = 1 - Math.exp(-6 * dt);
      e.pitch += (-Math.atan(v.y / along) * 0.8 - e.pitch) * k;
      e.roll += (0 - e.roll) * k;
      return;
    }
    e.sampleHint = nearestSampleIndexNear(this.track, this.tmpPos.x, this.tmpPos.z, e.sampleHint);
    const s = this.track.samples[e.sampleHint];
    const r = rightOf(s.tx, s.tz);
    // Height gradient: climbs along the tangent, falls toward the right edge when banked.
    const gx = s.slope * s.tx - Math.tan(s.bank) * r.x;
    const gz = s.slope * s.tz - Math.tan(s.bank) * r.z;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    // Rotation about the car's +X tips the nose down, so climbing is negative pitch;
    // rotation about +Z lifts the car's left side (+X is left), i.e. the side the road rises to.
    const pitch = -Math.atan(gx * fx + gz * fz);
    const roll = Math.atan(gx * fz - gz * fx);
    const k = 1 - Math.exp(-10 * dt);
    e.pitch += (pitch - e.pitch) * k;
    e.roll += (roll - e.roll) * k;
  }

  /** Remove every car view (before the renderer is replaced). */
  dispose(): void {
    for (const e of this.entries.values()) this.scene.remove(e.view.group);
    this.entries.clear();
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
