import { beforeAll, describe, expect, it } from 'vitest';
import {
  botInput,
  buildTrack,
  DEFAULT_TRACK,
  initPhysics,
  nearestSampleIndex,
  SimWorld,
  type CarInput,
} from '../src';

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
    expect(car.getState()).toEqual(saved);
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
});
