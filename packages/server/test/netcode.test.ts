import { beforeAll, describe, expect, it } from 'vitest';
import {
  botInput,
  buildTrack,
  decodeSnapshot,
  DEFAULT_TRACK,
  encodeInput,
  initPhysics,
  Predictor,
  SimWorld,
  type ServerMessage,
} from '@benzina/shared';
import { Room } from '../src/room';

const track = buildTrack(DEFAULT_TRACK);

beforeAll(async () => {
  await initPhysics();
});

interface Packet {
  at: number;
  data: Uint8Array | string;
}

/**
 * Drives a real Room and a client Predictor through a fake network with a fixed one-way
 * latency (in ticks). Client and server tick in lockstep. The client drives with the autopilot.
 */
interface SimOptions {
  ticks: number;
  /** One-way latency in ticks. */
  latency: number;
  bots: number;
  /** Chance per packet of a TCP-style stall (holds back everything behind it). */
  stallChance?: number;
  /** Stall length in ticks. */
  stallTicks?: number;
  /** Freeze the client (backgrounded tab: no ticks, no message processing) for this window. */
  pause?: { at: number; ticks: number };
}

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-order delivery with occasional stalls, like TCP over a lossy link. */
function link(opts: SimOptions, rand: () => number) {
  let last = 0;
  return (now: number) => {
    let at = now + opts.latency;
    if (rand() < (opts.stallChance ?? 0)) at += opts.stallTicks ?? 0;
    last = Math.max(last, at);
    return last;
  };
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function simulate(opts: SimOptions) {
  const room = new Room('TEST', track, { bots: opts.bots });
  const toClient: Packet[] = [];
  const toServer: Packet[] = [];
  const rand = mulberry32(1234);
  const downLink = link(opts, rand);
  const upLink = link(opts, rand);
  let now = 0;
  let clientClock = 0;

  const id = room.join({ send: (data) => toClient.push({ at: downLink(now), data }) }, 'tester');
  if (id === null) throw new Error('join failed');
  const localId = String(id);
  const predictor = new Predictor(new SimWorld(track), localId);

  const localErrors: number[] = [];
  const remoteErrors: number[] = [];

  for (now = 0; now < opts.ticks; now++) {
    const paused = opts.pause && now >= opts.pause.at && now < opts.pause.at + opts.pause.ticks;
    if (paused) {
      deliverToServer();
      room.tick();
      continue;
    }

    // Client receives.
    while (toClient.length && toClient[0].at <= now) {
      const { data } = toClient.shift()!;
      if (typeof data === 'string') {
        const msg = JSON.parse(data) as ServerMessage;
        if (msg.type === 'welcome') Object.assign(predictor.sim.tuning, msg.tuning);
        continue;
      }
      const snap = decodeSnapshot(data);
      if (!snap) throw new Error('bad snapshot');
      for (const c of predictor.reconcile(snap)) {
        const d = Math.hypot(
          c.before.p[0] - c.after.p[0],
          c.before.p[1] - c.after.p[1],
          c.before.p[2] - c.after.p[2],
        );
        if (now > 180) (c.id === localId ? localErrors : remoteErrors).push(d);
      }
    }

    // Client ticks once it knows about its own car, at its time-dilated rate.
    clientClock += predictor.timeScale;
    while (clientClock >= 1) {
      clientClock -= 1;
      const car = predictor.sim.cars.get(localId);
      if (!car) continue;
      const { seq, input } = predictor.step(botInput(car, track));
      toServer.push({ at: upLink(now), data: encodeInput(seq, input) });
    }

    deliverToServer();
    room.tick();
  }

  function deliverToServer() {
    while (toServer.length && toServer[0].at <= now) {
      room.handleBinary(id!, toServer.shift()!.data as Uint8Array);
    }
  }

  const serverCar = room.sim.cars.get(localId)!;
  const player = (room as unknown as { players: Map<number, { guessStreak: number; missedInputs: number }> }).players.get(id)!;
  const stats = {
    guessStreak: player.guessStreak,
    maxLocal: Math.max(0, ...localErrors),
    p95Local: percentile(localErrors, 0.95),
    meanLocal: localErrors.reduce((a, b) => a + b, 0) / Math.max(1, localErrors.length),
    maxRemote: Math.max(0, ...remoteErrors),
    meanRemote: remoteErrors.reduce((a, b) => a + b, 0) / Math.max(1, remoteErrors.length),
    pending: predictor.pendingCount,
    serverSpeed: serverCar.forwardSpeed(),
  };
  room.dispose();
  predictor.sim.free();
  return stats;
}

describe('netcode (in-process)', () => {
  it('client prediction of its own car matches the server closely', () => {
    // 6 ticks each way ≈ 200 ms round trip.
    const s = simulate({ ticks: 60 * 20, latency: 6, bots: 0 });
    expect(s.serverSpeed).toBeGreaterThan(10);
    expect(s.pending).toBeLessThan(20);
    // With no other cars, re-simulation should reproduce the server essentially exactly.
    expect(s.maxLocal).toBeLessThan(0.001);
  });

  it('survives TCP-style stalls without large or persistent corrections', () => {
    // ~200 ms round trip, and 2% of packets stall for 250 ms.
    const s = simulate({ ticks: 60 * 30, latency: 6, bots: 0, stallChance: 0.02, stallTicks: 15 });
    expect(s.serverSpeed).toBeGreaterThan(10);
    expect(s.pending).toBeLessThan(40);
    // Most snapshots need no visible correction; stalls cost only guessed-input error.
    expect(s.p95Local).toBeLessThan(0.05);
    // Worst case is a stall while scraping a wall: a guessed input changes the contact outcome.
    expect(s.maxLocal).toBeLessThan(1);
  });

  it('recovers after the client is frozen for 5 s (backgrounded tab)', () => {
    const s = simulate({ ticks: 60 * 15, latency: 6, bots: 0, pause: { at: 60 * 5, ticks: 60 * 5 } });
    // Back in sync: the server is using real inputs again and the car is driving.
    expect(s.guessStreak).toBe(0);
    expect(s.pending).toBeLessThan(40);
    expect(s.serverSpeed).toBeGreaterThan(15);
  });

  it('stays stable with bots sharing the track', () => {
    const s = simulate({ ticks: 60 * 20, latency: 6, bots: 3 });
    expect(s.serverSpeed).toBeGreaterThan(5);
    // Car-to-car contacts aren't perfectly reproducible; corrections should still be small on average.
    expect(s.meanLocal).toBeLessThan(0.05);
    expect(Number.isFinite(s.maxRemote)).toBe(true);
  });
});
