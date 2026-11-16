import { beforeAll, describe, expect, it } from 'vitest';
import {
  botInput,
  buildTrack,
  CANALONE,
  CAR_CLASSES,
  DT,
  initPhysics,
  nearestSampleIndex,
  profileHeight,
  profileSlope,
  rightOf,
  roadHeightAt,
  SimWorld,
} from '../src';

beforeAll(async () => {
  await initPhysics();
});

describe('pipe profile', () => {
  it('is flat in the middle and curves up to a 60° wall, 3 m tall', () => {
    const def = CANALONE;
    expect(profileHeight(def, 0)).toBe(0);
    expect(profileHeight(def, 3.4)).toBe(0);
    expect(profileHeight(def, def.width / 2)).toBeCloseTo(3, 2);
    expect(profileHeight(def, -def.width / 2)).toBeCloseTo(3, 2);
    expect(Math.atan(profileSlope(def, def.width / 2 - 1e-6))).toBeCloseTo(Math.PI / 3, 2);
    // Flat tracks have no profile.
    expect(profileHeight({ ...def, pipe: undefined }, 5)).toBe(0);
  });
});

describe('Canalone', () => {
  it('every class laps cleanly, riding up the walls in corners without leaving the ice', () => {
    const track = buildTrack(CANALONE);
    const n = track.samples.length;
    for (const cls of CAR_CLASSES) {
      const sim = new SimWorld(track);
      const car = sim.addCar('a', 0, cls);
      let last = 0;
      const crossings: number[] = [];
      let wallHeight = 0;
      let airTicks = 0;
      let resets = 0;
      let prev = car.body.translation();
      for (let t = 0; t < 60 * 120 && crossings.length < 2; t++) {
        sim.step(new Map([['a', botInput(car, track, 1, sim.tuning, sim.tick * DT)]]));
        const p = car.body.translation();
        if (Math.hypot(p.x - prev.x, p.z - prev.z) > 5) resets++;
        prev = p;
        const i = nearestSampleIndex(track, p.x, p.z);
        const s = track.samples[i];
        const r = rightOf(s.tx, s.tz);
        wallHeight = Math.max(wallHeight, profileHeight(track.def, (p.x - s.x) * r.x + (p.z - s.z) * r.z));
        if (!car.grounded) airTicks++;
        // Never under the ice.
        expect(p.y).toBeGreaterThan(roadHeightAt(track, p.x, p.z, i) - 0.3);
        if (last > n * 0.9 && i < n * 0.1) crossings.push(t);
        last = i;
      }
      sim.free();
      expect(crossings.length, cls).toBe(2);
      expect(resets, cls).toBe(0);
      // Corners swing cars well up the walls...
      expect(wallHeight, cls).toBeGreaterThan(1);
      // ...but they stay on the ice (a few ticks of float over bumps at most).
      expect(airTicks, cls).toBeLessThan(30);
    }
  });
});
