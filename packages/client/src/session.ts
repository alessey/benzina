import {
  Predictor,
  SimWorld,
  type CarInput,
  type CarTuning,
  type Correction,
  type PlayerInfo,
  type Snapshot,
  type Track,
} from '@benzina/shared';
import type { Connection } from './net/connection';

/** A game in progress, either purely local or connected to a server. */
export interface Session {
  readonly sim: SimWorld;
  /** Our car's id, or null if we have no car (yet). */
  readonly localId: string | null;
  /** Local tick counter (live ticks only). */
  readonly tick: number;
  /** Client clock rate multiplier (1 offline; nudged online to stay in sync with the server). */
  readonly timeScale: number;
  readonly players: ReadonlyMap<string, PlayerInfo>;
  /** Apply any network updates. Returns render corrections if the world was re-simulated. */
  poll(): Correction[] | null;
  /** Run one live tick with the local player's controls. */
  step(input: CarInput): void;
}

export class OfflineSession implements Session {
  readonly sim: SimWorld;
  readonly localId = '1';
  readonly timeScale = 1;
  readonly players = new Map<string, PlayerInfo>([['1', { id: 1, name: 'You', bot: false }]]);

  constructor(track: Track, tuning?: CarTuning) {
    this.sim = new SimWorld(track, tuning);
    this.sim.addCar(this.localId, 0);
  }

  get tick(): number {
    return this.sim.tick;
  }

  poll(): null {
    return null;
  }

  step(input: CarInput): void {
    this.sim.step(new Map([[this.localId, input]]));
  }
}

export class OnlineSession implements Session {
  readonly sim: SimWorld;
  readonly predictor: Predictor;
  readonly players = new Map<string, PlayerInfo>();
  /** Most recent raw server snapshot (for debug ghosts). */
  lastSnapshot: Snapshot | null = null;
  /** Set by the owner to react to server-side tuning changes. */
  onTuning: () => void = () => {};
  onPlayersChanged: () => void = () => {};
  onDisconnect: () => void = () => {};
  connected = true;

  constructor(
    track: Track,
    readonly conn: Connection,
    readonly room: string,
    readonly myId: number,
    tuning: CarTuning,
    players: PlayerInfo[],
  ) {
    this.sim = new SimWorld(track, { ...tuning });
    this.predictor = new Predictor(this.sim, String(myId));
    for (const p of players) this.players.set(String(p.id), p);

    conn.onMessage = (msg) => {
      switch (msg.type) {
        case 'joined':
          this.players.set(String(msg.player.id), msg.player);
          this.onPlayersChanged();
          break;
        case 'left':
          this.players.delete(String(msg.id));
          this.onPlayersChanged();
          break;
        case 'tuning':
          Object.assign(this.sim.tuning, msg.tuning);
          this.onTuning();
          break;
      }
    };
    conn.onClose = () => {
      this.connected = false;
      this.onDisconnect();
    };
  }

  /** Our car exists in the local world only once the first snapshot has arrived. */
  get localId(): string | null {
    const id = String(this.myId);
    return this.sim.cars.has(id) ? id : null;
  }

  get tick(): number {
    return this.predictor.tick;
  }

  get timeScale(): number {
    return this.predictor.timeScale;
  }

  poll(): Correction[] | null {
    const snap = this.conn.takeSnapshot();
    if (!snap) return null;
    this.lastSnapshot = snap;
    return this.predictor.reconcile(snap);
  }

  step(input: CarInput): void {
    if (!this.localId || !this.connected) return;
    const { seq, input: sent } = this.predictor.step(input);
    this.conn.sendInput(seq, sent);
  }

  sendTuning(tuning: CarTuning): void {
    this.conn.sendMessage({ type: 'tuning', tuning });
  }
}
