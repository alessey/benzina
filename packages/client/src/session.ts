import {
  BOT_PROFILES,
  CAR_CLASSES,
  botInput,
  freeColor,
  buildTrack,
  catchUpProfile,
  DEFAULT_BOT_SETTINGS,
  pickBotName,
  type BotSettings,
  type CarChoice,
  DT,
  trackById,
  NEUTRAL_INPUT,
  Predictor,
  Race,
  SimWorld,
  type CarInput,
  type CarTuning,
  type Correction,
  type PlayerInfo,
  type RaceState,
  type ServerMessage,
  type Snapshot,
  type Track,
  type Weather,
  weatherTuning,
} from '@benzina/shared';
import type { Connection } from './net/connection';

const trackCache = new Map<string, Track>();
/** Tracks are built once per page (building samples the spline and walls). */
export function getTrack(id: string | undefined): Track {
  const def = trackById(id);
  if (!trackCache.has(def.id)) trackCache.set(def.id, buildTrack(def));
  return trackCache.get(def.id)!;
}

/** A game in progress, either purely local or connected to a server. */
export interface Session {
  readonly sim: SimWorld;
  readonly track: Track;
  /** Our car's id, or null if we have no car (yet, or spectating). */
  readonly localId: string | null;
  /** Local tick counter (live ticks only). */
  readonly tick: number;
  /** Client clock rate multiplier (1 offline; nudged online to stay in sync with the server). */
  readonly timeScale: number;
  readonly players: ReadonlyMap<string, PlayerInfo>;
  readonly race: RaceState;
  /** Can we start races? */
  readonly isHost: boolean;
  /** Best estimate of the current authoritative tick (for race clocks). */
  serverTickNow(): number;
  /** Apply any network updates. Returns render corrections if the world was re-simulated. */
  poll(): Correction[] | null;
  /** Run one live tick with the local player's controls. */
  step(input: CarInput): void;
  /** Real time the frame loop declined to simulate (frame longer than the catch-up cap), seconds. */
  noteDroppedTime(seconds: number): void;
  startRace(laps: number): void;
  /** Host only, between races. */
  selectTrack(id: string): void;
  /** How bots drive (host sets it). */
  readonly botSettings: BotSettings;
  setBotSettings(settings: BotSettings): void;
  /** Race conditions (host sets it, between races). */
  readonly weather: Weather;
  setWeather(weather: Weather): void;
  /** Our car; changes apply between races. */
  readonly myCar: CarChoice;
  setCar(car: CarChoice): void;
  /** Called when race state, players or host change. */
  onChange: () => void;
  /** Called after the world was rebuilt on another track (sim and track are new objects). */
  onTrackChange: () => void;
}

/** Single player against local bots. Runs the same race rules the server does. */
export class OfflineSession implements Session {
  sim: SimWorld;
  track: Track;
  readonly localId = '1';
  readonly timeScale = 1;
  readonly isHost = true;
  readonly players = new Map<string, PlayerInfo>();
  onChange: () => void = () => {};
  onTrackChange: () => void = () => {};
  private raceLogic: Race;
  private readonly botIds: string[] = [];
  botSettings: BotSettings = { ...DEFAULT_BOT_SETTINGS };

  constructor(track: Track, bots: number, car: CarChoice, tuning?: CarTuning, weather: Weather = 'clear') {
    this.track = track;
    this.players.set(this.localId, { id: 1, name: 'You', bot: false, car });
    for (let i = 0; i < Math.min(7, bots); i++) {
      const id = String(100 + i);
      this.botIds.push(id);
      const taken = [...this.players.values()].map((p) => p.name);
      const pick = Math.floor(Math.random() * 1000);
      this.players.set(id, {
        id: 100 + i,
        name: pickBotName(taken, pick),
        bot: true,
        car: {
          cls: CAR_CLASSES[(pick + i) % CAR_CLASSES.length],
          color: freeColor([...this.players.values()].map((p) => p.car.color), pick + i * 3),
        },
      });
    }
    [this.sim, this.raceLogic] = this.buildWorld(track, tuning, weather);
  }

  get myCar(): CarChoice {
    return this.players.get(this.localId)!.car;
  }

  setCar(car: CarChoice): void {
    if (this.raceLogic.phase !== 'lobby' && this.raceLogic.phase !== 'results') return;
    this.players.set(this.localId, { ...this.players.get(this.localId)!, car });
    this.sim.cars.get(this.localId)?.setClass(car.cls);
    this.onChange();
  }

  setBotSettings(settings: BotSettings): void {
    this.botSettings = settings;
    this.onChange();
  }

  get weather(): Weather {
    return this.sim.weather;
  }

  setWeather(weather: Weather): void {
    if (this.raceLogic.phase !== 'lobby' && this.raceLogic.phase !== 'results') return;
    this.sim.weather = weather;
    this.onChange();
  }

  private buildWorld(track: Track, tuning?: CarTuning, weather: Weather = 'clear'): [SimWorld, Race] {
    const sim = new SimWorld(track, tuning);
    sim.weather = weather;
    for (const [id, p] of this.players) sim.addCar(id, id === this.localId ? 0 : this.botIds.indexOf(id) + 1, p.car.cls);
    return [sim, new Race(track)];
  }

  selectTrack(id: string): void {
    if (this.raceLogic.phase !== 'lobby' && this.raceLogic.phase !== 'results') return;
    const track = getTrack(id);
    if (track === this.track) return;
    const old = this.sim;
    this.track = track;
    [this.sim, this.raceLogic] = this.buildWorld(track, { ...old.tuning }, old.weather);
    old.free();
    this.onTrackChange();
    this.onChange();
  }

  get tick(): number {
    return this.sim.tick;
  }

  get race(): RaceState {
    return this.raceLogic.state();
  }

  serverTickNow(): number {
    return this.sim.tick;
  }

  poll(): null {
    return null;
  }

  step(input: CarInput): void {
    const frozen = this.raceLogic.isFrozen(this.sim.tick);
    const inputs = new Map<string, CarInput>([[this.localId, frozen ? NEUTRAL_INPUT : input]]);
    const profile = BOT_PROFILES[this.botSettings.difficulty];
    const me = this.raceLogic.progressOf(this.localId);
    for (const id of this.botIds) {
      const car = this.sim.cars.get(id)!;
      const mine = this.raceLogic.progressOf(id);
      const driving = this.botSettings.catchUp && me !== null && mine !== null ? catchUpProfile(profile, mine - me) : profile;
      inputs.set(id, frozen ? NEUTRAL_INPUT : botInput(car, this.track, driving, weatherTuning(this.sim.tuning, this.sim.weather), this.sim.tick * DT, this.sim.weather));
    }
    this.sim.step(inputs);
    if (this.raceLogic.update(this.sim, this.sim.tick)) this.onChange();
  }

  noteDroppedTime(): void {}

  startRace(laps: number): void {
    if (this.raceLogic.phase !== 'lobby' && this.raceLogic.phase !== 'results') return;
    this.raceLogic.start(this.sim, [this.localId, ...this.botIds], this.sim.tick, laps);
    this.onChange();
  }
}

export class OnlineSession implements Session {
  sim: SimWorld;
  track: Track;
  readonly predictor: Predictor;
  readonly players = new Map<string, PlayerInfo>();
  /** Most recent raw server snapshot (for debug ghosts). */
  lastSnapshot: Snapshot | null = null;
  race: RaceState;
  hostId: number | null;
  botSettings: BotSettings;
  onChange: () => void = () => {};
  onTrackChange: () => void = () => {};
  /** Set by the owner to react to server-side tuning changes. */
  onTuning: () => void = () => {};
  onDisconnect: () => void = () => {};
  connected = true;
  /** Server tick from the last race message, and our local tick when it arrived. */
  private tickRef = { server: 0, local: 0 };

  constructor(
    readonly conn: Connection,
    welcome: Extract<ServerMessage, { type: 'welcome' }>,
  ) {
    this.track = getTrack(welcome.trackId);
    this.sim = new SimWorld(this.track, { ...welcome.tuning });
    this.sim.weather = welcome.weather ?? 'clear';
    this.predictor = new Predictor(this.sim, String(welcome.id));
    this.myId = welcome.id;
    this.room = welcome.room;
    this.isPublic = welcome.isPublic;
    for (const p of welcome.players) this.players.set(String(p.id), p);
    this.race = welcome.race;
    this.hostId = welcome.hostId;
    this.botSettings = welcome.bots;
    this.applyRace(welcome.race, welcome.tick);

    conn.onMessage = (msg) => {
      switch (msg.type) {
        case 'joined':
        case 'player':
          this.players.set(String(msg.player.id), msg.player);
          this.onChange();
          break;
        case 'bots':
          this.botSettings = msg.bots;
          this.onChange();
          break;
        case 'weather':
          this.sim.weather = msg.weather;
          this.onChange();
          break;
        case 'left':
          this.players.delete(String(msg.id));
          this.onChange();
          break;
        case 'tuning':
          Object.assign(this.sim.tuning, msg.tuning);
          this.onTuning();
          break;
        case 'track': {
          // The server rebuilt its world; ours follows. Our input stream carries on unchanged.
          const old = this.sim;
          this.track = getTrack(msg.trackId);
          this.sim = new SimWorld(this.track, { ...old.tuning });
          this.sim.weather = old.weather;
          this.predictor.replaceWorld(this.sim);
          old.free();
          this.onTrackChange();
          break;
        }
        case 'race':
          this.hostId = msg.hostId;
          this.applyRace(msg.race, msg.tick);
          this.onChange();
          break;
      }
    };
    conn.onClose = () => {
      this.connected = false;
      this.onDisconnect();
    };
  }

  readonly myId: number;
  readonly room: string;
  readonly isPublic: boolean;

  private applyRace(race: RaceState, serverTick: number): void {
    this.race = race;
    this.tickRef = { server: serverTick, local: this.predictor.tick };
    // Predict the countdown freeze exactly (see Predictor.setFreeze).
    this.predictor.setFreeze(race.phase === 'countdown' ? race.startTick : null);
  }

  /** Our car exists in the local world only once a snapshot includes it. */
  get localId(): string | null {
    const id = String(this.myId);
    return this.sim.cars.has(id) ? id : null;
  }

  get isHost(): boolean {
    return this.hostId === this.myId;
  }

  get tick(): number {
    return this.predictor.tick;
  }

  get timeScale(): number {
    return this.predictor.timeScale;
  }

  serverTickNow(): number {
    // With a car: the tick our predicted present corresponds to, so GO and lap clocks match
    // our car. Spectating: extrapolate from the last race message with our own ticks.
    const present = this.localId ? this.predictor.presentServerTick() : null;
    if (present !== null) return present;
    const fromSnapshot = this.lastSnapshot?.tick ?? 0;
    return Math.max(fromSnapshot, this.tickRef.server + (this.predictor.tick - this.tickRef.local));
  }

  poll(): Correction[] | null {
    const snap = this.conn.takeSnapshot();
    if (!snap) return null;
    this.lastSnapshot = snap;
    return this.predictor.reconcile(snap);
  }

  step(input: CarInput): void {
    if (!this.connected) return;
    if (!this.localId) {
      // Spectating (or our car hasn't arrived yet): keep the other cars moving smoothly.
      this.predictor.stepWithoutCar();
      return;
    }
    const { seq, input: sent } = this.predictor.step(input);
    this.conn.sendInput(seq, sent);
  }

  noteDroppedTime(seconds: number): void {
    this.predictor.noteDroppedTime(seconds);
  }

  startRace(laps: number): void {
    this.conn.sendMessage({ type: 'start', laps });
  }

  selectTrack(id: string): void {
    this.conn.sendMessage({ type: 'track', trackId: id });
  }

  get myCar(): CarChoice {
    return this.players.get(String(this.myId))!.car;
  }

  setCar(car: CarChoice): void {
    this.conn.sendMessage({ type: 'car', car });
  }

  setBotSettings(settings: BotSettings): void {
    this.conn.sendMessage({ type: 'bots', bots: settings });
  }

  get weather(): Weather {
    return this.sim.weather;
  }

  setWeather(weather: Weather): void {
    this.conn.sendMessage({ type: 'weather', weather });
  }

  sendTuning(tuning: CarTuning): void {
    this.conn.sendMessage({ type: 'tuning', tuning });
  }
}

/** Seconds since tick `from`, given the current tick. */
export function secondsSince(from: number, now: number): number {
  return Math.max(0, (now - from) * DT);
}
