import type { Car } from './car';
import type { CarInput } from './input';
import { yawOf } from './state';
import { nearestSampleIndex, type Track } from './track';

/**
 * Minimal autopilot that chases a point ahead on the centre line. Used by tests now and
 * by headless bot clients later (load and netcode testing).
 */
export function botInput(car: Car, track: Track, skill = 1): CarInput {
  const p = car.body.translation();
  const yaw = yawOf(car.body.rotation());
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const speed = car.forwardSpeed();

  const n = track.samples.length;
  const spacing = track.length / n;
  const lookAhead = Math.round((8 + Math.abs(speed) * 0.6) / spacing);
  const target = track.samples[(nearestSampleIndex(track, p.x, p.z) + lookAhead) % n];

  const dx = target.x - p.x;
  const dz = target.z - p.z;
  // Angle to target in the car's frame: positive means the target is to the right.
  const angle = Math.atan2(dx * -fz + dz * fx, dx * fx + dz * fz);
  const steer = Math.max(-1, Math.min(1, angle * 2.5));
  const throttle = Math.abs(angle) > 0.5 && speed > 20 ? 0.2 : skill;

  return { throttle, steer, handbrake: false, reset: false };
}
