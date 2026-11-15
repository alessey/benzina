/**
 * Wire protocol. Hot-path messages (inputs, snapshots) are compact binary frames;
 * rare control messages (welcome, joins, ping, tuning) are JSON text frames.
 */
import type { CarTuning } from './config';
import type { RaceState } from './race';
import type { CarInput } from './input';
import type { CarState } from './state';

export const SERVER_TICKS_PER_SNAPSHOT = 2; // 60 Hz sim → 30 Hz snapshots

// ---------------------------------------------------------------- inputs

/**
 * Inputs are quantized before use on BOTH sides, so the client predicts with exactly
 * the values the server will simulate.
 */
export function quantizeInput(i: CarInput): CarInput {
  return {
    throttle: Math.round(clamp1(i.throttle) * 127) / 127,
    steer: Math.round(clamp1(i.steer) * 127) / 127,
    handbrake: i.handbrake,
    reset: i.reset,
  };
}

function clamp1(v: number): number {
  return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}

const FLAG_HANDBRAKE = 1;
const FLAG_RESET = 2;

function writeInput(view: DataView, offset: number, i: CarInput): void {
  view.setInt8(offset, Math.round(clamp1(i.throttle) * 127));
  view.setInt8(offset + 1, Math.round(clamp1(i.steer) * 127));
  view.setUint8(offset + 2, (i.handbrake ? FLAG_HANDBRAKE : 0) | (i.reset ? FLAG_RESET : 0));
}

function readInput(view: DataView, offset: number): CarInput {
  const flags = view.getUint8(offset + 2);
  return {
    throttle: view.getInt8(offset) / 127,
    steer: view.getInt8(offset + 1) / 127,
    handbrake: (flags & FLAG_HANDBRAKE) !== 0,
    reset: (flags & FLAG_RESET) !== 0,
  };
}

const INPUT_BYTES = 3;
const MSG_INPUT = 1;
const MSG_SNAPSHOT = 2;

/** Client → server, once per client tick: [type u8][seq u32][input 3B]. */
export function encodeInput(seq: number, input: CarInput): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(5 + INPUT_BYTES);
  const view = new DataView(buf.buffer);
  view.setUint8(0, MSG_INPUT);
  view.setUint32(1, seq);
  writeInput(view, 5, input);
  return buf;
}

export function decodeInput(buf: Uint8Array): { seq: number; input: CarInput } | null {
  if (buf.byteLength !== 5 + INPUT_BYTES || buf[0] !== MSG_INPUT) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { seq: view.getUint32(1), input: readInput(view, 5) };
}

// ------------------------------------------------------------- snapshots

export interface SnapshotCar {
  id: number;
  state: CarState;
  /** Last input the server applied to this car; clients use it to predict remote cars. */
  input: CarInput;
}

export interface Snapshot {
  tick: number;
  /** Seq of the last input from the receiving client that the server has consumed. */
  ack: number;
  /**
   * How far ahead of the server's need the receiving client's inputs are arriving, in ticks:
   * the number queued when positive, how late they are when negative. Drives client time sync.
   */
  lead: number;
  cars: SnapshotCar[];
}

// Header: type u8, tick u32, ack u32, lead i8, count u8.
const SNAP_HEADER = 11;
// Per car: id u8, p 3×f64, q (y, w) 2×f64, v 3×f64, w.y f64, steer f64, upset f64, input 3B.
// Rotations are yaw-only (roll/pitch locked), so q.x and q.z are always zero.
// f64 keeps client re-simulation close to the server's; quantize later if bandwidth matters.
const SNAP_FLOATS = 11;
const SNAP_CAR = 1 + 8 * SNAP_FLOATS + INPUT_BYTES;

/**
 * Encode the car section once per snapshot; each recipient gets its own header
 * (ack/buffered differ per client) via writeSnapshotHeader.
 */
export function encodeSnapshot(tick: number, cars: SnapshotCar[]): Uint8Array {
  const buf = new Uint8Array(SNAP_HEADER + cars.length * SNAP_CAR);
  const view = new DataView(buf.buffer);
  view.setUint8(0, MSG_SNAPSHOT);
  view.setUint32(1, tick);
  view.setUint8(10, cars.length);
  let o = SNAP_HEADER;
  for (const c of cars) {
    const s = c.state;
    view.setUint8(o, c.id);
    o += 1;
    for (const n of [s.p[0], s.p[1], s.p[2], s.q[1], s.q[3], s.v[0], s.v[1], s.v[2], s.w[1], s.steer, s.upset]) {
      view.setFloat64(o, n);
      o += 8;
    }
    writeInput(view, o, c.input);
    o += INPUT_BYTES;
  }
  return buf;
}

/** Stamp the per-recipient fields into a copy of an encoded snapshot. */
export function withSnapshotHeader(encoded: Uint8Array, ack: number, lead: number): Uint8Array {
  const buf = encoded.slice();
  const view = new DataView(buf.buffer);
  view.setUint32(5, ack);
  view.setInt8(9, Math.max(-128, Math.min(127, Math.round(lead))));
  return buf;
}

export function decodeSnapshot(buf: Uint8Array): Snapshot | null {
  if (buf.byteLength < SNAP_HEADER || buf[0] !== MSG_SNAPSHOT) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = view.getUint8(10);
  if (buf.byteLength !== SNAP_HEADER + count * SNAP_CAR) return null;
  const cars: SnapshotCar[] = [];
  let o = SNAP_HEADER;
  for (let i = 0; i < count; i++) {
    const id = view.getUint8(o);
    o += 1;
    const f: number[] = [];
    for (let k = 0; k < SNAP_FLOATS; k++) {
      f.push(view.getFloat64(o));
      o += 8;
    }
    cars.push({
      id,
      state: {
        p: [f[0], f[1], f[2]],
        q: [0, f[3], 0, f[4]],
        v: [f[5], f[6], f[7]],
        w: [0, f[8], 0],
        steer: f[9],
        upset: f[10],
      },
      input: readInput(view, o),
    });
    o += INPUT_BYTES;
  }
  return {
    tick: view.getUint32(1),
    ack: view.getUint32(5),
    lead: view.getInt8(9),
    cars,
  };
}

// --------------------------------------------------------- control (JSON)

export interface PlayerInfo {
  id: number;
  name: string;
  bot: boolean;
}

export interface RaceMessage {
  type: 'race';
  race: RaceState;
  /** Player id who can start races, or null. */
  hostId: number | null;
  /** Server tick when this was sent (for estimating lap clocks). */
  tick: number;
}

export type ServerMessage =
  | {
      type: 'welcome';
      id: number;
      room: string;
      /** Private rooms are only reachable by code; public ones also by quick play. */
      isPublic: boolean;
      tuning: CarTuning;
      players: PlayerInfo[];
      /** Joined mid-race: watching until the next lobby. */
      spectator: boolean;
      race: RaceState;
      hostId: number | null;
      tick: number;
      trackId: string;
    }
  /** The host picked another track: rebuild the world. Sent before the next snapshot. */
  | { type: 'track'; trackId: string }
  | { type: 'joined'; player: PlayerInfo }
  | { type: 'left'; id: number }
  | { type: 'pong'; t: number }
  | { type: 'tuning'; tuning: CarTuning }
  | RaceMessage
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'ping'; t: number }
  | { type: 'tuning'; tuning: Partial<CarTuning> }
  /** Host only: put everyone on the grid and start a race. */
  | { type: 'start'; laps: number }
  /** Host only, between races: switch track. */
  | { type: 'track'; trackId: string };
