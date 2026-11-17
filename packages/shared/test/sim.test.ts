import { beforeAll, describe, expect, it } from 'vitest';
import {
  botInput,
  buildTrack,
  Car,
  DEFAULT_TRACK,
  DEFAULT_TUNING,
  initPhysics,
  nearestSampleIndex,
  rightOf,
  SimWorld,
  yawQuat,
  type CarInput,
} from '../src';
import { bump } from './bumps';

const track = buildTrack(DEFAULT_TRACK);

beforeAll(async () => {
  await initPhysics();
});

function input(partial: Partial<CarInput>): CarInput {
  return { throttle: 0, steer: 0, handbrake: false, reset: false, ...partial };
}

/** Scripted inputs: accelerate, weave, handbrake, brake. */
function scriptedInput(tick: number): CarInput {
  return input({
    throttle: tick < 400 ? 1 : -1,
    steer: Math.sin(tick / 30),
    handbrake: tick > 200 && tick < 240,
  });
}

function run(ticks: number) {
  const sim = new SimWorld(track);
  sim.addCar('a', 0);
  sim.addCar('b', 1);
  for (let t = 0; t < ticks; t++) {
    sim.step(new Map([['a', scriptedInput(t)], ['b', scriptedInput(t + 50)]]));
  }
  const states = [...sim.cars.values()].map((c) => c.getState());
  sim.free();
  return states;
}

describe('SimWorld', () => {
  it('is deterministic for identical inputs', () => {
    expect(run(600)).toEqual(run(600));
  });

  it('accelerates forward along the track under throttle', () => {
    const sim = new SimWorld(track);
    const car = sim.addCar('a', 0);
    for (let t = 0; t < 120; t++) sim.step(new Map([['a', input({ throttle: 1 })]]));
    expect(car.forwardSpeed()).toBeGreaterThan(20);
    expect(car.forwardSpeed()).toBeLessThanOrEqual(sim.tuning.maxSpeed);
    expect(car.grounded).toBe(true);
    sim.free();
  });

  it('cannot leave the track through the walls', () => {
    const sim = new SimWorld(track);
    const car = sim.addCar('a', 0);
    // Full throttle with full right lock for 10 seconds: slams into walls repeatedly.
    for (let t = 0; t < 600; t++) sim.step(new Map([['a', input({ throttle: 1, steer: 1 })]]));
    const p = car.body.translation();
    const s = track.samples[nearestSampleIndex(track, p.x, p.z)];
    const offCentre = Math.hypot(p.x - s.x, p.z - s.z);
    expect(offCentre).toBeLessThan(track.def.width / 2 + 0.5);
    sim.free();
  });

  it('restores state exactly with setState', () => {
    const sim = new SimWorld(track);
    const car = sim.addCar('a', 0);
    for (let t = 0; t < 100; t++) sim.step(new Map([['a', scriptedInput(t)]]));
    const saved = car.getState();
    for (let t = 0; t < 50; t++) sim.step(new Map([['a', scriptedInput(t)]]));
    car.setState(saved);
    const restored = car.getState();
    // Rapier renormalises quaternions on set, which can move the last float bit (~1e-7).
    expect({ ...restored, q: undefined }).toEqual({ ...saved, q: undefined });
    restored.q.forEach((v, i) => expect(v).toBeCloseTo(saved.q[i], 6));
    sim.free();
  });

  it('a bot can drive a full lap without getting stuck', () => {
    const sim = new SimWorld(track);
    const car = sim.addCar('bot', 0);
    const n = track.samples.length;
    let lastIdx = nearestSampleIndex(track, car.body.translation().x, car.body.translation().z);
    let travelled = 0;
    // 120 seconds is far more than a lap needs.
    for (let t = 0; t < 120 * 60 && travelled < n; t++) {
      sim.step(new Map([['bot', botInput(car, track)]]));
      const p = car.body.translation();
      const idx = nearestSampleIndex(track, p.x, p.z);
      let delta = idx - lastIdx;
      if (delta < -n / 2) delta += n;
      if (delta > n / 2) delta -= n;
      travelled += delta;
      lastIdx = idx;
    }
    expect(travelled).toBeGreaterThanOrEqual(n);
    sim.free();
  });

  describe('walls', () => {
    const HALF_ROAD = track.def.width / 2;
    const OLD_HANDLING = { ...DEFAULT_TUNING, pivotOffset: 0, wallFriction: 0, wallDeflect: 0, wallPushOff: 0 };

    /** Signed distance from the centre line (positive = right of it). */
    function offsetOf(car: Car): number {
      const p = car.body.translation();
      const s = track.samples[nearestSampleIndex(track, p.x, p.z)];
      const r = rightOf(s.tx, s.tz);
      return (p.x - s.x) * r.x + (p.z - s.z) * r.z;
    }

    /** A car flush against the wall on `side` (1 right, -1 left) at sample `idx`, doing 40 m/s along the road. */
    function flushAgainstWall(idx: number, side: 1 | -1, tuning = DEFAULT_TUNING) {
      const sim = new SimWorld(track, { ...tuning });
      const car = sim.addCar('a', 0);
      const s = track.samples[idx];
      const r = rightOf(s.tx, s.tz);
      const q = yawQuat(Math.atan2(s.tx, s.tz));
      const edge = HALF_ROAD - 1; // the car is 2 m wide
      car.setState({
        p: [s.x + r.x * side * edge, car.body.translation().y, s.z + r.z * side * edge],
        q: [q.x, q.y, q.z, q.w],
        v: [s.tx * 40, 0, s.tz * 40],
        w: [0, 0, 0],
        steer: 0,
        upset: 0,
      });
      return { sim, car };
    }

    /** Ticks until a car steering away at full lock is clear of the wall (capped at 180). */
    function ticksToEscape(idx: number, side: 1 | -1, tuning = DEFAULT_TUNING): number {
      const { sim, car } = flushAgainstWall(idx, side, tuning);
      let ticks = 180;
      for (let t = 0; t < 180; t++) {
        sim.step(new Map([['a', input({ throttle: 1, steer: -side })]]));
        if (Math.abs(offsetOf(car)) < HALF_ROAD - 2.5) {
          ticks = t;
          break;
        }
      }
      sim.free();
      return ticks;
    }

    /** Every 16th sample, both walls: straights, inside and outside of every corner. */
    const positions = Array.from({ length: track.samples.length / 16 }, (_, i) => i * 16).flatMap((idx) => [
      [idx, 1] as const,
      [idx, -1] as const,
    ]);

    it('steering away gets the car off any wall within a second, even mid-curve', () => {
      const worst = Math.max(...positions.map(([idx, side]) => ticksToEscape(idx, side)));
      expect(worst).toBeLessThan(60);
    });

    it('(regression guard) the old handling really did get stuck', () => {
      // Pivoting around the centre swung the tail into the wall and the solver blocked the turn.
      // (With today's taller physics walls the old worst case is ~2 s; with the original short
      // walls it never escaped at all.)
      const worst = Math.max(...positions.map(([idx, side]) => ticksToEscape(idx, side, OLD_HANDLING)));
      expect(worst).toBeGreaterThanOrEqual(100);
    });

    it('scraping a wall bleeds speed', () => {
      const { sim, car } = flushAgainstWall(64, 1);
      let touchingTicks = 0;
      for (let t = 0; t < 120; t++) {
        // Full throttle, steering into the wall.
        sim.step(new Map([['a', input({ throttle: 1, steer: 1 })]]));
        if (car.wallSide !== 0) touchingTicks++;
      }
      expect(touchingTicks).toBeGreaterThan(60);
      // Free-running, the car would accelerate toward maxSpeed (45); grinding the wall holds it well below.
      expect(car.forwardSpeed()).toBeLessThan(sim.tuning.maxSpeed * 0.8);
      sim.free();
    });
  });

  describe('car-to-car bumps', () => {
    it('side swipe: a crisp shove, not a 3-second grind', () => {
      const r = bump(track, 'sideswipe');
      expect(r.contact).toBe(true);
      expect(r.contactTicks).toBeLessThan(45); // was 164 ticks of rubbing before the bump layer
      expect(r.victimLateral).toBeGreaterThan(1.5); // you feel it
      expect(r.victimHeadingChange).toBeLessThan(0.5); // but it doesn't spin you out
    });

    it('rear-end: momentum transfers and the cars separate', () => {
      const r = bump(track, 'rear-end');
      expect(r.contactTicks).toBeLessThan(20); // was 107: a pushing train
      expect(r.victimSpeedChange).toBeGreaterThan(5); // shoved forward
      expect(r.attackerSpeedChange).toBeLessThan(-1); // the rammer pays for it (even on full throttle)
      expect(r.victimHeadingChange).toBeLessThan(0.05); // a square hit doesn't spin anyone
    });

    it('T-bone: the struck car is shoved, not spun', () => {
      // The attacker keeps its foot down and pushes the (now sliding) car along for a while.
      const r = bump(track, 't-bone');
      expect(r.contactTicks).toBeLessThan(60);
      expect(r.victimSpin).toBeLessThan(2);
      expect(r.victimHeadingChange).toBeLessThan(0.3);
    });

    it('a solid hit on the rear quarter spins the car out (PIT)', () => {
      const r = bump(track, 'pit', undefined, 8);
      expect(r.victimHeadingChange).toBeGreaterThan(1); // > 57 degrees
    });

    it('harder hits spin more, up to a ceiling', () => {
      const medium = bump(track, 'pit', undefined, 8).victimTotalRotation;
      expect(medium).toBeGreaterThan(1); // > 57 degrees: knocked properly sideways
      for (const closing of [12, 16, 20]) {
        const r = bump(track, 'pit', undefined, closing);
        expect(r.victimTotalRotation).toBeGreaterThanOrEqual(medium);
        expect(r.victimTotalRotation).toBeLessThan(4); // < 230 degrees, not a full pirouette
      }
    });

    it('a light tap on the rear quarter only unsettles it', () => {
      const r = bump(track, 'pit', undefined, 3);
      expect(r.victimHeadingChange).toBeGreaterThan(0.05);
      expect(r.victimHeadingChange).toBeLessThan(0.5);
    });

    it('spun cars always recover', () => {
      for (const closing of [5, 8, 12, 16]) {
        const r = bump(track, 'pit', undefined, closing);
        expect(r.victimYawRateLater).toBeLessThan(0.1);
        expect(r.victimTyreLater).toBeGreaterThan(0.95);
      }
    });

    it('your own handbrake turns are unaffected by the spin model', () => {
      // Tyre saturation only applies to cars upset by a hit. Same numbers as before it existed.
      const headingAfterHandbrake = (ticks: number) => {
        const sim = new SimWorld(track);
        const car = sim.addCar('a', 0);
        const q = yawQuat(0);
        car.setState({ p: [-300, car.body.translation().y, -300], q: [q.x, q.y, q.z, q.w], v: [0, 0, 35], w: [0, 0, 0], steer: 0, upset: 0 });
        let max = 0;
        for (let t = 0; t < 180; t++) {
          sim.step(new Map([['a', input({ throttle: 1, steer: t < ticks ? 1 : 0, handbrake: t < ticks })]]));
          const r = car.body.rotation();
          max = Math.max(max, Math.abs(2 * Math.atan2(r.y, r.w)));
        }
        sim.free();
        return max;
      };
      expect(headingAfterHandbrake(20)).toBeLessThan(1);
      expect(headingAfterHandbrake(40)).toBeLessThan(2);
    });

    it('nothing ever launches a car into the air', () => {
      for (const kind of ['sideswipe', 'rear-end', 't-bone'] as const) {
        expect(bump(track, kind).maxRise).toBeLessThan(0.1);
      }
    });
  });
});
