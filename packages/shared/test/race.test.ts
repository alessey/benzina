import { beforeAll, describe, expect, it } from 'vitest';
import {
  botInput,
  buildTrack,
  COUNTDOWN_TICKS,
  DEFAULT_TRACK,
  FINISH_GRACE_TICKS,
  initPhysics,
  NEUTRAL_INPUT,
  Race,
  MAX_TICKS_PER_LAP,
  RESULTS_TICKS,
  SimWorld,
  type Car,
  type CarInput,
} from '../src';

const track = buildTrack(DEFAULT_TRACK);

beforeAll(async () => {
  await initPhysics();
});

type Driver = (car: Car) => CarInput;

/** Step the world with race rules applied the same way the server does. */
function runTicks(sim: SimWorld, race: Race, drivers: Record<string, Driver>, ticks: number, until?: () => boolean) {
  for (let i = 0; i < ticks && !until?.(); i++) {
    const frozen = race.isFrozen(sim.tick);
    const inputs = new Map<string, CarInput>();
    for (const [id, car] of sim.cars) inputs.set(id, frozen ? NEUTRAL_INPUT : (drivers[id]?.(car) ?? NEUTRAL_INPUT));
    sim.step(inputs);
    race.update(sim, sim.tick);
  }
}

const bot =
  (skill = 1): Driver =>
  (car) =>
    botInput(car, track, skill);

describe('Race', () => {
  it('runs countdown → racing → results → lobby, with everyone frozen on the grid until the green light', () => {
    const sim = new SimWorld(track);
    for (const id of ['1', '2', '3']) sim.addCar(id, 0);
    const race = new Race(track);
    race.start(sim, ['1', '2', '3'], sim.tick, 1);
    expect(race.phase).toBe('countdown');

    const startPos = sim.cars.get('1')!.body.translation();
    runTicks(sim, race, { '1': bot(), '2': bot(), '3': bot() }, COUNTDOWN_TICKS - 1);
    const heldPos = sim.cars.get('1')!.body.translation();
    expect(Math.hypot(heldPos.x - startPos.x, heldPos.z - startPos.z)).toBeLessThan(0.05);
    expect(race.phase).toBe('countdown');

    runTicks(sim, race, { '1': bot(), '2': bot(), '3': bot() }, 2);
    expect(race.phase).toBe('racing');

    runTicks(sim, race, { '1': bot(), '2': bot(), '3': bot() }, 60 * 90, () => race.phase === 'results');
    expect(race.phase).toBe('results');
    const s = race.state().standings;
    expect(s.map((r) => r.position)).toEqual([1, 2, 3]);
    for (const r of s) {
      expect(r.lapsDone).toBe(1);
      expect(r.finishTime).not.toBeNull();
      expect(r.lastLap).not.toBeNull();
    }
    // Finish times are ordered by position.
    expect(s[0].finishTime!).toBeLessThanOrEqual(s[1].finishTime!);
    expect(s[1].finishTime!).toBeLessThanOrEqual(s[2].finishTime!);

    runTicks(sim, race, {}, RESULTS_TICKS + 1);
    expect(race.phase).toBe('lobby');
    sim.free();
  });

  it('the faster driver wins and positions reflect the order on track', () => {
    const sim = new SimWorld(track);
    sim.addCar('slow', 0);
    sim.addCar('fast', 1);
    const race = new Race(track);
    // The slow car starts on pole.
    race.start(sim, ['slow', 'fast'], sim.tick, 2);
    runTicks(sim, race, { slow: bot(0.55), fast: bot(1) }, 60 * 180, () => race.phase === 'results');
    const s = race.state().standings;
    expect(s[0].id).toBe('fast');
    expect(s[0].finishTime!).toBeLessThan(s[1].finishTime ?? Infinity);
    sim.free();
  });

  it('driving backwards over the line earns nothing', () => {
    const sim = new SimWorld(track);
    sim.addCar('rev', 0);
    const race = new Race(track);
    race.start(sim, ['rev'], sim.tick, 1);
    // Reverse from the grid for 20 s: away from the start line, the wrong way round.
    runTicks(sim, race, { rev: () => ({ ...NEUTRAL_INPUT, throttle: -1 }) }, COUNTDOWN_TICKS + 60 * 20);
    const r = race.state().standings[0];
    expect(r.lapsDone).toBe(0);
    expect(r.started).toBe(false);
    sim.free();
  });

  it('a racer who leaves is retired, and the race still ends', () => {
    const sim = new SimWorld(track);
    sim.addCar('stay', 0);
    sim.addCar('quit', 1);
    const race = new Race(track);
    race.start(sim, ['stay', 'quit'], sim.tick, 1);
    runTicks(sim, race, { stay: bot(), quit: bot() }, COUNTDOWN_TICKS + 120);
    sim.removeCar('quit');
    runTicks(sim, race, { stay: bot() }, 60 * 90, () => race.phase === 'results');
    const s = race.state().standings;
    expect(race.phase).toBe('results');
    expect(s.find((r) => r.id === 'quit')!.dnf).toBe(true);
    expect(s[0].id).toBe('stay');
    sim.free();
  });

  it('stragglers are given a grace period after the winner, then marked DNF', () => {
    const sim = new SimWorld(track);
    sim.addCar('winner', 0);
    sim.addCar('parked', 1);
    const race = new Race(track);
    race.start(sim, ['winner', 'parked'], sim.tick, 1);
    runTicks(sim, race, { winner: bot() }, 60 * 90, () => race.state().standings.some((r) => r.finishTime !== null));
    expect(race.phase).toBe('racing');
    runTicks(sim, race, { winner: bot() }, FINISH_GRACE_TICKS + 2, () => race.phase === 'results');
    expect(race.phase).toBe('results');
    expect(race.state().standings.find((r) => r.id === 'parked')!.dnf).toBe(true);
    sim.free();
  });

  it('a race where nobody can finish still ends at the time limit', () => {
    const sim = new SimWorld(track);
    sim.addCar('afk', 0);
    const race = new Race(track);
    race.start(sim, ['afk'], sim.tick, 1);
    runTicks(sim, race, {}, COUNTDOWN_TICKS + MAX_TICKS_PER_LAP + 2, () => race.phase === 'results');
    expect(race.phase).toBe('results');
    expect(race.state().standings[0].dnf).toBe(true);
    sim.free();
  });
});
