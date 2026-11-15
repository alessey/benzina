/**
 * Race rules: lobby → countdown → racing → results → lobby. Pure game logic over a SimWorld,
 * shared by the server (authoritative) and offline play.
 *
 * Laps are validated with checkpoints: the centre line is split into SECTORS equal parts that
 * must be entered in order, so reversing or skipping earns nothing. The grid sits behind the
 * start line; the first crossing starts your timed laps, each later crossing completes one.
 */
import { CAR_RIDE_HEIGHT, DT } from './config';
import { gridSlot, nearestSampleIndexNear, type Track } from './track';
import { yawQuat } from './state';
import type { SimWorld } from './world';

export type RacePhase = 'lobby' | 'countdown' | 'racing' | 'results';

export const SECTORS = 8;
export const COUNTDOWN_TICKS = 3 * 60;
/** After the winner finishes, everyone else has this long. */
export const FINISH_GRACE_TICKS = 30 * 60;
export const RESULTS_TICKS = 12 * 60;
/** A race can't last longer than this per lap (everyone AFK, all cars stuck): then it ends. */
export const MAX_TICKS_PER_LAP = 120 * 60;
export const MAX_LAPS = 20;

export interface RacerStanding {
  id: string;
  position: number;
  lapsDone: number;
  /** Crossed the start line at least once (timed laps have begun). */
  started: boolean;
  /** Tick the current lap started (only meaningful once started). */
  lapStartTick: number;
  lastLap: number | null;
  bestLap: number | null;
  /** Race time in seconds from the green light, once finished. */
  finishTime: number | null;
  dnf: boolean;
}

/** Everything clients need to show the race. Sent as JSON. */
export interface RaceState {
  phase: RacePhase;
  laps: number;
  /** First unfrozen tick (the green light). */
  startTick: number;
  /** Tick the current phase times out (results → lobby, or finish grace), or 0. */
  phaseEndsTick: number;
  standings: RacerStanding[];
}

interface Racer extends RacerStanding {
  sector: number;
  progress: number;
  finishTick: number | null;
  sampleHint: number;
}

export class Race {
  phase: RacePhase = 'lobby';
  laps = 3;
  startTick = 0;
  phaseEndsTick = 0;
  private racers: Racer[] = [];
  private firstFinishTick: number | null = null;

  constructor(private readonly track: Track) {}

  /**
   * Put the given cars on the grid (in order) and start the countdown. `tick` is the tick
   * about to be simulated.
   */
  start(sim: SimWorld, ids: string[], tick: number, laps: number): void {
    this.laps = Math.max(1, Math.min(MAX_LAPS, Math.round(laps)));
    this.phase = 'countdown';
    this.startTick = tick + COUNTDOWN_TICKS;
    this.phaseEndsTick = this.startTick;
    this.firstFinishTick = null;
    const n = this.track.samples.length;
    this.racers = ids.map((id, slot) => {
      const car = sim.cars.get(id);
      if (car) {
        const g = gridSlot(this.track, slot);
        const q = yawQuat(g.yaw);
        car.setState({ p: [g.x, g.y + CAR_RIDE_HEIGHT, g.z], q: [q.x, q.y, q.z, q.w], v: [0, 0, 0], w: [0, 0, 0], steer: 0, upset: 0 });
      }
      return {
        id,
        position: slot + 1,
        lapsDone: 0,
        started: false,
        lapStartTick: 0,
        lastLap: null,
        bestLap: null,
        finishTime: null,
        dnf: false,
        sector: SECTORS - 1,
        progress: -1,
        finishTick: null,
        sampleHint: n - 1,
      };
    });
  }

  /** During the countdown every car is held on the grid. `tick` = tick being simulated. */
  isFrozen(tick: number): boolean {
    return this.phase === 'countdown' && tick < this.startTick;
  }

  /** Is this car taking part in the current race? */
  isRacing(id: string): boolean {
    return this.phase !== 'lobby' && this.racers.some((r) => r.id === id);
  }

  /** A racer left: they're out. */
  retire(id: string): void {
    const r = this.racers.find((x) => x.id === id);
    if (r && r.finishTick === null) r.dnf = true;
  }

  /**
   * Advance race logic after a sim step. `tick` = the sim's tick after stepping.
   * Returns true when something clients care about changed (phase, laps, finishes).
   */
  update(sim: SimWorld, tick: number): boolean {
    let changed = false;
    if (this.phase === 'countdown' && tick >= this.startTick) {
      this.phase = 'racing';
      this.phaseEndsTick = 0;
      changed = true;
    }
    if (this.phase === 'racing') changed = this.updateRacing(sim, tick) || changed;
    if (this.phase === 'results' && tick >= this.phaseEndsTick) {
      this.phase = 'lobby';
      this.phaseEndsTick = 0;
      this.racers = [];
      changed = true;
    }
    return changed;
  }

  private updateRacing(sim: SimWorld, tick: number): boolean {
    let changed = false;
    const n = this.track.samples.length;
    const perSector = n / SECTORS;

    for (const r of this.racers) {
      if (r.dnf || r.finishTick !== null) continue;
      const car = sim.cars.get(r.id);
      if (!car) {
        r.dnf = true;
        changed = true;
        continue;
      }
      const p = car.body.translation();
      const idx = nearestSampleIndexNear(this.track, p.x, p.z, r.sampleHint);
      r.sampleHint = idx;
      const sector = Math.floor(idx / perSector);

      if (sector === (r.sector + 1) % SECTORS) {
        r.sector = sector;
        if (sector === 0) {
          if (!r.started) {
            r.started = true;
          } else {
            const lap = (tick - r.lapStartTick) * DT;
            r.lastLap = lap;
            if (r.bestLap === null || lap < r.bestLap) r.bestLap = lap;
            r.lapsDone++;
            if (r.lapsDone >= this.laps) {
              r.finishTick = tick;
              r.finishTime = (tick - this.startTick) * DT;
              this.firstFinishTick ??= tick;
            }
          }
          r.lapStartTick = tick;
          changed = true;
        }
      }

      // Progress: validated sectors plus how far into the current one (never backwards past it).
      const into = Math.max(0, Math.min(1, (idx - r.sector * perSector) / perSector));
      const sectorsDone = r.lapsDone * SECTORS + (r.started ? r.sector : r.sector - SECTORS);
      r.progress = sectorsDone + (idx >= r.sector * perSector && idx < (r.sector + 1) * perSector ? into : 0);
    }

    // Standings: finishers by time, then by progress, retirements last.
    const order = [...this.racers].sort((a, b) => {
      if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
      if ((a.finishTick === null) !== (b.finishTick === null)) return a.finishTick === null ? 1 : -1;
      if (a.finishTick !== null && b.finishTick !== null && a.finishTick !== b.finishTick) {
        return a.finishTick - b.finishTick;
      }
      if (a.progress !== b.progress) return b.progress - a.progress;
      return a.id < b.id ? -1 : 1;
    });
    order.forEach((r, i) => {
      if (r.position !== i + 1) {
        r.position = i + 1;
        changed = true;
      }
    });

    const running = this.racers.filter((r) => !r.dnf && r.finishTick === null);
    const timeLimit = this.startTick + this.laps * MAX_TICKS_PER_LAP;
    const deadline = this.firstFinishTick !== null ? Math.min(timeLimit, this.firstFinishTick + FINISH_GRACE_TICKS) : timeLimit;
    this.phaseEndsTick = deadline;
    if (running.length === 0 || tick >= deadline) {
      for (const r of running) r.dnf = true;
      this.phase = 'results';
      this.phaseEndsTick = tick + RESULTS_TICKS;
      changed = true;
    }
    return changed;
  }

  state(): RaceState {
    return {
      phase: this.phase,
      laps: this.laps,
      startTick: this.startTick,
      phaseEndsTick: this.phaseEndsTick,
      standings: [...this.racers]
        .sort((a, b) => a.position - b.position)
        .map(({ id, position, lapsDone, started, lapStartTick, lastLap, bestLap, finishTime, dnf }) => ({
          id,
          position,
          lapsDone,
          started,
          lapStartTick,
          lastLap,
          bestLap,
          finishTime,
          dnf,
        })),
    };
  }
}
