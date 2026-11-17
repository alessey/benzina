import type { Car } from './car';
import { classTuning } from './cars';
import { DEFAULT_TUNING, type CarTuning } from './config';
import type { CarInput } from './input';
import { yawOf } from './state';
import { bankGrip, nearestSampleIndex, pipeOffsetForSlope, rightOf, type Track } from './track';

export type BotDifficulty = 'easy' | 'normal' | 'hard';

/** How a room's bots drive. Set by the host. */
export interface BotSettings {
  difficulty: BotDifficulty;
  /** Rubber-banding: bots ahead of the humans ease off, bots behind push harder. */
  catchUp: boolean;
}

export const DEFAULT_BOT_SETTINGS: BotSettings = { difficulty: 'normal', catchUp: false };

export interface BotProfile {
  /** Most throttle the bot ever uses. */
  throttle: number;
  /** Fraction of the car's cornering grip it dares to use when braking for corners. */
  corner: number;
  /** Amplitude of a slow steering wobble (imperfect lines). */
  wobble: number;
}

export const BOT_PROFILES: Record<BotDifficulty, BotProfile> = {
  easy: { throttle: 0.74, corner: 0.62, wobble: 0.3 },
  normal: { throttle: 0.88, corner: 0.78, wobble: 0.14 },
  hard: { throttle: 1, corner: 0.93, wobble: 0 },
};

/** Autopilot at full skill (tests, headless clients). */
export const PERFECT_BOT: BotProfile = { throttle: 1, corner: 0.92, wobble: 0 };

/**
 * Catch-up adjustment for a bot `gap` sectors ahead of (positive) or behind (negative) the
 * leading human: bots well ahead drive like an easier bot, bots well behind like a perfect one.
 */
export function catchUpProfile(base: BotProfile, gap: number): BotProfile {
  const k = Math.max(-1, Math.min(1, gap / 3));
  if (k > 0) return { throttle: base.throttle * (1 - 0.12 * k), corner: base.corner * (1 - 0.12 * k), wobble: base.wobble };
  const t = -k;
  return {
    throttle: base.throttle + (PERFECT_BOT.throttle - base.throttle) * t,
    corner: base.corner + (PERFECT_BOT.corner - base.corner) * t,
    wobble: base.wobble * (1 - t),
  };
}

/**
 * Autopilot that chases a point ahead on the centre line and brakes for upcoming corners
 * according to its car's grip. A number `skill` caps the throttle (perfect line otherwise); a
 * profile adds difficulty: less throttle, earlier braking, a wobbly line.
 */
export function botInput(
  car: Car,
  track: Track,
  skill: number | BotProfile = 1,
  baseTuning: CarTuning = DEFAULT_TUNING,
  /** Time in seconds, drives the wobble so it varies smoothly (per bot via its id). */
  time = 0,
): CarInput {
  const profile: BotProfile = typeof skill === 'number' ? { ...PERFECT_BOT, throttle: skill } : skill;
  const p = car.body.translation();
  const yaw = yawOf(car.body.rotation());
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const speed = car.forwardSpeed();

  const n = track.samples.length;
  const spacing = track.length / n;
  const lookAhead = Math.round((8 + Math.abs(speed) * 0.6) / spacing);
  const target = track.samples[(nearestSampleIndex(track, p.x, p.z) + lookAhead) % n];
  // In a bobsled channel, aim for where the car naturally rides in a corner: up the outside
  // wall, where its slope balances the cornering force (slope = v²·curvature / g).
  let aimX = target.x;
  let aimZ = target.z;
  if (track.def.pipe) {
    const m = (speed * speed * Math.abs(target.curvature)) / baseTuning.gravity;
    const lat = -Math.sign(target.curvature) * pipeOffsetForSlope(track.def, m, 0.65);
    const r = rightOf(target.tx, target.tz);
    aimX += r.x * lat;
    aimZ += r.z * lat;
  }

  const dx = aimX - p.x;
  const dz = aimZ - p.z;
  // Angle to target in the car's frame: positive means the target is to the right.
  const angle = Math.atan2(dx * -fz + dz * fx, dx * fx + dz * fz);
  const phase = (Number(car.id) || 0) * 1.7;
  const wobble = profile.wobble * Math.sin(time * 0.9 + phase) * Math.sin(time * 0.37 + phase * 2);
  const steer = Math.max(-1, Math.min(1, angle * 2.5 + wobble));

  // Brake for what's coming: find the tightest bend in the next stretch (further ahead the
  // faster we go) and the speed this car can take it at (v² = grip × radius).
  const t = classTuning(baseTuning, car.carClass);
  const here = nearestSampleIndex(track, p.x, p.z);
  const horizon = Math.round((20 + Math.abs(speed) * 1.6) / spacing);
  // Channel walls bank the corners: they add up to gravity × sin(wall angle) of grip. Steeply
  // banked turns add grip per sample (bankGrip), so the slowest point decides.
  const bank = track.def.pipe ? t.gravity * Math.sin(track.def.pipe.angle) * 0.85 : 0;
  let cornerSpeed = Infinity;
  for (let k = 2; k <= horizon; k++) {
    const i = (here + k) % n;
    const c = track.samples[i].curvature;
    if (c === 0) continue;
    const grip = t.cornerGrip + bank + bankGrip(track, i, c, t.gravity);
    cornerSpeed = Math.min(cornerSpeed, Math.sqrt((grip * profile.corner) / Math.abs(c)));
  }
  // Proportional: brake harder the more we're over the corner speed (smooth inputs also keep
  // other players' predictions of this car accurate).
  let throttle = Math.max(-1, Math.min(profile.throttle, (cornerSpeed - speed) / 4));
  if (Math.abs(angle) > 0.6 && speed > 15) throttle = Math.min(throttle, 0.3);

  return { throttle, steer, handbrake: false, reset: false };
}
