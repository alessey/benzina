import { RAPIER } from './physics';
import { CAR_RIDE_HEIGHT, CAR_SHAPE, SUSPENSION_TRAVEL, type CarTuning } from './config';
import type { CarInput } from './input';
import { type CarState, yawOf, yawQuat } from './state';
import { nearestSampleIndex, type Track } from './track';

const FALL_RESET_Y = -10;

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
  grounded = false;

  constructor(
    private readonly world: RAPIER.World,
    private readonly track: Track,
    readonly id: string,
    x: number,
    z: number,
    yaw: number,
  ) {
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, CAR_RIDE_HEIGHT, z)
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
    if (input.reset || pos.y < FALL_RESET_Y) {
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
      // Hover spring. Rapier applies gravity during the step, so add it back here:
      // at rest height the spring exactly cancels gravity.
      const compression = CAR_RIDE_HEIGHT - hit.timeOfImpact;
      vy += (t.gravity + t.suspensionStiffness * compression - t.suspensionDamping * vy) * dt;

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

      const grip = input.handbrake ? t.driftGrip : t.grip;
      vL *= Math.exp(-grip * dt);

      const speed = Math.abs(vF);
      const lowSpeedFactor = clamp(speed / t.steerFullSpeed, 0, 1);
      const highSpeedFactor = 1 + (t.highSpeedSteer - 1) * clamp(speed / t.maxSpeed, 0, 1);
      const boost = input.handbrake ? t.handbrakeYawBoost : 1;
      // Steering right (+) turns clockwise seen from above, which is negative yaw.
      const targetYawRate =
        -this.steer * t.maxYawRate * lowSpeedFactor * highSpeedFactor * boost * Math.sign(vF);
      yawRate += (targetYawRate - yawRate) * (1 - Math.exp(-t.yawResponse * dt));

      this.body.setLinvel({ x: fx * vF + rx * vL, y: vy, z: fz * vF + rz * vL }, true);
    } else {
      // Airborne: no control, spin slowly bleeds off.
      yawRate *= Math.exp(-2 * dt);
    }

    this.body.setAngvel({ x: 0, y: yawRate, z: 0 }, true);
  }

  resetToTrack(): void {
    const pos = this.body.translation();
    const s = this.track.samples[nearestSampleIndex(this.track, pos.x, pos.z)];
    this.body.setTranslation({ x: s.x, y: CAR_RIDE_HEIGHT + 0.3, z: s.z }, true);
    this.body.setRotation(yawQuat(Math.atan2(s.tx, s.tz)), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steer = 0;
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
    };
  }

  setState(s: CarState): void {
    this.body.setTranslation({ x: s.p[0], y: s.p[1], z: s.p[2] }, true);
    this.body.setRotation({ x: s.q[0], y: s.q[1], z: s.q[2], w: s.q[3] }, true);
    this.body.setLinvel({ x: s.v[0], y: s.v[1], z: s.v[2] }, true);
    this.body.setAngvel({ x: s.w[0], y: s.w[1], z: s.w[2] }, true);
    this.steer = s.steer;
  }
}
