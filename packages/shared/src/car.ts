import { RAPIER } from './physics';
import { CAR_RIDE_HEIGHT, CAR_SHAPE, HOVER_CLEARANCE, SUSPENSION_TRAVEL, type CarTuning } from './config';
import { CLASS_SPECS, classTuning, type CarClass } from './cars';
import { PUDDLE, surfaceTuning, type Weather } from './weather';
import type { CarInput } from './input';
import { type CarState, yawOf, yawQuat } from './state';
import { bankGrip, nearestSampleIndex, nearestSampleIndexNear, profileHeight, profileSlope, rightOf, roadHeightAt, type Track } from './track';

const FALL_RESET_Y = -10;
/** Bobsled channels: how strongly cornering swings a car outward, up the wall (0..1). */
const PIPE_SWING = 1;
/** Bobsled channels: how quickly the car's height error to the ice is corrected (1/s). */
const PIPE_HOLD = 12;
/** Bobsled channels: how far above the ice (beyond ride height) the hold still works (m). */
const PIPE_REACH = 1.5;
/** Bobsled channels: fastest height correction toward the ice (m/s), so it never launches. */
const PIPE_HOLD_MAX = 3;
/** How fast dirt scrubs off speed above its top speed (m/s²). */
const DIRT_SCRUB = 6;
/** Steeply banked track steeper than this (rad, ~5°) holds the car to its surface. */
const BANK_HOLD_ANGLE = 0.09;
/** Bobsled channels: the suspension ray starts this far above the car (m). */
const PIPE_RAY_LIFT = 2;
/** Collision group bits: membership in the high 16 bits, what we collide with in the low 16. */
export const GROUP_ROAD = 0x0002;
const GROUP_CAR = 0x0004;
const CAR_COLLISION_GROUPS = (GROUP_CAR << 16) | (0xffff & ~GROUP_ROAD);
/** Fastest a car may rise away from the road while its wheels are on it, beyond the road's own rise (m/s). */
const MAX_HOP_SPEED = 3;
/** How far the road can fall away (m) before the car stops counting as on the ground. */
const WHEELS_DOWN_SLACK = 0.12;
/** Suspension compression (m) at which the landing bump-stop engages; normal hills stay below. */
const BUMP_STOP = HOVER_CLEARANCE * 0.6;
/** Below this speed (m/s) yaw stability returns in full, so spins always wind down. */
const SPIN_FADE_SPEED = 20;
/** How fast `upset` fades (per second) once the tyres grip again (sliding: `tuning.spinRecovery`). */
const UPSET_FADE_GRIPPING = 0.8;
/** Within this distance of a wall (m), steering away from it isn't limited by cornering grip. */
const WALL_NEAR = 2.5;
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
  /** Driving through standing water this tick (for spray and sound). */
  puddle = false;
  /** Wheels on dirt (or mud) this tick (for dust and sound). */
  dirt = false;
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
    /** Car class (part of the simulation: affects handling and mass). */
    public carClass: CarClass = 'equilibrio',
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
      .setDensity(CAR_SHAPE.density * CLASS_SPECS[carClass].mass)
      // Cars hover on their suspension ray; the body never touches the road surface (steep ramps
      // would otherwise catch a level car's corners), only walls, the ground and other cars.
      .setCollisionGroups(CAR_COLLISION_GROUPS)
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

  /** Change class (between races): handling follows immediately, mass via the collider density. */
  setClass(cls: CarClass): void {
    if (cls === this.carClass) return;
    this.carClass = cls;
    this.collider.setDensity(CAR_SHAPE.density * CLASS_SPECS[cls].mass);
  }

  /** Relative mass from the class (for bump impulses). */
  get mass(): number {
    return CLASS_SPECS[this.carClass].mass;
  }

  applyControls(input: CarInput, base: CarTuning, dt: number, weather: Weather = 'clear'): void {
    let t = classTuning(base, this.carClass);
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

    // Look further down when falling fast, so a hard landing is caught before the car passes
    // through the road (the body no longer collides with the road surface).
    // In a bobsled channel the ice holds the car from further away (see PIPE_HOLD).
    const reach = CAR_RIDE_HEIGHT + (this.track.def.pipe ? PIPE_REACH : SUSPENSION_TRAVEL);
    // Channels: cast from above the car, so a car swung hard up a steepening wall (centre
    // momentarily below the ice) still finds it. Distances are measured from the car centre.
    const lift = this.track.def.pipe ? PIPE_RAY_LIFT : 0;
    const ray = new RAPIER.Ray({ x: pos.x, y: pos.y + lift, z: pos.z }, { x: 0, y: -1, z: 0 });
    const cast = this.world.castRay(ray, lift + Math.max(reach, CAR_RIDE_HEIGHT - v.y * dt * 2 + 0.2), true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
    const far = cast ? { timeOfImpact: cast.timeOfImpact - lift } : null;
    const hit = far && far.timeOfImpact <= reach ? far : null;
    let vy = v.y;

    const w = this.body.angvel();
    let yawRate = w.y;

    // Wheels count as on the road when within a few centimetres of their resting height.
    this.grounded = hit !== null && hit.timeOfImpact < CAR_RIDE_HEIGHT + WHEELS_DOWN_SLACK;

    if (hit) {
      // Hover spring. Rapier applies gravity during the step, so add it back here: at rest
      // height the spring exactly cancels gravity. The damper works relative to the road (how
      // fast the road rises under us = slope × speed along the track), like a real damper,
      // so the car follows hills without lagging into the road.
      this.sampleHint = nearestSampleIndexNear(this.track, pos.x, pos.z, this.sampleHint);
      const roadVy = this.roadRise(pos.x, pos.z, v.x, v.z);
      const compression = CAR_RIDE_HEIGHT - hit.timeOfImpact;
      // Suspension can only push: when the road drops away faster than gravity pulls the car
      // down (a jump lip, a sharp crest), there's no force at all and the car flies.
      const support = t.gravity + t.suspensionStiffness * compression - t.suspensionDamping * (vy - roadVy);
      // Steeply banked: held to the surface like the channel below, or a car sliding up the bank
      // keeps the road's rise as upward speed once grip stops the slide, and takes off.
      const onBank = this.track.steepBanks && Math.abs(this.track.samples[this.sampleHint].bank) > BANK_HOLD_ANGLE;
      if (onBank) {
        vy = roadVy + clamp(compression * PIPE_HOLD, -PIPE_HOLD_MAX, PIPE_HOLD_MAX) + t.gravity * dt;
      } else if (this.track.def.pipe) {
        // Bobsled channel: the car is held to the ice, following the curved walls exactly as it
        // swings up and back down (a hover spring alone would fling it off the top of a swing).
        // Gravity is added back because Rapier applies it during the step.
        const follow = this.pipeRiseAhead(pos.x, pos.z, v.x, v.z, dt);
        vy = follow + clamp(compression * PIPE_HOLD, -PIPE_HOLD_MAX, PIPE_HOLD_MAX) + t.gravity * dt;
      } else if (support > 0) {
        vy += support * dt;
      }
      // Bump-stop: deep in the travel (a hard landing), stop sinking toward the road rather than
      // letting the body hit it. Body-road contact is solver state that snapshots can't
      // restore, so it would also make landings mispredict.
      if (compression > BUMP_STOP && vy < roadVy) vy = roadVy;
      // Nothing launches a car off the road faster than the road itself rises (plus a little):
      // ramps still fling you (that's roadVy), but a car squeezed into the road surface in a
      // crash gets eased out instead of being shot into the air by the contact solver.
      // The road's rise is measured at the nearest sample, which reads flat right on a jump
      // lip; take the steepest rise of the neighbouring samples too, so the lip still launches.
      if (this.grounded) vy = Math.min(vy, this.maxRoadRise(v.x, v.z) + this.wallRise(pos.x, pos.z, v.x, v.z) + (this.track.def.pipe || onBank ? 0.5 : MAX_HOP_SPEED));
    } else {
      // In the air: a little arcade hang time (part of gravity is cancelled).
      vy += t.gravity * (1 - t.airGravity) * dt;
    }
    if (far) {
      // Landing guard: never end this tick deeper than the bump-stop, however fast we fall.
      this.sampleHint = nearestSampleIndexNear(this.track, pos.x, pos.z, this.sampleHint);
      const roadVy = this.roadRise(pos.x, pos.z, v.x, v.z);
      const room = far.timeOfImpact - (CAR_RIDE_HEIGHT - BUMP_STOP);
      const fallNext = (vy - roadVy - t.gravity * dt) * dt;
      if (fallNext < -room) vy = roadVy + t.gravity * dt - Math.max(0, room) / dt;
    }

    this.puddle = false;
    this.dirt = false;
    if (this.grounded) {
      // Rain: wet grip, and standing water where the track has puddles.
      const surface = surfaceTuning(t, weather, this.track, this.sampleHint, pos.x, pos.z);
      t = surface.tuning;
      this.puddle = surface.puddle;
      this.dirt = surface.dirt;
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
      if (this.puddle) vF = approach(vF, 0, PUDDLE.drag * dt);
      // Dirt's lower top speed: arriving faster from the tarmac, the loose surface scrubs it off.
      if (this.dirt && vF > t.maxSpeed) vF = approach(vF, t.maxSpeed, DIRT_SCRUB * dt);

      // Scraping a wall bleeds speed.
      const wall = this.wallContact(pos.x, pos.z, fx, fz);
      this.wallSide = wall.side;
      if (wall.side !== 0) vF = approach(vF, 0, t.wallFriction * dt);

      // Hills: the slope along our heading pulls us back uphill and speeds us up downhill.
      // (The car body stays level and the spring follows the road, so this is the only place
      // gravity acts along the road.)
      const sample = this.track.samples[this.sampleHint];
      vF -= t.gravity * sample.slope * (fx * sample.tx + fz * sample.tz) * dt;

      // Bobsled channel walls: gravity pulls the car back down the wall (along and across the
      // car), and cornering swings it outward, up the outside wall, until the two balance:
      // the faster and tighter the corner, the higher the car rides.
      const ps = this.wallSlope(pos.x, pos.z);
      if (ps !== 0 || this.track.def.pipe) {
        const r = rightOf(sample.tx, sample.tz);
        vF -= t.gravity * ps * (fx * r.x + fz * r.z) * dt;
        vL -= t.gravity * ps * (rx * r.x + rz * r.z) * dt;
        vL += PIPE_SWING * vF * yawRate * dt;
      }

      // Steeply banked turns: too slow for the bank and gravity slides the car down it, toward
      // the inside. At speed the turn's cornering force balances it (g·tan θ = v²·curvature).
      if (this.track.steepBanks && sample.bank !== 0) {
        const pull = Math.max(0, t.gravity * Math.tan(Math.abs(sample.bank)) - vF * vF * Math.abs(sample.curvature));
        // Downhill is toward the right when the left edge is raised.
        const down = Math.sign(sample.bank) * pull * dt;
        const r = rightOf(sample.tx, sample.tz);
        vF += down * (fx * r.x + fz * r.z);
        vL += down * (rx * r.x + rz * r.z);
      }

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
      this.upset = Math.max(0, this.upset - dt * (slide < 0.2 ? UPSET_FADE_GRIPPING : t.spinRecovery));

      const speed = Math.abs(vF);
      const lowSpeedFactor = clamp(speed / t.steerFullSpeed, 0, 1);
      const highSpeedFactor = 1 + (t.highSpeedSteer - 1) * clamp(speed / t.maxSpeed, 0, 1);
      const boost = input.handbrake ? t.handbrakeYawBoost : 1;
      // Steering right (+) turns clockwise seen from above, which is negative yaw.
      let targetYawRate =
        -this.steer * t.maxYawRate * lowSpeedFactor * highSpeedFactor * boost * Math.sign(vF);
      // Cornering limit: yaw rate × speed is sideways acceleration; past what the tyres hold,
      // the car runs wide. The handbrake deliberately breaks traction to rotate further, and
      // turning away from a wall you're on or right next to gets the same allowance, so the
      // grip limit never leaves you stuck along an outside wall.
      const wallEscape = wall.near !== 0 && wall.near * this.steer < 0;
      // A wall rising on the outside of the turn holds the car in, like a banked corner.
      const bankHelp =
        (ps * targetYawRate * Math.sign(vF) < 0 ? 0 : t.gravity * Math.sin(Math.atan(Math.abs(ps)))) +
        bankGrip(this.track, this.sampleHint, -targetYawRate * Math.sign(vF), t.gravity);
      const maxCornerYaw = (t.cornerGrip * (input.handbrake || wallEscape ? 1.6 : 1) + bankHelp) / Math.max(4, Math.abs(vF));
      targetYawRate = clamp(targetYawRate, -maxCornerYaw, maxCornerYaw);
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
      // Airborne: no control, spin slowly bleeds off. Vertical speed still applies: hang time,
      // the landing guard and the channel's hold all adjust it.
      this.wallSide = 0;
      yawRate *= Math.exp(-2 * dt);
      this.body.setLinvel({ x: v.x, y: vy, z: v.z }, true);
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
  private wallContact(
    x: number,
    z: number,
    fx: number,
    fz: number,
  ): { side: -1 | 0 | 1; nx: number; nz: number; into: number; near: -1 | 0 | 1 } {
    this.sampleHint = nearestSampleIndexNear(this.track, x, z, this.sampleHint);
    const s = this.track.samples[this.sampleHint];
    const r = rightOf(s.tx, s.tz);
    const offset = (x - s.x) * r.x + (z - s.z) * r.z;
    // How far the car's box reaches sideways across the road (support along r).
    const fDotR = fx * r.x + fz * r.z;
    const carRightDotR = -fz * r.x + fx * r.z;
    const reach = HALF_L * Math.abs(fDotR) + HALF_W * Math.abs(carRightDotR);
    // Banked, the road's full width is measured along the slope: less of it across the ground.
    const halfRoad = (this.track.def.width / 2) * Math.cos(s.bank);

    // Only near the road edge: a car somehow beyond the walls (or in a test arena off the
    // circuit) isn't scraping anything.
    const beyond = Math.abs(offset) - reach > halfRoad + 0.5;
    const gapRight = halfRoad - (offset + reach);
    const gapLeft = halfRoad - (reach - offset);
    let side: -1 | 0 | 1 = 0;
    if (beyond) side = 0;
    else if (gapRight < WALL_CONTACT_GAP) side = 1;
    else if (gapLeft < WALL_CONTACT_GAP) side = -1;
    // Close to a wall (not necessarily touching), for the escape assist.
    let near: -1 | 0 | 1 = 0;
    if (!beyond && gapRight < WALL_NEAR) near = 1;
    else if (!beyond && gapLeft < WALL_NEAR) near = -1;
    return { side, nx: r.x, nz: r.z, into: Math.max(0, side * fDotR), near };
  }

  /** Slope of a pipe wall under (x, z): rise per metre toward the track's right (0 when flat). */
  private wallSlope(x: number, z: number): number {
    if (!this.track.def.pipe) return 0;
    const s = this.track.samples[this.sampleHint];
    const r = rightOf(s.tx, s.tz);
    return profileSlope(this.track.def, (x - s.x) * r.x + (z - s.z) * r.z);
  }

  /**
   * How fast a pipe wall, or a steeply banked road, rises under us (m/s) as we move across it.
   */
  private wallRise(x: number, z: number, vx: number, vz: number): number {
    const s = this.track.samples[this.sampleHint];
    const r = rightOf(s.tx, s.tz);
    let rise = 0;
    if (this.track.steepBanks) {
      // Across the bank, and along it as the bank steepens or eases: off the centre line the
      // surface rises or falls with the bank angle, which the centre line's slope doesn't show.
      const n = this.track.samples.length;
      const prev = this.track.samples[(this.sampleHint - 1 + n) % n];
      const next = this.track.samples[(this.sampleHint + 1) % n];
      const dTan = (Math.tan(next.bank) - Math.tan(prev.bank)) / ((2 * this.track.length) / n);
      const lat = (x - s.x) * r.x + (z - s.z) * r.z;
      rise -= Math.tan(s.bank) * (vx * r.x + vz * r.z) + lat * dTan * (vx * s.tx + vz * s.tz);
    }
    const ps = this.wallSlope(x, z);
    if (ps === 0) return rise;
    return rise + ps * (vx * r.x + vz * r.z);
  }

  /**
   * Channels: how fast the ice rises under us over the next tick (m/s), from the wall's actual
   * height where we'll be (the wall steepens outward, so its slope here underestimates it).
   */
  private pipeRiseAhead(x: number, z: number, vx: number, vz: number, dt: number): number {
    const s = this.track.samples[this.sampleHint];
    const r = rightOf(s.tx, s.tz);
    const lat = (x - s.x) * r.x + (z - s.z) * r.z;
    const next = lat + (vx * r.x + vz * r.z) * dt;
    const wall = (profileHeight(this.track.def, next) - profileHeight(this.track.def, lat)) / dt;
    return s.slope * (vx * s.tx + vz * s.tz) + wall;
  }

  /** How fast the road rises under us (m/s): slope along the track plus any pipe wall. */
  private roadRise(x: number, z: number, vx: number, vz: number): number {
    const s = this.track.samples[this.sampleHint];
    return s.slope * (vx * s.tx + vz * s.tz) + this.wallRise(x, z, vx, vz);
  }

  /** Steepest road rise (m/s at our velocity) over the nearest sample and its neighbours. */
  private maxRoadRise(vx: number, vz: number): number {
    const n = this.track.samples.length;
    let best = -Infinity;
    for (const d of [-1, 0, 1]) {
      const s = this.track.samples[(this.sampleHint + d + n) % n];
      best = Math.max(best, s.slope * (vx * s.tx + vz * s.tz));
    }
    return best;
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
