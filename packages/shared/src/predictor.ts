import { NEUTRAL_INPUT, type CarInput } from './input';
import { quantizeInput, type Snapshot } from './protocol';
import type { CarState } from './state';
import type { SimWorld } from './world';

/** Ideal number of our inputs waiting in the server's queue when it ticks. */
const TARGET_BUFFER = 2;
/** Cap on unacknowledged inputs (2 s). Beyond this the server is clearly not keeping up. */
const MAX_PENDING = 120;

export interface Correction {
  id: string;
  /** Car state just before the snapshot was applied (old timeline). */
  before: CarState;
  /** Car state after re-simulating pending inputs (new timeline). */
  after: CarState;
}

/**
 * Client-side prediction and reconciliation, independent of rendering and sockets.
 *
 * Every client tick we apply our input locally right away and send it to the server.
 * When a snapshot arrives we reset ALL cars to the server's state, then replay the
 * inputs the server hasn't processed yet. Remote cars are replayed with their last
 * known input, which forward-predicts them to "now". That matters for collisions:
 * we hit other cars where they are on the server, not where they were 100 ms ago.
 */
export class Predictor {
  /** Client tick counter (only advanced by live ticks, not replays). */
  tick = 0;
  /** Multiplier on the client tick rate, nudged so our inputs reach the server just in time. */
  timeScale = 1;
  private nextSeq = 1;
  private pending: { seq: number; input: CarInput }[] = [];
  private readonly remoteInputs = new Map<string, CarInput>();

  constructor(
    readonly sim: SimWorld,
    public localId: string,
  ) {}

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Simulate one live tick with a fresh local input. Returns what to send to the server. */
  step(rawInput: CarInput): { seq: number; input: CarInput } {
    const input = quantizeInput(rawInput);
    const seq = this.nextSeq++;
    this.pending.push({ seq, input });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    this.sim.step(this.inputsFor(input));
    this.tick++;
    return { seq, input };
  }

  /** Apply an authoritative snapshot and re-simulate unacknowledged inputs. */
  reconcile(snap: Snapshot): Correction[] {
    const sim = this.sim;
    const present = new Set<string>();

    for (const c of snap.cars) {
      const id = String(c.id);
      present.add(id);
      if (!sim.cars.has(id)) sim.addCar(id, 0).setState(c.state);
      // Never repeat a remote reset during prediction.
      this.remoteInputs.set(id, { ...c.input, reset: false });
    }
    for (const id of [...sim.cars.keys()]) {
      if (!present.has(id)) {
        sim.removeCar(id);
        this.remoteInputs.delete(id);
      }
    }

    const before = new Map<string, CarState>();
    for (const [id, car] of sim.cars) before.set(id, car.getState());

    for (const c of snap.cars) sim.cars.get(String(c.id))!.setState(c.state);
    this.pending = this.pending.filter((p) => p.seq > snap.ack);
    for (const p of this.pending) sim.step(this.inputsFor(p.input));

    // Nudge the client clock: too few inputs queued on the server → run faster, too many → slower.
    const error = TARGET_BUFFER - snap.buffered;
    const target = 1 + Math.max(-0.05, Math.min(0.05, error * 0.02));
    this.timeScale += (target - this.timeScale) * 0.2;

    const corrections: Correction[] = [];
    for (const [id, car] of sim.cars) {
      corrections.push({ id, before: before.get(id) ?? car.getState(), after: car.getState() });
    }
    return corrections;
  }

  private inputsFor(local: CarInput): Map<string, CarInput> {
    const inputs = new Map<string, CarInput>();
    for (const id of this.sim.cars.keys()) {
      inputs.set(id, id === this.localId ? local : (this.remoteInputs.get(id) ?? NEUTRAL_INPUT));
    }
    return inputs;
  }
}

