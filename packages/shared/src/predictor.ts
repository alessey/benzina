import { NEUTRAL_INPUT, type CarInput } from './input';
import { quantizeInput, type Snapshot } from './protocol';
import type { CarState } from './state';
import type { SimWorld } from './world';

/** Bounds for how many of our inputs we try to keep queued on the server. */
const MIN_TARGET_LEAD = 2;
const MAX_TARGET_LEAD = 8;
/** Snapshots per adaptation window (~1 s at 30 Hz). */
const LEAD_WINDOW = 30;
/**
 * Skip our sequence numbers forward only when persistently late (a backgrounded tab, a
 * dead link), not during a brief stall, which clears up by itself once data flows again.
 */
const SKIP_IF_LATER_THAN = 30;
const SKIP_AFTER_LATE_SNAPSHOTS = 10;
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
  /** How many inputs ahead of the server we aim to be; grows on jittery links. */
  targetLead = MIN_TARGET_LEAD;
  private nextSeq = 1;
  /** After skipping ahead, ignore "late" reports until the server reaches this seq. */
  private skipSettlesAt = 0;
  private lateStreak = 0;
  private windowMinLead = Infinity;
  private windowCount = 0;
  private calmWindows = 0;
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

    this.syncClock(snap);

    const corrections: Correction[] = [];
    for (const [id, car] of sim.cars) {
      corrections.push({ id, before: before.get(id) ?? car.getState(), after: car.getState() });
    }
    return corrections;
  }

  /**
   * Keep our inputs arriving just before the server needs them.
   *  - Far behind (backgrounded tab, long stall): jump our sequence numbers forward.
   *  - Slightly off: run the client clock up to 5% fast or slow.
   *  - Jittery link (inputs keep arriving late): aim for a bigger lead.
   */
  private syncClock(snap: Snapshot): void {
    this.lateStreak = snap.lead < 0 ? this.lateStreak + 1 : 0;
    const persistentlyLate = snap.lead < -SKIP_IF_LATER_THAN || this.lateStreak >= SKIP_AFTER_LATE_SNAPSHOTS;
    if (persistentlyLate && snap.ack >= this.skipSettlesAt) {
      this.nextSeq += -snap.lead + this.targetLead;
      this.skipSettlesAt = this.nextSeq;
      this.lateStreak = 0;
    }

    this.windowMinLead = Math.min(this.windowMinLead, snap.lead);
    if (++this.windowCount >= LEAD_WINDOW) {
      if (this.windowMinLead < 1) {
        this.targetLead = Math.min(MAX_TARGET_LEAD, this.targetLead + 1);
        this.calmWindows = 0;
      } else if (this.windowMinLead > this.targetLead + 1 && ++this.calmWindows >= 3) {
        this.targetLead = Math.max(MIN_TARGET_LEAD, this.targetLead - 1);
        this.calmWindows = 0;
      }
      this.windowMinLead = Infinity;
      this.windowCount = 0;
    }

    const error = this.targetLead - snap.lead;
    const target = 1 + Math.max(-0.05, Math.min(0.05, error * 0.02));
    this.timeScale += (target - this.timeScale) * 0.2;
  }

  private inputsFor(local: CarInput): Map<string, CarInput> {
    const inputs = new Map<string, CarInput>();
    for (const id of this.sim.cars.keys()) {
      inputs.set(id, id === this.localId ? local : (this.remoteInputs.get(id) ?? NEUTRAL_INPUT));
    }
    return inputs;
  }
}

