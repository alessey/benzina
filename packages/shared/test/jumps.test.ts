import { beforeAll, describe, expect, it } from 'vitest';
import { botInput, buildTrack, CAR_CLASSES, CAR_RIDE_HEIGHT, DT, IL_SALTO, initPhysics, nearestSampleIndex, roadHeightAt, SimWorld } from '../src';

beforeAll(async () => {
  await initPhysics();
});

/** Jumps on one lap of Il Salto at racing speed (autopilot): airtime, length, peak height above the road. */
function jumps(cls: (typeof CAR_CLASSES)[number]) {
  const track = buildTrack(IL_SALTO);
  const sim = new SimWorld(track);
  const car = sim.addCar('a', 0, cls);
  const out: { time: number; length: number; peak: number }[] = [];
  let air: { t0: number; x0: number; z0: number; peak: number } | null = null;
  let resets = 0;
  let last = car.body.translation();
  for (let t = 0; t < 60 * 40; t++) {
    sim.step(new Map([['a', botInput(car, track, 1, sim.tuning, sim.tick * DT)]]));
    const p = car.body.translation();
    if (Math.hypot(p.x - last.x, p.z - last.z) > 5) resets++;
    last = p;
    const h = p.y - CAR_RIDE_HEIGHT - roadHeightAt(track, p.x, p.z, nearestSampleIndex(track, p.x, p.z));
    if (!car.grounded) {
      air ??= { t0: t, x0: p.x, z0: p.z, peak: 0 };
      air.peak = Math.max(air.peak, h);
    } else if (air) {
      if ((t - air.t0) * DT > 0.3) out.push({ time: (t - air.t0) * DT, length: Math.hypot(p.x - air.x0, p.z - air.z0), peak: air.peak });
      air = null;
    }
  }
  sim.free();
  return { jumps: out, resets };
}

describe('Il Salto jumps', () => {
  it('give every class about a second of air, several metres up, and clean landings', () => {
    for (const cls of CAR_CLASSES) {
      const { jumps: js, resets } = jumps(cls);
      expect(resets).toBe(0);
      expect(js.length).toBeGreaterThanOrEqual(2);
      for (const j of js) {
        expect(j.time).toBeGreaterThan(0.85);
        expect(j.peak).toBeGreaterThan(3);
        expect(j.length).toBeGreaterThan(30);
      }
    }
  });
});
