import {
  type CarChoice,
  decodeSnapshot,
  encodeInput,
  type CarInput,
  type ClientMessage,
  type ServerMessage,
  type Snapshot,
} from '@benzina/shared';
import { NetSim } from './netSim';

export interface NetConditions {
  /** Added round-trip latency, ms. */
  lagMs: number;
  jitterMs: number;
  lossPct: number;
}

export interface ConnectOptions {
  /** quick: any open public lobby · create: new private room · join: by code. */
  mode: 'quick' | 'create' | 'join';
  room: string | null;
  name: string;
  bots: number;
  car: CarChoice;
  conditions: NetConditions;
}

const CONNECT_TIMEOUT_MS = 4000;
const PING_INTERVAL_MS = 1000;

/** Rolling per-second counters for the debug overlay. */
export class NetStats {
  rttMs = 0;
  snapshotsPerSec = 0;
  bytesInPerSec = 0;
  bytesOutPerSec = 0;
  private snaps = 0;
  private bytesIn = 0;
  private bytesOut = 0;
  private windowStart = performance.now();

  countIn(bytes: number, isSnapshot: boolean): void {
    this.bytesIn += bytes;
    if (isSnapshot) this.snaps++;
    this.roll();
  }

  countOut(bytes: number): void {
    this.bytesOut += bytes;
    this.roll();
  }

  private roll(): void {
    const now = performance.now();
    const elapsed = (now - this.windowStart) / 1000;
    if (elapsed < 1) return;
    this.snapshotsPerSec = this.snaps / elapsed;
    this.bytesInPerSec = this.bytesIn / elapsed;
    this.bytesOutPerSec = this.bytesOut / elapsed;
    this.snaps = this.bytesIn = this.bytesOut = 0;
    this.windowStart = now;
  }
}

/**
 * WebSocket link to the game server. Keeps only the newest snapshot (older ones are
 * useless once a newer one arrives) and hands control messages to a listener.
 */
export class Connection {
  readonly stats = new NetStats();
  onMessage: (msg: ServerMessage) => void = () => {};
  onClose: () => void = () => {};
  private latest: Snapshot | null = null;
  private readonly up: NetSim;
  private readonly down: NetSim;
  private pingTimer: number | undefined;

  private constructor(
    private readonly ws: WebSocket,
    conditions: NetConditions,
  ) {
    this.up = new NetSim(conditions.lagMs / 2, conditions.jitterMs / 2, conditions.lossPct);
    this.down = new NetSim(conditions.lagMs / 2, conditions.jitterMs / 2, conditions.lossPct);
  }

  /** Connect and wait for the server's welcome. */
  static open(opts: ConnectOptions): Promise<{ conn: Connection; welcome: Extract<ServerMessage, { type: 'welcome' }> }> {
    const params = new URLSearchParams({
      name: opts.name,
      mode: opts.mode,
      car: opts.car.cls,
      color: opts.car.color.toString(16).padStart(6, '0'),
    });
    if (opts.room) params.set('room', opts.room);
    if (opts.bots) params.set('bots', String(opts.bots));
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?${params}`);
    ws.binaryType = 'arraybuffer';
    const conn = new Connection(ws, opts.conditions);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('connection timed out'));
      }, CONNECT_TIMEOUT_MS);
      let welcomed = false;

      ws.onmessage = (ev) => {
        conn.down.deliver(() => {
          if (typeof ev.data === 'string') {
            conn.stats.countIn(ev.data.length, false);
            const msg = JSON.parse(ev.data) as ServerMessage;
            if (msg.type === 'welcome' && !welcomed) {
              welcomed = true;
              clearTimeout(timer);
              conn.startPings();
              resolve({ conn, welcome: msg });
            } else if (msg.type === 'error' && !welcomed) {
              clearTimeout(timer);
              reject(new Error(msg.message));
            } else if (msg.type === 'pong') {
              conn.stats.rttMs = performance.now() - msg.t;
            } else {
              conn.onMessage(msg);
            }
          } else {
            const buf = new Uint8Array(ev.data as ArrayBuffer);
            conn.stats.countIn(buf.byteLength, true);
            const snap = decodeSnapshot(buf);
            if (snap) conn.latest = snap;
          }
        });
      };
      ws.onerror = () => {
        if (!welcomed) {
          clearTimeout(timer);
          reject(new Error('could not reach server'));
        }
      };
      ws.onclose = () => {
        clearInterval(conn.pingTimer);
        if (welcomed) conn.down.deliver(() => conn.onClose());
      };
    });
  }

  /** Newest snapshot since the last call, or null. */
  takeSnapshot(): Snapshot | null {
    const s = this.latest;
    this.latest = null;
    return s;
  }

  sendInput(seq: number, input: CarInput): void {
    const data = encodeInput(seq, input);
    this.stats.countOut(data.byteLength);
    this.up.deliver(() => this.ws.readyState === WebSocket.OPEN && this.ws.send(data));
  }

  sendMessage(msg: ClientMessage): void {
    const text = JSON.stringify(msg);
    this.stats.countOut(text.length);
    this.up.deliver(() => this.ws.readyState === WebSocket.OPEN && this.ws.send(text));
  }

  close(): void {
    this.ws.close();
  }

  private startPings(): void {
    this.pingTimer = window.setInterval(() => this.sendMessage({ type: 'ping', t: performance.now() }), PING_INTERVAL_MS);
  }
}
