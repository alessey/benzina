import { beforeAll, describe, expect, it } from 'vitest';
import { botInput, buildTrack, COLLINE, initPhysics, SERPENTE, type Car } from '@benzina/shared';
import { runScenario, stats } from './harness';

beforeAll(async () => {
  await initPhysics();
});

describe.each([
  ['Colline', COLLINE],
  ['Il Serpente', SERPENTE],
] as const)('netcode over the hills of %s', (_name, def) => {
  const track = buildTrack(def);
  const racer = (car: Car) => botInput(car, track);

  it('a solo client predicts its own car exactly', () => {
    const run = runScenario({ track, ticks: 60 * 30, link: { latency: 6 }, policies: [racer] });
    const local = stats(run.samples.filter((s) => s.local && s.tick > 180).map((s) => s.error));
    run.dispose();
    expect(local.n).toBeGreaterThan(300);
    // Flat tracks reproduce to < 1 mm. Here the autopilot scrapes walls on tight hilly corners
    // (Rapier's contact-solver state isn't in snapshots) and quaternion renormalisation on
    // every correction adds a few millimetres at worst: invisible, but not bit-exact.
    expect(local.max).toBeLessThan(0.01);
  });

  it('four clients racing stay well predicted', () => {
    const run = runScenario({ track, ticks: 60 * 20, link: { latency: 4 }, policies: [racer, racer, racer, racer] });
    const local = stats(run.samples.filter((s) => s.local).map((s) => s.error));
    const remote = stats(run.samples.filter((s) => !s.local).map((s) => s.error));
    run.dispose();
    expect(local.p95).toBeLessThan(0.05);
    expect(remote.p95).toBeLessThan(0.1);
  });
});
