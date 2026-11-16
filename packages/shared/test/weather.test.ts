import { beforeAll, describe, expect, it } from 'vitest';
import {
  botInput,
  buildTrack,
  CAR_CLASSES,
  DT,
  initPhysics,
  nearestSampleIndex,
  SimWorld,
  TRACKS,
  trackPuddles,
  weatherTuning,
  type CarClass,
  type TrackDef,
  type Weather,
} from '../src';

beforeAll(async () => {
  await initPhysics();
});

/** Flying lap for the autopilot (planning corners with the wet tuning in rain), plus puddle ticks. */
function lap(def: TrackDef, cls: CarClass, weather: Weather): { time: number; puddleTicks: number } {
  const track = buildTrack(def);
  const n = track.samples.length;
  const sim = new SimWorld(track);
  sim.weather = weather;
  const car = sim.addCar('a', 0, cls);
  let last = nearestSampleIndex(track, car.body.translation().x, car.body.translation().z);
  const crossings: number[] = [];
  let puddleTicks = 0;
  for (let t = 0; t < 60 * 240 && crossings.length < 3; t++) {
    sim.step(new Map([['a', botInput(car, track, 1, weatherTuning(sim.tuning, weather), sim.tick * DT)]]));
    if (crossings.length === 1 && car.puddle) puddleTicks++;
    const p = car.body.translation();
    const i = nearestSampleIndex(track, p.x, p.z);
    if (last > n * 0.9 && i < n * 0.1) crossings.push(t);
    last = i;
  }
  sim.free();
  return { time: (crossings[2] - crossings[1]) / 60, puddleTicks };
}

describe('weather', () => {
  it('rain is slower for every class on every track, by a noticeable but fair margin', () => {
    const slowdowns: Record<CarClass, number[]> = { equilibrio: [], bolide: [], scatto: [], artiglio: [] };
    for (const def of TRACKS) {
      for (const cls of CAR_CLASSES) {
        const dry = lap(def, cls, 'clear');
        const wet = lap(def, cls, 'rain');
        slowdowns[cls].push(wet.time / dry.time - 1);
        // Channels are ice (no puddles); every other track has some on the racing line.
        if (def.pipe) expect(wet.puddleTicks).toBe(0);
        else expect(wet.puddleTicks).toBeGreaterThan(0);
      }
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // The grip car copes best with the wet; the fast, loose one worst.
    expect(avg(slowdowns.artiglio)).toBeLessThan(Math.min(avg(slowdowns.equilibrio), avg(slowdowns.scatto), avg(slowdowns.bolide)));
    expect(avg(slowdowns.bolide)).toBeGreaterThan(Math.max(avg(slowdowns.equilibrio), avg(slowdowns.scatto)));
    for (const cls of CAR_CLASSES) {
      expect(avg(slowdowns[cls])).toBeGreaterThan(0.03);
      expect(avg(slowdowns[cls])).toBeLessThan(0.2);
    }
  });

  it('every track has puddles, clear of the start and the tunnel (except ice channels)', () => {
    for (const def of TRACKS.filter((d) => !d.pipe)) {
      const track = buildTrack(def);
      const puddles = trackPuddles(track);
      expect(puddles.length).toBeGreaterThanOrEqual(3);
      for (const p of puddles) expect(track.samples[p.i0].dist).toBeGreaterThan(80);
    }
  });
});
