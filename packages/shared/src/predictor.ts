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
 * When the server reports our inputs arriving late (it already simulated those ticks with a
 * guess), we may need to skip our sequence numbers forward. "Late" has two causes:
 *  - We dropped time (a frame too long to catch up on, e.g. a backgrounded tab): we really
 *    are behind. Skip right away. (Shorter hitches are caught up by running the missed
 *    ticks, after which our inputs are on time again without skipping.)
 *  - The network stalled: we're on time, our inputs are just stuck in transit. Skipping
 *    would push us ahead of the server for no reason, so only skip if it persists.
 */
const SKIP_IF_LATER_THAN = 3;
const SKIP_AFTER_LATE_SNAPSHOTS = 30;
/** After dropping time, eager skipping stays enabled for this many ticks. */
const HITCH_WINDOW_TICKS = 60;
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
  /** Times we've skipped sequence numbers to catch up (diagnostic). */
  skips = 0;
  private nextSeq = 1;
  /** After skipping ahead, ignore "late" reports until the server reaches this seq. */
  private skipSettlesAt = 0;
  private lateStreak = 0;
  private hitchUntilTick = -1;
  private replaying = false;
  /** Server tick of the green light while a countdown is on, else null. */
  private freezeUntil: number | null = null;
  /** Latest snapshot's tick and ack: seq s runs on server tick snapTick - 1 + (s - snapAck). */
  private snapTick = 0;
  private snapAck = 0;
  private windowMinLead = Infinity;
  private windowCount = 0;
  private calmWindows = 0;
  private pending: { seq: number; input: CarInput }[] = [];
  private readonly remoteInputs = new Map<string, CarInput>();

  constructor(
    public sim: SimWorld,
    public localId: string,
  ) {}

  /**
   * Swap in a new world (track change). Sequence numbers, clock sync and unacknowledged
   * inputs carry over: the server keeps consuming the same input stream in its new world.
   */
  replaceWorld(sim: SimWorld): void {
    this.sim = sim;
    this.remoteInputs.clear();
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Tell the predictor the client skipped simulating some real time (a frame longer than it
   * is willing to catch up on), so late reports right after are our fault, not the network's.
   */
  noteDroppedTime(seconds: number): void {
    if (seconds > 0.05) this.hitchUntilTick = this.tick + HITCH_WINDOW_TICKS;
  }

  /**
   * The race countdown: every car is held until server tick `startTick` (null = no freeze).
   * Because each server tick consumes exactly one of our seqs, we know which server tick each
   * of our inputs will run on, so we predict the freeze (and the green light) exactly.
   */
  setFreeze(startTick: number | null): void {
    this.freezeUntil = startTick;
  }

  /**
   * The server tick our displayed present corresponds to (our car is predicted ahead of the
   * latest snapshot). Race clocks use this so "GO" lines up with when our car can move.
   * Null until the server has acknowledged an input.
   */
  presentServerTick(): number | null {
    if (this.snapAck === 0) return null;
    return this.snapTick + (this.nextSeq - 1 - this.snapAck);
  }

  private frozenAt(seq: number): boolean {
    if (this.freezeUntil === null || this.snapAck === 0) return false;
    return this.snapTick - 1 + (seq - this.snapAck) < this.freezeUntil;
  }

  /** Simulate one live tick with a fresh local input. Returns what to send to the server. */
  step(rawInput: CarInput): { seq: number; input: CarInput } {
    const input = quantizeInput(rawInput);
    const seq = this.nextSeq++;
    this.pending.push({ seq, input });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    this.sim.step(this.inputsFor(input, this.frozenAt(seq)));
    this.tick++;
    return { seq, input };
  }

  /** Keep the world moving when we have no car (spectating): other cars on their last inputs. */
  stepWithoutCar(): void {
    this.sim.step(this.inputsFor(NEUTRAL_INPUT, false));
    this.tick++;
  }

  /** Apply an authoritative snapshot and re-simulate unacknowledged inputs. */
  reconcile(snap: Snapshot): Correction[] {
    const sim = this.sim;
    const present = new Set<string>();

    for (const c of snap.cars) {
      const id = String(c.id);
      present.add(id);
      const existing = sim.cars.get(id);
      if (!existing) sim.addCar(id, 0, c.cls).setState(c.state);
      else existing.setClass(c.cls);
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
    this.snapTick = snap.tick;
    this.snapAck = snap.ack;
    this.syncClock(snap);
    this.pending = this.pending.filter((p) => p.seq > snap.ack);
    // ack 0: the server hasn't consumed any of our inputs yet, so it hasn't mapped our
    // sequence numbers onto its ticks. Replaying now would predict every car too far ahead
    // and snap back once acks begin. Show the server state until then (one round trip).
    const firstReplay = snap.ack > 0 && !this.replaying;
    if (snap.ack > 0) {
      this.replaying = true;
      for (const p of this.pending) sim.step(this.inputsFor(p.input, this.frozenAt(p.seq)));
    }


    const corrections: Correction[] = [];
    for (const [id, car] of sim.cars) {
      const after = car.getState();
      // The first replay jumps every car from "server state" to "predicted now". That's a
      // change of timeline, not a misprediction: report no correction, so renderers snap
      // instead of gliding from the old position.
      corrections.push({ id, before: firstReplay ? after : (before.get(id) ?? after), after });
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
    const weHitched = this.tick <= this.hitchUntilTick && snap.lead < -SKIP_IF_LATER_THAN;
    const persistentlyLate = this.lateStreak >= SKIP_AFTER_LATE_SNAPSHOTS;
    if ((weHitched || persistentlyLate) && snap.ack >= this.skipSettlesAt) {
      // The server will simulate the skipped seqs with a guess: its last input from us.
      // Queue the same guess locally so the replay covers exactly the ticks the server will
      // run; otherwise every car would be predicted short by the gap and visibly jump back.
      const skip = -snap.lead + this.targetLead;
      const guess = { ...(this.pending[this.pending.length - 1]?.input ?? NEUTRAL_INPUT), reset: false };
      for (let i = 0; i < skip; i++) this.pending.push({ seq: this.nextSeq++, input: guess });
      this.skipSettlesAt = this.nextSeq;
      this.skips++;
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

  private inputsFor(local: CarInput, frozen: boolean): Map<string, CarInput> {
    const inputs = new Map<string, CarInput>();
    for (const id of this.sim.cars.keys()) {
      const input = id === this.localId ? local : (this.remoteInputs.get(id) ?? NEUTRAL_INPUT);
      inputs.set(id, frozen ? NEUTRAL_INPUT : input);
    }
    return inputs;
  }
}

