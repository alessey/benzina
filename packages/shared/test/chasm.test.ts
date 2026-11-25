import { beforeAll, describe, expect, it } from 'vitest';
import {
  botInput,
  buildTrack,
  CAR_CLASSES,
  CAR_RIDE_HEIGHT,
  DEFAULT_TUNING,
  initPhysics,
  nearestSampleIndex,
  SimWorld,
  VETTA,
  weatherTuning,
  yawQuat,
  type Weather,
} from '../src';
import { RAPIER } from '../src/physics';

beforeAll(async () => {
  await initPhysics();
});

const track = buildTrack(VETTA);
const [lip, landing] = track.gap!;

describe('chasm', () => {
  it('has no road across it, and lands a little lower than it takes off', () => {
    const sim = new SimWorld(track);
    const mid = track.samples[Math.round((lip + landing) / 2)];
    const ray = new RAPIER.Ray({ x: mid.x, y: mid.y + 5, z: mid.z }, { x: 0, y: -1, z: 0 });
    const hit = sim.world.castRay(ray, 15, true);
    expect(hit).toBeNull();
    const drop = track.samples[lip].y - track.samples[landing].y;
    expect(drop).toBeGreaterThan(0.5);
    expect(drop).toBeLessThan(4);
    expect(track.samples[landing].dist - track.samples[lip].dist).toBeGreaterThan(12);
    sim.free();
  });

  it('every car clears it at racing speed, dry or in snowfall', () => {
    for (const weather of ['clear', 'rain'] as Weather[]) {
      for (const cls of CAR_CLASSES) {
        const sim = new SimWorld(track);
        sim.weather = weather;
        const car = sim.addCar('a', 0, cls);
        let last = nearestSampleIndex(track, car.body.translation().x, car.body.translation().z);
        let passed = false;
        for (let t = 0; t < 60 * 70 && !passed; t++) {
          sim.step(new Map([['a', botInput(car, track, 1, weatherTuning(DEFAULT_TUNING, weather), 0, weather)]]));
          const p = car.body.translation();
          const i = nearestSampleIndex(track, p.x, p.z);
          // A reset sends the car back before the lip: a big jump backwards. (The grid starts
          // just behind the line, so allow for wrapping past sample 0.)
          let d = i - last;
          if (d < -track.samples.length / 2) d += track.samples.length;
          expect(d).toBeGreaterThan(-5);
          if (i > landing + 8 && last <= landing + 8 && last > lip - 20) passed = true;
          last = i;
        }
        expect(passed).toBe(true);
        sim.free();
      }
    }
  });

  it('takes about 80 km/h at the lip: 70 falls short, 90 clears it', () => {
    const attempt = (kmh: number) => {
      const sim = new SimWorld(track);
      const car = sim.addCar('a', 0);
      const s = track.samples[lip - 2];
      const v = kmh / 3.6;
      const q = yawQuat(Math.atan2(s.tx, s.tz));
      car.setState({ p: [s.x, s.y + CAR_RIDE_HEIGHT, s.z], q: [q.x, q.y, q.z, q.w], v: [s.tx * v, s.slope * v, s.tz * v], w: [0, 0, 0], steer: 0, upset: 0 });
      let made = false;
      for (let t = 0; t < 60 * 4 && !made; t++) {
        sim.step(new Map([['a', { throttle: 1, steer: 0, handbrake: false, reset: false }]]));
        const p = car.body.translation();
        if (nearestSampleIndex(track, p.x, p.z) > landing + 2 && car.grounded) made = true;
      }
      sim.free();
      return made;
    };
    expect(attempt(70)).toBe(false);
    expect(attempt(90)).toBe(true);
  });

  it('after falling in, every car can build enough speed to clear it, even in snowfall', () => {
    for (const cls of CAR_CLASSES) {
      const sim = new SimWorld(track);
      sim.weather = 'rain';
      const car = sim.addCar('a', 0, cls);
      // Drop it into the chasm to get reset, then drive at it flat out.
      const mid = track.samples[Math.round((lip + landing) / 2)];
      car.setState({ p: [mid.x, mid.y - 12, mid.z], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0], steer: 0, upset: 0 });
      let made = false;
      for (let t = 0; t < 60 * 12 && !made; t++) {
        const input = botInput(car, track, 1, weatherTuning(DEFAULT_TUNING, 'rain'), 0, 'rain');
        sim.step(new Map([['a', { ...input, throttle: 1 }]]));
        const p = car.body.translation();
        if (nearestSampleIndex(track, p.x, p.z) > landing + 8 && car.grounded) made = true;
      }
      expect(made).toBe(true);
      sim.free();
    }
  });

  it('too slow, a car falls in and is put back on the road before the lip', () => {
    const sim = new SimWorld(track);
    const car = sim.addCar('a', 0);
    const s = track.samples[lip - 5];
    const q = yawQuat(Math.atan2(s.tx, s.tz));
    // About 45 km/h up the kicker: not enough.
    car.setState({ p: [s.x, s.y + CAR_RIDE_HEIGHT, s.z], q: [q.x, q.y, q.z, q.w], v: [s.tx * 12.5, 0, s.tz * 12.5], w: [0, 0, 0], steer: 0, upset: 0 });
    let reset = -1;
    for (let t = 0; t < 60 * 6 && reset < 0; t++) {
      sim.step(new Map([['a', { throttle: 1, steer: 0, handbrake: false, reset: false }]]));
      const p = car.body.translation();
      const i = nearestSampleIndex(track, p.x, p.z);
      if (i < lip - 8) reset = i;
    }
    expect(reset).toBeGreaterThan(0);
    expect(lip - reset).toBeGreaterThan(8);
    // Back on the road, at rest, ready for another run.
    expect(car.body.translation().y).toBeGreaterThan(track.samples[reset].y);
    sim.free();
  });
});
