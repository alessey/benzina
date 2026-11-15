import { beforeAll, describe, expect, it } from 'vitest';
import { botInput, COUNTDOWN_TICKS, initPhysics, type Car } from '@benzina/shared';
import { runScenario, stats, track } from './harness';

beforeAll(async () => {
  await initPhysics();
});

const racer = (car: Car) => botInput(car, track);
/** Clients join an empty room in order, so they get ids 1, 2, ... */
const run_ids = [1, 2];

describe('networked race', () => {
  it('countdown and green light are predicted exactly: no creeping, no correction at GO, race completes', () => {
    let startAt = -1;
    // How far each player's own car strays from where the server holds it during the countdown.
    let maxCreep = 0;
    let creepSamples = 0;
    const run = runScenario({
      ticks: 60 * 120,
      link: { latency: 6 },
      policies: [racer, racer],
      script: (now, ctl) => {
        // Host (client 0) starts a one-lap race after 2 s of free driving.
        if (now === 120) {
          ctl.send(0, { type: 'start', laps: 1 });
          startAt = now;
        }
        const race = ctl.room.race;
        // Mid-countdown (after the grid teleport has reached clients, before the green light).
        if (race.phase === 'countdown' && ctl.room.sim.tick > race.startTick - COUNTDOWN_TICKS + 40 && ctl.room.sim.tick < race.startTick - 20) {
          for (const index of [0, 1]) {
            const seen = ctl.predictedCar(index)?.body.translation();
            const truth = ctl.room.sim.cars.get(String(run_ids[index]))?.body.translation();
            if (!seen || !truth) continue;
            maxCreep = Math.max(maxCreep, Math.hypot(seen.x - truth.x, seen.z - truth.z));
            creepSamples++;
          }
        }
      },
      until: (room) => room.race.phase === 'results',
    });
    expect(run.room.race.phase).toBe('results');
    // Every player's car sat still on its grid spot (without freeze prediction: ~0.6 m creep).
    expect(creepSamples).toBeGreaterThan(100);
    expect(maxCreep).toBeLessThan(0.05);
    const standings = run.room.race.state().standings;
    expect(standings).toHaveLength(2);
    expect(standings.every((r) => r.finishTime !== null)).toBe(true);

    // The bots hold full throttle all through the countdown. If clients didn't predict the
    // freeze, their cars would surge ahead locally and get yanked back at every snapshot.
    const raceWindow = run.samples.filter((s) => s.local && s.tick > startAt + 30 && s.tick < startAt + COUNTDOWN_TICKS + 120);
    const local = stats(raceWindow.map((s) => s.error));
    expect(local.n).toBeGreaterThan(50);
    expect(local.max).toBeLessThan(0.3);
    run.dispose();
  });

  it('a mid-race joiner spectates, then gets a car in the next lobby', () => {
    const run = runScenario({
      ticks: 60 * 120,
      link: { latency: 4 },
      policies: [racer],
      bots: 1, // keeps racing (and finishes) after the harness stops driving the client
      script: (now, ctl) => {
        if (now === 60) ctl.send(0, { type: 'start', laps: 1 });
      },
      until: (room) => room.race.phase === 'racing',
    });
    const room = run.room;
    const sent: (string | Uint8Array)[] = [];
    const id = room.join({ send: (d) => sent.push(d) }, 'latecomer')!;
    const welcome = JSON.parse(sent[0] as string);
    expect(welcome.spectator).toBe(true);
    expect(room.sim.cars.has(String(id))).toBe(false);

    // Race on until results, then until the lobby reopens.
    for (let i = 0; i < 60 * 120 && room.race.phase !== 'lobby'; i++) room.tick();
    expect(room.race.phase).toBe('lobby');
    expect(room.sim.cars.has(String(id))).toBe(true);
    // The spectator was receiving snapshots all along.
    expect(sent.filter((d) => typeof d !== 'string').length).toBeGreaterThan(100);
    run.dispose();
  });

  it('only the host can start a race, and hosting passes on when the host leaves', () => {
    const run = runScenario({ ticks: 10, link: { latency: 1 }, policies: [racer, racer] });
    const room = run.room;
    const [host, guest] = run.clients;
    room.handleText(guest.id, JSON.stringify({ type: 'start', laps: 2 }));
    expect(room.race.phase).toBe('lobby');
    room.leave(host.id);
    room.handleText(guest.id, JSON.stringify({ type: 'start', laps: 2 }));
    expect(room.race.phase).toBe('countdown');
    expect(room.race.laps).toBe(2);
    run.dispose();
  });
});
