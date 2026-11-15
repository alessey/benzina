import { beforeAll, describe, expect, it } from 'vitest';
import { botInput, initPhysics, type Car, type SimWorld } from '@benzina/shared';
import { runScenario, stats, track, type Policy } from './harness';

beforeAll(async () => {
  await initPhysics();
});

/** Drive the racing line, but every ~1.5 s swerve toward the nearest other car for 1/3 s. */
const aggressive =
  (phase: number): Policy =>
  (car: Car, tick: number, sim: SimWorld) => {
    const base = botInput(car, track);
    if ((tick + phase) % 90 > 20) return base;
    const me = car.body.translation();
    let target: { x: number; z: number } | null = null;
    let best = Infinity;
    for (const other of sim.cars.values()) {
      if (other === car) continue;
      const p = other.body.translation();
      const d = Math.hypot(p.x - me.x, p.z - me.z);
      if (d < best) {
        best = d;
        target = p;
      }
    }
    if (!target || best > 12) return base;
    const yaw = Math.atan2(2 * car.body.rotation().y * car.body.rotation().w, 1 - 2 * car.body.rotation().y ** 2);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const dx = target.x - me.x;
    const dz = target.z - me.z;
    const side = Math.sign(dx * -fz + dz * fx);
    return { ...base, steer: side };
  };

export function summarise(samples: ReturnType<typeof runScenario>['samples']) {
  const contact = samples.filter((s) => s.nearestCar < 5);
  const apart = samples.filter((s) => s.nearestCar >= 8);
  const pick = (arr: typeof samples, local: boolean) => stats(arr.filter((s) => s.local === local).map((s) => s.error));
  return {
    localContact: pick(contact, true),
    remoteContact: pick(contact, false),
    localApart: pick(apart, true),
    remoteApart: pick(apart, false),
  };
}

const racer = (car: Car) => botInput(car, track);

describe('car-to-car collisions over the network', () => {
  it('grid start pile-up, four clients at ~130 ms RTT: corrections stay small', () => {
    const run = runScenario({ ticks: 60 * 20, link: { latency: 4 }, policies: [racer, racer, racer, racer] });
    const s = summarise(run.samples);
    run.dispose();
    expect(s.localContact.n).toBeGreaterThan(500);
    expect(s.localContact.p95).toBeLessThan(0.05);
    expect(s.localContact.max).toBeLessThan(0.5);
    expect(s.remoteContact.p95).toBeLessThan(0.1);
    expect(s.remoteContact.max).toBeLessThan(1);
  });

  it('one client among three server bots at 20 fps', () => {
    const run = runScenario({ ticks: 60 * 20, link: { latency: 4 }, bots: 3, frameEvery: 3, policies: [racer] });
    const s = summarise(run.samples);
    run.dispose();
    expect(s.localContact.max).toBeLessThan(0.5);
    expect(s.remoteContact.max).toBeLessThan(1);
  });

  it('aggressive swerving into each other at ~200 ms RTT with stalls', () => {
    const run = runScenario({
      ticks: 60 * 40,
      link: { latency: 6, stallChance: 0.02, stallTicks: 15 },
      policies: [aggressive(0), aggressive(45), racer, racer],
    });
    const s = summarise(run.samples);
    run.dispose();
    expect(s.localContact.n).toBeGreaterThan(100);
    // Harsh conditions: the prediction horizon reaches ~0.5 s, so remote cars that change
    // steering get corrected by a few metres at worst. Typical corrections stay small.
    expect(s.localContact.p95).toBeLessThan(0.25);
    expect(s.localContact.max).toBeLessThan(3);
    expect(s.remoteContact.p95).toBeLessThan(0.6);
    expect(s.remoteApart.max).toBeLessThan(5);
  });
});
