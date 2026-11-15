import { beforeAll, describe, expect, it } from 'vitest';
import { BOT_PROFILES, botInput, buildTrack, CAR_CLASSES, COLLINE, DT, initPhysics, nearestSampleIndex, PORTO_AZZURRO, SimWorld, TRACKS, type CarClass, type TrackDef } from '../src';

beforeAll(async () => {
  await initPhysics();
});

/** Flying-lap time for one class on one track, driven by the autopilot (or a bot profile). */
function lapTime(def: TrackDef, cls: CarClass, profile?: (typeof BOT_PROFILES)[keyof typeof BOT_PROFILES]): number {
  const track = buildTrack(def);
  const n = track.samples.length;
  const sim = new SimWorld(track);
  const car = sim.addCar('a', 0, cls);
  let last = nearestSampleIndex(track, car.body.translation().x, car.body.translation().z);
  const crossings: number[] = [];
  for (let t = 0; t < 60 * 200 && crossings.length < 3; t++) {
    sim.step(new Map([['a', profile ? botInput(car, track, profile, sim.tuning, sim.tick * DT) : botInput(car, track)]]));
    const p = car.body.translation();
    const i = nearestSampleIndex(track, p.x, p.z);
    if (last > n * 0.9 && i < n * 0.1) crossings.push(t);
    last = i;
  }
  sim.free();
  return (crossings[2] - crossings[1]) / 60;
}

describe('car classes', () => {
  const times = new Map<string, number>();
  const time = (def: TrackDef, cls: CarClass) => {
    const key = `${def.id}/${cls}`;
    if (!times.has(key)) times.set(key, lapTime(def, cls));
    return times.get(key)!;
  };

  it('are balanced: average lap times across all tracks within 2% of each other', () => {
    const averages = CAR_CLASSES.map((cls) => TRACKS.reduce((sum, def) => sum + time(def, cls), 0) / TRACKS.length);
    expect(Math.max(...averages) / Math.min(...averages)).toBeLessThan(1.02);
  });

  it('suit different tracks: Bolide is fastest on fast, hilly Colline; Artiglio on twisty Porto Azzurro', () => {
    const fastest = (def: TrackDef) => [...CAR_CLASSES].sort((a, b) => time(def, a) - time(def, b))[0];
    expect(fastest(COLLINE)).toBe('bolide');
    expect(fastest(PORTO_AZZURRO)).toBe('artiglio');
  });

  it('bot difficulties are ordered and roughly where intended (Easy ~11%, Normal ~4% off perfect)', () => {
    const total = (p?: (typeof BOT_PROFILES)['easy']) => TRACKS.reduce((sum, def) => sum + lapTime(def, 'equilibrio', p), 0);
    const perfect = total();
    const easy = total(BOT_PROFILES.easy) / perfect - 1;
    const normal = total(BOT_PROFILES.normal) / perfect - 1;
    const hard = total(BOT_PROFILES.hard) / perfect - 1;
    expect(easy).toBeGreaterThan(0.07);
    expect(easy).toBeLessThan(0.15);
    expect(normal).toBeGreaterThan(0.02);
    expect(normal).toBeLessThan(0.07);
    expect(Math.abs(hard)).toBeLessThan(0.02);
  });
});
