/**
 * In-process multiplayer harness: a real Room and N client Predictors exchanging encoded
 * messages over fake links with latency (in ticks) and optional TCP-style stalls.
 * Clients run their time-dilated clocks; each drives with a caller-supplied policy.
 */
import {
  buildTrack,
  decodeSnapshot,
  DEFAULT_TRACK,
  encodeInput,
  Predictor,
  SimWorld,
  type Car,
  type CarInput,
  type ClientMessage,
  type ServerMessage,
} from '@benzina/shared';
import { Room } from '../src/room';

export const track = buildTrack(DEFAULT_TRACK);

interface Packet {
  at: number;
  data: Uint8Array | string;
}

export function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LinkOptions {
  /** One-way latency in ticks. */
  latency: number;
  stallChance?: number;
  stallTicks?: number;
}

function link(opts: LinkOptions, rand: () => number) {
  let last = 0;
  return (now: number) => {
    let at = now + opts.latency;
    if (rand() < (opts.stallChance ?? 0)) at += opts.stallTicks ?? 0;
    last = Math.max(last, at);
    return last;
  };
}

export interface CorrectionSample {
  tick: number;
  /** Which client observed it. */
  client: number;
  /** Id of the corrected car, and whether it's the observing client's own car. */
  carId: string;
  local: boolean;
  /** Position correction, metres. */
  error: number;
  /** Distance from the corrected car to the nearest other car (server truth), metres. */
  nearestCar: number;
  /** Ticks the observing client predicted ahead of the snapshot (pending inputs replayed). */
  horizon: number;
  /** Ticks since this client's previous snapshot. */
  snapGap: number;
}

export type Policy = (car: Car, tick: number, sim: SimWorld) => CarInput;

export interface Scenario {
  ticks: number;
  link: LinkOptions;
  policies: Policy[];
  bots?: number;
  seed?: number;
  /** Clients only run every N ticks (N=2 → 30 fps, 3 → 20 fps), ticking in bursts like a slow device. */
  frameEvery?: number;
  /** Called every tick before clients run; lets a test send control messages (e.g. start a race). */
  script?: (now: number, ctl: ScriptControl) => void;
  /** Stop early when this returns true. */
  until?: (room: Room) => boolean;
}

export interface ScriptControl {
  room: Room;
  /** Client `index`'s own car in its predicted world (what that player sees), if it has one. */
  predictedCar(index: number): Car | undefined;
  /** Send a JSON control message from client `index` (goes through its uplink). */
  send(index: number, msg: ClientMessage): void;
}

export function runScenario(sc: Scenario) {
  const room = new Room('TEST', track, { bots: sc.bots ?? 0 });
  const rand = mulberry32(sc.seed ?? 99);
  let now = 0;
  const samples: CorrectionSample[] = [];

  const clients = sc.policies.map((policy, index) => {
    const down = link(sc.link, rand);
    const up = link(sc.link, rand);
    const inbox: Packet[] = [];
    const outbox: Packet[] = [];
    const id = room.join({ send: (data) => inbox.push({ at: down(now), data }) }, `client${index}`);
    if (id === null) throw new Error('join failed');
    const predictor = new Predictor(new SimWorld(track), String(id));
    return { index, id, policy, inbox, outbox, up, predictor, clock: 0, lastSnapAt: 0 };
  });

  const nearestOtherCar = (carId: string) => {
    const me = room.sim.cars.get(carId)?.body.translation();
    if (!me) return Infinity;
    let best = Infinity;
    for (const [id, car] of room.sim.cars) {
      if (id === carId) continue;
      const p = car.body.translation();
      best = Math.min(best, Math.hypot(p.x - me.x, p.z - me.z));
    }
    return best;
  };

  const deliver = (id: number, data: Uint8Array | string) =>
    typeof data === 'string' ? room.handleText(id, data) : room.handleBinary(id, data);
  const frameEvery = sc.frameEvery ?? 1;
  const ctl: ScriptControl = {
    room,
    predictedCar: (index) => clients[index].predictor.sim.cars.get(String(clients[index].id)),
    send: (index, msg) => {
      const c = clients[index];
      c.outbox.push({ at: c.up(now), data: JSON.stringify(msg) });
    },
  };
  for (now = 0; now < sc.ticks; now++) {
    if (sc.until?.(room)) break;
    sc.script?.(now, ctl);
    for (const c of clients) {
      // Messages are still delivered to the socket between frames; the client handles them per frame.
      const frame = (now + c.index) % frameEvery === 0;
      if (!frame) {
        while (c.outbox.length && c.outbox[0].at <= now) deliver(c.id, c.outbox.shift()!.data);
        continue;
      }
      while (c.inbox.length && c.inbox[0].at <= now) {
        const { data } = c.inbox.shift()!;
        if (typeof data === 'string') {
          const msg = JSON.parse(data) as ServerMessage;
          if (msg.type === 'welcome') Object.assign(c.predictor.sim.tuning, msg.tuning);
          if (msg.type === 'race' || msg.type === 'welcome') {
            c.predictor.setFreeze(msg.race.phase === 'countdown' ? msg.race.startTick : null);
          }
          continue;
        }
        const snap = decodeSnapshot(data)!;
        const snapGap = now - c.lastSnapAt;
        c.lastSnapAt = now;
        const corrections = c.predictor.reconcile(snap);
        const horizon = c.predictor.pendingCount;
        for (const corr of corrections) {
          const b = corr.before.p;
          const a = corr.after.p;
          samples.push({
            tick: now,
            client: c.index,
            carId: corr.id,
            local: corr.id === String(c.id),
            error: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
            nearestCar: nearestOtherCar(corr.id),
            horizon,
            snapGap,
          });
        }
      }
      c.clock += c.predictor.timeScale * frameEvery;
      while (c.clock >= 1) {
        c.clock -= 1;
        const car = c.predictor.sim.cars.get(String(c.id));
        if (!car) {
          c.predictor.stepWithoutCar();
          continue;
        }
        const { seq, input } = c.predictor.step(c.policy(car, c.predictor.tick, c.predictor.sim));
        c.outbox.push({ at: c.up(now), data: encodeInput(seq, input) });
      }
      while (c.outbox.length && c.outbox[0].at <= now) deliver(c.id, c.outbox.shift()!.data);
    }
    room.tick();
  }

  const result = { samples, room, clients };
  return {
    ...result,
    dispose() {
      room.dispose();
      for (const c of clients) c.predictor.sim.free();
    },
  };
}

export function stats(values: number[]) {
  if (!values.length) return { n: 0, mean: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    mean: values.reduce((s, v) => s + v, 0) / values.length,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted[sorted.length - 1],
  };
}
