import { RAPIER } from './physics';
import { CAR_RIDE_HEIGHT, CAR_SHAPE, SUSPENSION_TRAVEL, type CarTuning } from './config';
import type { CarInput } from './input';
import { type CarState, yawOf, yawQuat } from './state';
import { nearestSampleIndex, nearestSampleIndexNear, rightOf, roadHeightAt, type Track } from './track';

const FALL_RESET_Y = -10;
/** Below this speed (m/s) yaw stability returns in full, so spins always wind down. */
const SPIN_FADE_SPEED = 20;
/** How fast `upset` fades (per second) once the tyres grip again, and while still sliding. */
const UPSET_FADE_GRIPPING = 0.8;
const UPSET_FADE_SLIDING = 0.15;
/** Closer than this to a wall (metres) counts as touching it. */
const WALL_CONTACT_GAP = 0.08;
/** Full extents of the car's collider, including the rounded border. */
export const HALF_W = CAR_SHAPE.halfWidth + CAR_SHAPE.borderRadius;
export const HALF_L = CAR_SHAPE.halfLength + CAR_SHAPE.borderRadius;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Move `current` toward `target` by at most `maxDelta`. */
function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
}

/**
 * Arcade car: a single rigid body whose roll and pitch are locked, hovering on a raycast
 * spring just above the road. Rapier handles gravity and collisions (walls, other cars);
 * each tick we rewrite the car's velocity to get the handling we want
 * (suspension, acceleration, grip, steering). That keeps the networked state
 * small (one body plus a steering value), which is what makes prediction and
 * reconciliation tractable.
 */
export class Car {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  /** Smoothed steering (-1..1); part of the simulated state. */
  steer = 0;
  /**
   * 0..1: how unsettled the car is after being hit. At 0 the handling is the normal arcade
   * model; as it rises, tyre saturation takes over, so a hard knock to the tail can spin the
   * car. Raised by collisions, fades once the tyres grip again. Part of the simulated state.
   */
  upset = 0;
  grounded = false;
  /** Which wall the car is touching this tick: 1 right, -1 left, 0 none. (Derived, not state.) */
  wallSide: -1 | 0 | 1 = 0;
  /** Search hint for the nearest centre-line sample. Only speeds up the search. */
  private sampleHint = 0;
  /**
   * Extra yaw rate this tick from glancing off other cars (set by SimWorld before controls).
   * Derived from positions each tick, so it isn't part of the networked state.
   */
  bumpYaw = 0;
  /** Rear-axle slip angle (rad) and remaining tyre grip fraction last tick (diagnostics). */
  slip = 0;
  tyre = 1;

  constructor(
    private readonly world: RAPIER.World,
    private readonly track: Track,
    readonly id: string,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ) {
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y + CAR_RIDE_HEIGHT, z)
      .setRotation(yawQuat(yaw))
      .enabledRotations(false, true, false)
      .setCcdEnabled(true)
      .setCanSleep(false);
    this.body = world.createRigidBody(bodyDesc);

    const colDesc = RAPIER.ColliderDesc.roundCuboid(
      CAR_SHAPE.halfWidth,
      CAR_SHAPE.halfHeight,
      CAR_SHAPE.halfLength,
      CAR_SHAPE.borderRadius,
    )
      .setDensity(CAR_SHAPE.density)
      .setFriction(0)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setRestitution(0.2);
    this.collider = world.createCollider(colDesc, this.body);
  }

  /** Forward speed in m/s (negative when reversing). */
  forwardSpeed(): number {
    const v = this.body.linvel();
    const yaw = yawOf(this.body.rotation());
    return v.x * Math.sin(yaw) + v.z * Math.cos(yaw);
  }

  applyControls(input: CarInput, t: CarTuning, dt: number): void {
    const pos = this.body.translation();
    if (input.reset || pos.y < FALL_RESET_Y || this.belowRoad(pos.x, pos.y, pos.z)) {
      this.resetToTrack();
      return;
    }

    const yaw = yawOf(this.body.rotation());
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    // Right vector for forward (fx, fz): (-fz, fx).
    const rx = -fz;
    const rz = fx;

    const v = this.body.linvel();
    let vF = v.x * fx + v.z * fz;
    let vL = v.x * rx + v.z * rz;

    this.steer = approach(this.steer, clamp(input.steer, -1, 1), t.steerSpeed * dt);

    const ray = new RAPIER.Ray(pos, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(
      ray,
      CAR_RIDE_HEIGHT + SUSPENSION_TRAVEL,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC,
    );
    this.grounded = hit !== null;
    let vy = v.y;

    const w = this.body.angvel();
    let yawRate = w.y;

    if (hit) {
      // Hover spring. Rapier applies gravity during the step, so add it back here: at rest
      // height the spring exactly cancels gravity. The damper works relative to the road (how
      // fast the road rises under us = slope × speed along the track), like a real damper,
      // so the car follows hills without lagging into the road.
      this.sampleHint = nearestSampleIndexNear(this.track, pos.x, pos.z, this.sampleHint);
      const under = this.track.samples[this.sampleHint];
      const roadVy = under.slope * (v.x * under.tx + v.z * under.tz);
      const compression = CAR_RIDE_HEIGHT - hit.timeOfImpact;
      vy += (t.gravity + t.suspensionStiffness * compression - t.suspensionDamping * (vy - roadVy)) * dt;

      const throttle = clamp(input.throttle, -1, 1);
      if (throttle > 0) {
        if (vF < -0.5) {
          vF = approach(vF, 0, t.brakeDecel * throttle * dt);
        } else {
          const taper = 1 - clamp(vF / t.maxSpeed, 0, 1) ** 2;
          vF += t.accel * throttle * taper * dt;
        }
      } else if (throttle < 0) {
        if (vF > 0.5) {
          vF = approach(vF, 0, t.brakeDecel * -throttle * dt);
        } else {
          vF = Math.max(vF + t.reverseAccel * throttle * dt, -t.maxReverseSpeed);
        }
      } else {
        vF = approach(vF, 0, t.rollDrag * dt);
      }

      if (input.handbrake) vF = approach(vF, 0, t.handbrakeDecel * dt);

      // Scraping a wall bleeds speed.
      const wall = this.wallContact(pos.x, pos.z, fx, fz);
      this.wallSide = wall.side;
      if (wall.side !== 0) vF = approach(vF, 0, t.wallFriction * dt);

      // Hills: the slope along our heading pulls us back uphill and speeds us up downhill.
      // (The car body stays level and the spring follows the road, so this is the only place
      // gravity acts along the road.)
      const sample = this.track.samples[this.sampleHint];
      vF -= t.gravity * sample.slope * (fx * sample.tx + fz * sample.tz) * dt;

      // Tyre saturation: past the peak slip angle, grip and steering authority fall away, so
      // a hard hit turns into a slide or spin you have to catch. Slip is measured at the rear
      // axle: in normal cornering the car pivots there (no slip), but when the tail is knocked
      // sideways, rotation sweeps the rear tyres sideways and they let go. Below ~2 m/s slip is
      // meaningless and the tyres simply grip.
      const planar = Math.hypot(vF, vL);
      const rearLateral = vL + yawRate * t.pivotOffset;
      const slip = planar > 2 ? Math.atan2(Math.abs(rearLateral), Math.abs(vF)) : 0;
      const slide = clamp((slip - t.tireSlipPeak) / Math.max(1e-3, t.tireSlipFull - t.tireSlipPeak), 0, 1);
      // Tyre saturation only applies while the car is upset by a hit: your own driving
      // (handbrake turns, hard cornering) keeps the forgiving arcade behaviour.
      const tyre = 1 - this.upset * slide * (1 - t.tireSlideGrip);
      this.slip = slip;
      this.tyre = tyre;
      this.upset = Math.max(0, this.upset - dt * (slide < 0.2 ? UPSET_FADE_GRIPPING : UPSET_FADE_SLIDING));

      const speed = Math.abs(vF);
      const lowSpeedFactor = clamp(speed / t.steerFullSpeed, 0, 1);
      const highSpeedFactor = 1 + (t.highSpeedSteer - 1) * clamp(speed / t.maxSpeed, 0, 1);
      const boost = input.handbrake ? t.handbrakeYawBoost : 1;
      // Steering right (+) turns clockwise seen from above, which is negative yaw.
      let targetYawRate =
        -this.steer * t.maxYawRate * lowSpeedFactor * highSpeedFactor * boost * Math.sign(vF);
      // Pointed into the wall? Turn parallel to it so the car glances off instead of pinning.
      // (Turning away from the right wall is a left turn, i.e. positive yaw.)
      if (wall.side !== 0 && wall.into > 0) targetYawRate += wall.side * wall.into * t.wallDeflect * Math.sign(vF);
      targetYawRate += this.bumpYaw;
      // The pull toward the steering's yaw rate is what the rear tyres provide; it collapses
      // quickly once they slide (cubed), so a hard knock to the tail can turn into a spin.
      // A spin always winds down as the car slows.
      const lowSpeedFloor = clamp(1 - planar / SPIN_FADE_SPEED, 0, 1);
      const stability = Math.max(tyre * tyre * tyre, lowSpeedFloor);
      yawRate += (targetYawRate - yawRate) * (1 - Math.exp(-t.yawResponse * stability * dt));

      // Grip pulls sideways velocity toward what turning around the rear axle implies:
      // the centre moves toward the inside of the turn, so the tail doesn't swing out.
      const grip = (input.handbrake ? t.driftGrip : t.grip) * tyre;
      const vLTarget = -yawRate * t.pivotOffset * tyre;
      vL = vLTarget + (vL - vLTarget) * Math.exp(-grip * dt);

      let vx = fx * vF + rx * vL;
      let vz = fz * vF + rz * vL;

      // Steering away from a wall you're touching: shove off it so there's room to turn
      // (otherwise the solver blocks the rotation and the car stays stuck to the wall).
      if (wall.side !== 0 && wall.side * this.steer < 0) {
        const awayX = -wall.side * wall.nx;
        const awayZ = -wall.side * wall.nz;
        const needed = t.wallPushOff * Math.abs(this.steer) - (vx * awayX + vz * awayZ);
        if (needed > 0) {
          vx += awayX * needed;
          vz += awayZ * needed;
        }
      }

      this.body.setLinvel({ x: vx, y: vy, z: vz }, true);
    } else {
      // Airborne: no control, spin slowly bleeds off.
      this.wallSide = 0;
      yawRate *= Math.exp(-2 * dt);
    }

    this.body.setAngvel({ x: 0, y: yawRate, z: 0 }, true);
  }

  /**
   * Is the car touching a track wall? Computed geometrically from the car's position and
   * heading against the local road edge, not from Rapier's contact data, whose internal state
   * isn't part of a snapshot. That keeps client re-simulation exact.
   *
   * Returns the side (1 right, -1 left, 0 none), the wall's outward normal on the right
   * side (track "right" vector), and how much the car's nose points into the wall (0..1).
   */
  private wallContact(x: number, z: number, fx: number, fz: number): { side: -1 | 0 | 1; nx: number; nz: number; into: number } {
    this.sampleHint = nearestSampleIndexNear(this.track, x, z, this.sampleHint);
    const s = this.track.samples[this.sampleHint];
    const r = rightOf(s.tx, s.tz);
    const offset = (x - s.x) * r.x + (z - s.z) * r.z;
    // How far the car's box reaches sideways across the road (support along r).
    const fDotR = fx * r.x + fz * r.z;
    const carRightDotR = -fz * r.x + fx * r.z;
    const reach = HALF_L * Math.abs(fDotR) + HALF_W * Math.abs(carRightDotR);
    const halfRoad = this.track.def.width / 2;

    // Only near the road edge: a car somehow beyond the walls (or in a test arena off the
    // circuit) isn't scraping anything.
    const beyond = Math.abs(offset) - reach > halfRoad + 0.5;
    let side: -1 | 0 | 1 = 0;
    if (beyond) side = 0;
    else if (halfRoad - (offset + reach) < WALL_CONTACT_GAP) side = 1;
    else if (halfRoad - (reach - offset) < WALL_CONTACT_GAP) side = -1;
    return { side, nx: r.x, nz: r.z, into: Math.max(0, side * fDotR) };
  }

  /**
   * Ended up under an elevated road (squeezed through it in a crash)? Only checked on the
   * circuit itself; off it there's no road above to be under.
   */
  private belowRoad(x: number, y: number, z: number): boolean {
    this.sampleHint = nearestSampleIndexNear(this.track, x, z, this.sampleHint);
    const s = this.track.samples[this.sampleHint];
    if (Math.hypot(x - s.x, z - s.z) > this.track.def.width) return false;
    return y < roadHeightAt(this.track, x, z, this.sampleHint) - 2;
  }

  resetToTrack(): void {
    const pos = this.body.translation();
    const s = this.track.samples[nearestSampleIndex(this.track, pos.x, pos.z)];
    this.body.setTranslation({ x: s.x, y: s.y + CAR_RIDE_HEIGHT + 0.3, z: s.z }, true);
    this.body.setRotation(yawQuat(Math.atan2(s.tx, s.tz)), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steer = 0;
    this.upset = 0;
  }

  getState(): CarState {
    const p = this.body.translation();
    const q = this.body.rotation();
    const v = this.body.linvel();
    const w = this.body.angvel();
    return {
      p: [p.x, p.y, p.z],
      q: [q.x, q.y, q.z, q.w],
      v: [v.x, v.y, v.z],
      w: [w.x, w.y, w.z],
      steer: this.steer,
      upset: this.upset,
    };
  }

  setState(s: CarState): void {
    this.body.setTranslation({ x: s.p[0], y: s.p[1], z: s.p[2] }, true);
    this.body.setRotation({ x: s.q[0], y: s.q[1], z: s.q[2], w: s.q[3] }, true);
    this.body.setLinvel({ x: s.v[0], y: s.v[1], z: s.v[2] }, true);
    this.body.setAngvel({ x: s.w[0], y: s.w[1], z: s.w[2] }, true);
    this.steer = s.steer;
    this.upset = s.upset;
  }
}
