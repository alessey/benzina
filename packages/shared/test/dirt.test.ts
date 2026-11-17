import { beforeAll, describe, expect, it } from 'vitest';
import {
  AUTODROMO,
  botInput,
  buildTrack,
  DEFAULT_TUNING,
  initPhysics,
  nearestSampleIndex,
  onDirt,
  SimWorld,
  trackPuddles,
  weatherTuning,
  type Weather,
} from '../src';

beforeAll(async () => {
  await initPhysics();
});

const track = buildTrack(AUTODROMO);

/** Two laps of the perfect autopilot: second lap time, average speeds on dirt and tarmac. */
function drive(weather: Weather) {
  const sim = new SimWorld(track);
  sim.weather = weather;
  const car = sim.addCar('a', 0);
  const n = track.samples.length;
  let last = 0;
  let laps = 0;
  let start = 0;
  let time = 0;
  const speed = { dirt: 0, dirtTicks: 0, tarmac: 0, tarmacTicks: 0, dirtFlag: 0 };
  for (let t = 0; t < 60 * 200 && laps < 2; t++) {
    sim.step(new Map([['a', botInput(car, track, 1, weatherTuning(DEFAULT_TUNING, weather), 0, weather)]]));
    const p = car.body.translation();
    const i = nearestSampleIndex(track, p.x, p.z);
    if (i < last - n / 2) {
      laps++;
      if (laps === 1) start = t;
      else time = (t - start) / 60;
    }
    last = i;
    if (laps !== 1) continue;
    if (onDirt(track, i)) {
      speed.dirt += car.forwardSpeed();
      speed.dirtTicks++;
      if (car.dirt) speed.dirtFlag++;
    } else {
      speed.tarmac += car.forwardSpeed();
      speed.tarmacTicks++;
    }
  }
  sim.free();
  return { time, dirt: speed.dirt / speed.dirtTicks, tarmac: speed.tarmac / speed.tarmacTicks, dirtShare: speed.dirtFlag / speed.dirtTicks };
}

describe('dirt', () => {
  it('Autodromo has a long dirt section, and no puddles on it (it turns to mud instead)', () => {
    const n = track.samples.length;
    const dirt = track.samples.filter((_, i) => onDirt(track, i)).length;
    expect(dirt / n).toBeGreaterThan(0.45);
    for (const p of trackPuddles(track)) {
      for (let i = p.i0; i <= p.i1; i++) expect(onDirt(track, i)).toBe(false);
    }
  });

  it('dirt is slower than tarmac, mud slower still, and bots handle both', () => {
    const dry = drive('clear');
    const wet = drive('rain');
    expect(dry.time).toBeGreaterThan(0);
    expect(wet.time).toBeGreaterThan(0);
    // Cars know they're on dirt (dust, sound) whenever their wheels are down on it.
    expect(dry.dirtShare).toBeGreaterThan(0.7);
    expect(dry.dirt).toBeLessThan(dry.tarmac * 0.85);
    expect(wet.dirt).toBeLessThan(dry.dirt * 0.95);
    expect(wet.time).toBeGreaterThan(dry.time * 1.04);
    expect(wet.time).toBeLessThan(dry.time * 1.25);
  });
});
