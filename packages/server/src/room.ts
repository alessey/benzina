import {
  botInput,
  decodeInput,
  encodeSnapshot,
  NEUTRAL_INPUT,
  SERVER_TICKS_PER_SNAPSHOT,
  SimWorld,
  withSnapshotHeader,
  type CarInput,
  type CarTuning,
  type ClientMessage,
  type PlayerInfo,
  type ServerMessage,
  type SnapshotCar,
  type Track,
} from '@benzina/shared';

export const MAX_CARS = 8;
/**
 * If a client's queue holds more than this many future inputs, its clock is running far ahead
 * (time dilation should prevent this); skip forward rather than lag behind forever.
 */
const MAX_QUEUED_INPUTS = 30;
const FIRST_BOT_ID = 100;

/** Anything that can deliver a frame to one client. A WebSocket in production, a stub in tests. */
export interface Connection {
  send(data: Uint8Array | string): void;
}

interface Player {
  info: PlayerInfo;
  conn: Connection;
  slot: number;
  /** Inputs received but not yet simulated, in seq order. */
  queue: { seq: number; input: CarInput }[];
  /** Last input simulated; reused as the guess when an input hasn't arrived in time. */
  lastInput: CarInput;
  /** Seq this tick should consume; null until the first input arrives. */
  nextSeq: number | null;
  /** Seq of the last tick simulated for this player (real or guessed input). */
  ack: number;
  lastSeqReceived: number;
  /** A reset arrived too late to apply on its own tick; apply it on the next one. */
  resetPending: boolean;
  /** Ticks simulated with a guessed input because the real one was late (diagnostic). */
  missedInputs: number;
}

interface Bot {
  info: PlayerInfo;
  slot: number;
  lastInput: CarInput;
}

export interface RoomOptions {
  bots?: number;
  /** Accept live tuning changes from clients (dev only). */
  allowTuning?: boolean;
}

/**
 * One race: an authoritative SimWorld plus the players driving in it.
 * Socket-free so it can be driven directly in tests.
 */
export class Room {
  readonly sim: SimWorld;
  private readonly players = new Map<number, Player>();
  private readonly bots = new Map<number, Bot>();

  constructor(
    readonly code: string,
    track: Track,
    private readonly options: RoomOptions = {},
  ) {
    this.sim = new SimWorld(track);
    for (let i = 0; i < Math.min(options.bots ?? 0, MAX_CARS - 1); i++) this.addBot();
  }

  get humanCount(): number {
    return this.players.size;
  }

  get carCount(): number {
    return this.players.size + this.bots.size;
  }

  /** True if another human can join (bots give up their seat for humans). */
  get hasRoomForHuman(): boolean {
    return this.players.size < MAX_CARS;
  }

  join(conn: Connection, name: string): number | null {
    if (!this.hasRoomForHuman) return null;
    if (this.carCount >= MAX_CARS) this.removeBot([...this.bots.keys()].pop()!);

    const id = this.freeId(1);
    const slot = this.freeSlot();
    const info: PlayerInfo = { id, name: name.slice(0, 20) || `Driver ${id}`, bot: false };
    this.sim.addCar(String(id), slot);
    this.players.set(id, {
      info,
      conn,
      slot,
      queue: [],
      lastInput: NEUTRAL_INPUT,
      nextSeq: null,
      ack: 0,
      lastSeqReceived: 0,
      resetPending: false,
      missedInputs: 0,
    });

    this.sendTo(conn, {
      type: 'welcome',
      id,
      room: this.code,
      tuning: this.sim.tuning,
      players: this.allPlayers(),
    });
    this.broadcast({ type: 'joined', player: info }, id);
    return id;
  }

  leave(id: number): void {
    if (!this.players.delete(id)) return;
    this.sim.removeCar(String(id));
    this.broadcast({ type: 'left', id });
  }

  handleBinary(id: number, data: Uint8Array): void {
    const player = this.players.get(id);
    const msg = decodeInput(data);
    if (!player || !msg || msg.seq <= player.lastSeqReceived) return;
    player.lastSeqReceived = msg.seq;
    player.queue.push(msg);
  }

  handleText(id: number, text: string): void {
    const player = this.players.get(id);
    if (!player) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'ping') {
      this.sendTo(player.conn, { type: 'pong', t: msg.t });
    } else if (msg.type === 'tuning' && this.options.allowTuning) {
      this.applyTuning(msg.tuning);
    }
  }

  /** Advance one fixed simulation tick, and send snapshots on snapshot ticks. */
  tick(): void {
    const inputs = new Map<string, CarInput>();

    for (const p of this.players.values()) {
      inputs.set(String(p.info.id), this.consumeInput(p));
    }

    for (const b of this.bots.values()) {
      const car = this.sim.cars.get(String(b.info.id))!;
      b.lastInput = botInput(car, this.sim.track, 0.9);
      inputs.set(String(b.info.id), b.lastInput);
    }

    this.sim.step(inputs);

    if (this.sim.tick % SERVER_TICKS_PER_SNAPSHOT === 0) this.sendSnapshots();
  }

  dispose(): void {
    this.sim.free();
  }

  /**
   * Every tick consumes exactly one input seq, even if that input hasn't arrived: then we
   * simulate with a guess (the previous input) and discard the real one when it shows up late.
   * This keeps the server's timeline for each car aligned 1:1 with the client's inputs, so
   * a network stall only costs the difference between guess and reality, never extra time.
   */
  private consumeInput(p: Player): CarInput {
    if (p.nextSeq === null) {
      if (p.queue.length === 0) return NEUTRAL_INPUT; // Haven't heard from this client yet.
      p.nextSeq = p.queue[0].seq;
    }
    if (p.queue.length > MAX_QUEUED_INPUTS) p.nextSeq = p.queue[p.queue.length - MAX_QUEUED_INPUTS].seq;

    // Drop inputs whose tick has already been simulated (with a guess).
    while (p.queue.length && p.queue[0].seq < p.nextSeq) {
      if (p.queue.shift()!.input.reset) p.resetPending = true;
    }

    let input: CarInput;
    if (p.queue.length && p.queue[0].seq === p.nextSeq) {
      input = p.queue.shift()!.input;
    } else {
      input = { ...p.lastInput, reset: false };
      p.missedInputs++;
    }
    if (p.resetPending) {
      input = { ...input, reset: true };
      p.resetPending = false;
    }
    p.lastInput = input;
    p.ack = p.nextSeq;
    p.nextSeq++;
    return input;
  }

  private sendSnapshots(): void {
    const cars: SnapshotCar[] = [];
    for (const p of this.players.values()) {
      cars.push({ id: p.info.id, state: this.sim.cars.get(String(p.info.id))!.getState(), input: p.lastInput });
    }
    for (const b of this.bots.values()) {
      cars.push({ id: b.info.id, state: this.sim.cars.get(String(b.info.id))!.getState(), input: b.lastInput });
    }
    const encoded = encodeSnapshot(this.sim.tick, cars);
    for (const p of this.players.values()) {
      p.conn.send(withSnapshotHeader(encoded, p.ack, p.queue.length));
    }
  }

  private applyTuning(partial: Partial<CarTuning>): void {
    const t = this.sim.tuning as unknown as Record<string, number>;
    for (const [k, v] of Object.entries(partial)) {
      if (k in t && typeof v === 'number' && Number.isFinite(v)) t[k] = v;
    }
    this.broadcast({ type: 'tuning', tuning: this.sim.tuning });
  }

  private addBot(): void {
    const id = this.freeId(FIRST_BOT_ID);
    const slot = this.freeSlot();
    const info: PlayerInfo = { id, name: `Bot ${id - FIRST_BOT_ID + 1}`, bot: true };
    this.sim.addCar(String(id), slot);
    this.bots.set(id, { info, slot, lastInput: NEUTRAL_INPUT });
  }

  private removeBot(id: number): void {
    this.bots.delete(id);
    this.sim.removeCar(String(id));
    this.broadcast({ type: 'left', id });
  }

  private allPlayers(): PlayerInfo[] {
    return [...this.players.values(), ...this.bots.values()].map((p) => p.info);
  }

  private freeId(from: number): number {
    let id = from;
    while (this.players.has(id) || this.bots.has(id)) id++;
    return id;
  }

  private freeSlot(): number {
    const used = new Set([...this.players.values(), ...this.bots.values()].map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    return slot;
  }

  private sendTo(conn: Connection, msg: ServerMessage): void {
    conn.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage, exceptId?: number): void {
    const text = JSON.stringify(msg);
    for (const p of this.players.values()) if (p.info.id !== exceptId) p.conn.send(text);
  }
}
