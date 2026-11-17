import { beforeAll, describe, expect, it } from 'vitest';
import { AUTODROMO, botInput, buildTrack, initPhysics, nearestSampleIndex, rightOf, SimWorld, TRACKS, yawQuat, type TrackDef } from '../src';

beforeAll(async () => {
  await initPhysics();
});

/** Lap time (s) of the perfect autopilot, timing its second lap. */
function lapTime(def: TrackDef): number {
  const track = buildTrack(def);
  const sim = new SimWorld(track);
  const car = sim.addCar('a', 0);
  const n = track.samples.length;
  let last = 0;
  let laps = 0;
  let start = 0;
  for (let t = 0; t < 60 * 120; t++) {
    sim.step(new Map([['a', botInput(car, track)]]));
    const p = car.body.translation();
    const i = nearestSampleIndex(track, p.x, p.z);
    if (i < last - n / 2) {
      laps++;
      if (laps === 1) start = t;
      if (laps === 2) {
        sim.free();
        return (t - start) / 60;
      }
    }
    last = i;
  }
  throw new Error('no lap');
}

describe('banking', () => {
  it('curvature is positive for right-hand turns, and corners raise their outside edge', () => {
    for (const def of TRACKS) {
      const track = buildTrack(def);
      const n = track.samples.length;
      for (let i = 0; i < n; i++) {
        const s = track.samples[i];
        const a = track.samples[(i - 2 + n) % n];
        const b = track.samples[(i + 2) % n];
        const r = rightOf(s.tx, s.tz);
        const toRight = (b.tx - a.tx) * r.x + (b.tz - a.tz) * r.z;
        // Clear corners only (curvature is smoothed, so it lags right at the transitions).
        if (Math.abs(toRight) < 0.1 || Math.abs(s.curvature) < 0.012) continue;
        expect(Math.sign(s.curvature)).toBe(Math.sign(toRight));
        // Outside edge raised wherever the corner is banked (ignoring the last few degrees of a
        // bank fading out as the next bend begins).
        if (Math.abs(s.bank) > 0.05) expect(track.leftEdge[i].y > track.rightEdge[i].y).toBe(toRight > 0);
      }
    }
  });

  it('Autodromo turns bank about 30 degrees', () => {
    const track = buildTrack(AUTODROMO);
    const max = Math.max(...track.samples.map((s) => Math.abs(s.bank))) * (180 / Math.PI);
    expect(max).toBeGreaterThan(28);
    expect(max).toBeLessThan(33);
  });

  it('banked turns are faster than the same turns flat', () => {
    const banked = lapTime(AUTODROMO);
    const flat = lapTime({ ...AUTODROMO, controlPoints: AUTODROMO.controlPoints.map((c) => ({ ...c, bank: 0 })) });
    expect(flat - banked).toBeGreaterThan(1);
  });

  it('too slow for the bank, a car slides down it', () => {
    const track = buildTrack(AUTODROMO);
    const sim = new SimWorld(track);
    const car = sim.addCar('a', 0);
    // Steepest point of turn 1, parked on the centre line.
    let i = 0;
    for (let k = 0; k < track.samples.length / 3; k++) if (track.samples[k].bank > track.samples[i].bank) i = k;
    const s = track.samples[i];
    const q = yawQuat(Math.atan2(s.tx, s.tz));
    car.setState({ p: [s.x, s.y + 1, s.z], q: [q.x, q.y, q.z, q.w], v: [0, 0, 0], w: [0, 0, 0], steer: 0, upset: 0 });
    for (let t = 0; t < 90; t++) sim.step(new Map());
    const p = car.body.translation();
    const r = rightOf(s.tx, s.tz);
    // Right-hand turn: the inside (low side) is to the right.
    expect((p.x - s.x) * r.x + (p.z - s.z) * r.z).toBeGreaterThan(0.5);
    sim.free();
  });
});
