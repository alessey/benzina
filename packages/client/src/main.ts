import * as THREE from 'three';
import { botInput, COUNTDOWN_TICKS, DEFAULT_TRACK, DT, initPhysics, nearestSampleIndex, parseWeather, weatherTuning, type CarInput } from '@benzina/shared';
import { createScene } from './scene';
import { CarRenderer } from './carRenderer';
import { CarView } from './carView';
import { ChaseCamera } from './chaseCamera';
import { DebugOverlay } from './debugOverlay';
import { Effects } from './effects';
import { Minimap } from './minimap';
import { enterFullscreenLandscape, fullscreenSupported, keepScreenAwake, preventBrowserGestures } from './device';
import { InputManager, IS_TOUCH_DEVICE } from './input';
import { AdaptiveResolution } from './quality';
import { AudioEngine, type CarSound } from './audio';
import { LapTimer } from './lapTimer';
import { Connection } from './net/connection';
import { RaceUi } from './raceUi';
import { Celebration, type FinishInfo } from './celebration';
import { getTrack, OfflineSession, OnlineSession, type Session } from './session';
import { showStartScreen, type StartChoice } from './startScreen';
import { saveCar, savedCar } from './carPicker';
import { createTuningPanel } from './tuningPanel';

/**
 * Cap on simulated time per frame. Offline, a long hitch acts like a pause. Online the server
 * keeps going, so dropping time would put us behind it (inputs arrive late, every car
 * jumps); catch up on up to a second of ticks instead (a tick costs ~0.05 ms). Beyond that
 * (a backgrounded tab) the predictor's skip-ahead resynchronises.
 */
const MAX_FRAME_TIME_OFFLINE = 0.25;
const MAX_FRAME_TIME_ONLINE = 1;

// URL options:
//   ?room=CODE   invite link: pre-fills the code   ?offline    single player vs bots (?bots=N)
//   ?autojoin    skip the start screen (?room, ?name, ?bots): for testing
//   ?bot         autopilot drives your car         ?debug      netcode overlay + tuning on phones
//   ?lag=MS ?jitter=MS ?loss=PCT                  simulate a bad network (round trip)
const params = new URLSearchParams(location.search);
const num = (key: string, fallback = 0) => Math.max(0, Number(params.get(key) ?? fallback) || 0);
const AUTOPILOT = params.has('bot');

const hud = {
  speed: document.getElementById('speed-value')!,
  room: document.getElementById('room')!,
  status: document.getElementById('status')!,
  loading: document.getElementById('loading')!,
};

function setStatus(text: string, timeoutMs = 0): void {
  hud.status.textContent = text;
  hud.status.hidden = text === '';
  if (timeoutMs) setTimeout(() => hud.status.textContent === text && setStatus(''), timeoutMs);
}

await initPhysics();
const world = createScene({ mobile: IS_TOUCH_DEVICE });
const { renderer, scene, camera, sun } = world;
// The menu shows the track named in the URL (?track=id), else the first one.
world.setTrack(getTrack(params.get('track') ?? DEFAULT_TRACK.id));
// Compile every shader now, instead of stalling the first frames of the race (shader
// compilation can take hundreds of ms on phones). A throwaway car includes the car materials.
{
  const warmup = new CarView();
  scene.add(warmup.group);
  camera.position.set(0, 10, -20);
  camera.lookAt(0, 0, 0);
  renderer.compile(scene, camera);
  renderer.render(scene, camera);
  scene.remove(warmup.group);
}
// Render at most 2x (phones report 3x); drop as low as 0.75x on slow phones.
const quality = new AdaptiveResolution(renderer, IS_TOUCH_DEVICE ? 0.75 : 1, Math.min(window.devicePixelRatio, 2));
preventBrowserGestures();
keepScreenAwake();
hud.loading.remove();

/** Dev-only hooks for automated testing (headless Chrome over CDP). */
const devHooks = {
  scene,
  camera,
  THREE,
  CarView,
  session: null as Session | null,
  frames: 0,
  firstFrameAt: 0,
  /** Set [x, y, z, lookX, lookY, lookZ] to take over the camera (screenshots, debugging). */
  cameraOverride: null as number[] | null,
  corrections: [] as { t: number; id: string; local: boolean; d: number; skips: number }[],
  /** Per-reconcile timeline: client tick, server tick, ack, lead, pending (after), frame ms. */
  timeline: [] as number[][],
};
if (import.meta.env.DEV) Object.assign(window, { __benzina: devHooks, __world: world, __renderer: renderer });
// (audio is attached to the dev hooks once created, below)

// ------------------------------------------------------------ menu

/** Slow fly-around of the circuit behind the start screen. */
function attractLoop(): () => void {
  let running = true;
  const track = getTrack(params.get('track') ?? DEFAULT_TRACK.id);
  const centre = track.samples.reduce((a, s) => ({ x: a.x + s.x / track.samples.length, z: a.z + s.z / track.samples.length }), { x: 0, z: 0 });
  const loop = (t: number) => {
    if (!running) return;
    const a = t / 20000;
    camera.position.set(centre.x + Math.cos(a) * 260, 110, centre.z + Math.sin(a) * 260);
    camera.lookAt(centre.x, 0, centre.z);
    world.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return () => (running = false);
}

function choiceFromUrl(): StartChoice | null {
  const name = params.get('name') ?? `Driver ${100 + Math.floor(Math.random() * 900)}`;
  const car = savedCar();
  if (params.has('offline')) return { mode: 'offline', name, car, bots: num('bots', 3) };
  if (!params.has('autojoin')) return null;
  const code = params.get('room');
  return code ? { mode: 'join', name, car, code } : { mode: 'quick', name, car };
}

async function openSession(): Promise<Session> {
  let error: string | undefined;
  for (;;) {
    const choice = (!error && choiceFromUrl()) || (await showStartScreen({ inviteCode: params.get('room'), error }));
    if (choice.mode === 'offline') {
      return new OfflineSession(getTrack(params.get('track') ?? DEFAULT_TRACK.id), choice.bots, choice.car, undefined, parseWeather(params.get('weather')));
    }
    setStatus('Connecting…');
    try {
      const { conn, welcome } = await Connection.open({
        mode: choice.mode,
        room: choice.mode === 'join' ? choice.code : null,
        name: choice.name,
        // Rooms created by a join-by-code (e.g. ?autojoin&room=X) also honour ?bots.
        bots: choice.mode === 'create' ? choice.bots : num('bots'),
        car: choice.car,
        conditions: { lagMs: num('lag'), jitterMs: num('jitter'), lossPct: num('loss') },
      });
      setStatus('');
      // Put the room code in the URL so a reload rejoins and the address bar is shareable.
      params.set('room', welcome.room);
      history.replaceState(null, '', `?${params}`);
      return new OnlineSession(conn, welcome);
    } catch (err) {
      setStatus('');
      error = `Couldn't connect: ${(err as Error).message}`;
    }
  }
}

// Created before the start screen so its first click unlocks audio.
const audio = new AudioEngine();
if (import.meta.env.DEV) Object.assign(window, { __audio: audio });

const stopAttract = attractLoop();
const session = await openSession();
stopAttract();
devHooks.session = session;
const online = session instanceof OnlineSession ? session : null;

// ------------------------------------------------------------ game

const refreshTuning = createTuningPanel(session.sim.tuning, {
  persist: !online,
  onChange: online ? (t) => online.sendTuning(t) : undefined,
  // A dev tool: always available in dev; in production only with ?debug.
  hidden: (IS_TOUCH_DEVICE || !import.meta.env.DEV) && !params.has('debug'),
});

if (IS_TOUCH_DEVICE && fullscreenSupported()) {
  const btn = document.getElementById('fullscreen')!;
  btn.hidden = false;
  btn.addEventListener('click', () => void enterFullscreenLandscape());
  document.addEventListener('fullscreenchange', () => (btn.hidden = !!document.fullscreenElement));
}

// Everything tied to the current track/world is rebuilt when the host switches track.
const makeCarRenderer = () =>
  new CarRenderer(
    scene,
    session.sim,
    session.track,
    (id) => session.players.get(id)?.name ?? `Car ${id}`,
    () => session.localId,
    (id) => session.players.get(id)?.car,
  );
let cars = makeCarRenderer();
let effects = new Effects(scene, session.sim, session.track);
world.setTrack(session.track);
const chase = new ChaseCamera(camera);
const input = new InputManager();
let practiceLaps = new LapTimer(session.track);
session.onTrackChange = () => {
  cars.dispose();
  cars = makeCarRenderer();
  effects.dispose();
  effects = new Effects(scene, session.sim, session.track);
  world.setTrack(session.track);
  practiceLaps = new LapTimer(session.track);
  devHooks.corrections.length = 0;
};
const debug = new DebugOverlay(scene, params.has('debug'));
const minimap = new Minimap(IS_TOUCH_DEVICE ? 112 : 160);

async function invite(): Promise<void> {
  if (!online) return;
  const url = `${location.origin}${location.pathname}?room=${online.room}`;
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  try {
    if (nav.share && IS_TOUCH_DEVICE) {
      await nav.share({ title: 'Benzina', text: `Race me in Benzina! Room ${online.room}`, url });
    } else {
      await navigator.clipboard.writeText(url);
      setStatus(`Invite link copied: ${url}`, 4000);
    }
  } catch {
    setStatus(`Invite link: ${url}`, 8000);
  }
}

const celebration = new Celebration();
function celebrate(info: FinishInfo): void {
  audio.fanfare(info.position);
  celebration.start(info);
}
if (import.meta.env.DEV) {
  // Try the finish celebration from the console: __celebrate(1)
  Object.assign(window, {
    __celebrate: (position = 1) => celebrate({
      position,
      racers: 6,
      finishTime: 154.321,
      gap: position > 1 ? 1.234 * position : null,
      carColor: 0x2a7fff,
    }),
  });
}
const raceUi = new RaceUi({
  start: (laps) => session.startRace(laps),
  invite: () => void invite(),
  selectTrack: (id) => session.selectTrack(id),
  setCar: (car) => {
    saveCar(car);
    session.setCar(car);
  },
  setBots: (settings) => session.setBotSettings(settings),
  setWeather: (weather) => session.setWeather(weather),
});

let lastPhase = session.race.phase;
function onSessionChange(): void {
  const phase = session.race.phase;
  // Fresh practice timer whenever a race starts or ends (cars get teleported).
  if (phase !== lastPhase) practiceLaps = new LapTimer(session.track);
  lastPhase = phase;
  if (!online) {
    hud.room.textContent = 'Offline';
    return;
  }
  hud.room.textContent = `Room ${online.room} · ${online.players.size}/8${online.isPublic ? '' : ' · private'}`;
}
session.onChange = onSessionChange;
onSessionChange();

if (online) {
  online.onTuning = refreshTuning;
  online.onDisconnect = () => setStatus('Disconnected from server. Reload to rejoin.');
}

/**
 * Where to put your car while the lobby card is up: the middle of the larger free band above
 * or below the card, as a fraction of the screen height from the centre (0 if neither fits).
 */
const racePanel = document.getElementById('race-panel');
function freeSpaceShift(): number {
  // Touch screens: no arrow keys, and the free space is where the pedals are.
  if (IS_TOUCH_DEVICE) return 0;
  const card = racePanel?.firstElementChild?.getBoundingClientRect();
  if (!card) return 0;
  const h = window.innerHeight;
  const above = card.top;
  const below = h - card.bottom;
  if (Math.max(above, below) < 110) return 0;
  const y = below >= above ? card.bottom + below / 2 : above / 2;
  // The camera looks a little above and ahead of the car, so aim slightly high.
  return Math.max(0, Math.abs(y - h / 2) / h - 0.14) * Math.sign(y - h / 2);
}

let lastThrottle = 0;
function controls(): CarInput {
  const human = input.sample();
  const car = session.localId ? session.sim.cars.get(session.localId) : undefined;
  const c = AUTOPILOT && car ? { ...botInput(car, session.track, 1, weatherTuning(session.sim.tuning, session.sim.weather), 0, session.sim.weather), reset: human.reset } : human;
  lastThrottle = Math.abs(c.throttle);
  return c;
}

const muteBtn = document.getElementById('mute')!;
const syncMute = () => (muteBtn.textContent = audio.isMuted ? '🔇' : '🔊');
syncMute();
muteBtn.addEventListener('click', () => {
  audio.toggleMute();
  syncMute();
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && !e.repeat) {
    audio.toggleMute();
    syncMute();
  }
});

/** Cars worth hearing this frame: everything in the sim, with engine/screech estimates. */
function carSounds(): CarSound[] {
  const out: CarSound[] = [];
  for (const [id, car] of session.sim.cars) {
    const p = car.body.translation();
    const v = car.body.linvel();
    const q = car.body.rotation();
    const yaw = 2 * Math.atan2(q.y, q.w);
    const lateral = Math.abs(v.x * -Math.cos(yaw) + v.z * Math.sin(yaw));
    const speed = car.forwardSpeed();
    const local = id === session.localId;
    out.push({
      id,
      local,
      speed,
      // Our own throttle is known; for others, assume they're on it unless crawling.
      throttle: local ? lastThrottle : Math.min(1, 0.35 + Math.abs(speed) / 40),
      slip: car.grounded ? Math.min(1, Math.max(0, (lateral - 2.5) / 7) + car.upset * 0.6) : 0,
      x: p.x,
      y: p.y,
      z: p.z,
    });
  }
  return out;
}

// Sound cues from race events.
let lastLights = '';
let lastLaps = -1;
let lastFinished = false;
let lastVelocity: { x: number; z: number } | null = null;
function soundCues(): void {
  const race = session.race;
  const now = session.serverTickNow();
  // Countdown beeps follow the gantry lamps.
  let lights = '';
  if (race.phase === 'countdown') lights = `r${Math.min(5, Math.floor((COUNTDOWN_TICKS - (race.startTick - now)) / (COUNTDOWN_TICKS / 5)) + 1)}`;
  else if (race.phase === 'racing' && now - race.startTick < 150) lights = 'go';
  if (lights !== lastLights) {
    if (lights.startsWith('r')) audio.beep(440, 0.16);
    else if (lights === 'go') audio.beep(880, 0.5);
    lastLights = lights;
  }
  const me = race.standings.find((s) => s.id === session.localId);
  if (me && race.phase === 'racing') {
    if (lastLaps >= 0 && me.lapsDone > lastLaps && me.finishTime === null) audio.chime(3);
    if (me.finishTime !== null && !lastFinished) {
      const winner = race.standings.find((s) => s.position === 1);
      celebrate({
        position: me.position,
        racers: race.standings.length,
        finishTime: me.finishTime,
        gap: me.position > 1 && winner?.finishTime != null ? me.finishTime - winner.finishTime : null,
        carColor: session.players.get(me.id)?.car.color ?? 0xffd84a,
      });
    }
    lastLaps = me.lapsDone;
    lastFinished = me.finishTime !== null;
  } else {
    lastLaps = -1;
    lastFinished = false;
  }
}

/** Thump when our car's velocity changes sharply in one tick (walls, other cars). */
function checkImpact(): void {
  const car = session.localId ? session.sim.cars.get(session.localId) : undefined;
  if (!car) {
    lastVelocity = null;
    return;
  }
  const v = car.body.linvel();
  if (lastVelocity) {
    const dv = Math.hypot(v.x - lastVelocity.x, v.z - lastVelocity.z);
    // Driving accelerates by < 0.5 m/s per tick; anything much bigger is a hit.
    if (dv > 2.5) audio.crash((dv - 2) / 10);
  }
  lastVelocity = { x: v.x, z: v.z };
}

/** Is our car driving the wrong way round? (moving backwards along the track at speed) */
let wrongWayTicks = 0;
function updateWrongWay(): boolean {
  const car = session.localId ? session.sim.cars.get(session.localId) : undefined;
  if (!car) return false;
  const p = car.body.translation();
  const v = car.body.linvel();
  const s = session.track.samples[nearestSampleIndex(session.track, p.x, p.z)];
  const along = v.x * s.tx + v.z * s.tz;
  wrongWayTicks = along < -4 ? wrongWayTicks + 1 : 0;
  return wrongWayTicks > 30;
}

/** Who the camera follows: our car, or (spectating) the race leader. */
function cameraTarget(): string | null {
  if (session.localId) return session.localId;
  const leader = session.race.standings.find((s) => session.sim.cars.has(s.id));
  return leader?.id ?? session.sim.cars.keys().next().value ?? null;
}

let accumulator = 0;
let lastTime = performance.now();
let fps = 60;
let wrongWay = false;

function frame(now: number): void {
  if (import.meta.env.DEV && devHooks.frames++ === 0) devHooks.firstFrameAt = performance.now();
  // rAF passes the frame's start time, which can predate the performance.now() we started from
  // (e.g. after a heavy startup): never let elapsed time go negative.
  const rawFrameTime = Math.max(0, (now - lastTime) / 1000);
  const frameTime = Math.min(rawFrameTime, online ? MAX_FRAME_TIME_ONLINE : MAX_FRAME_TIME_OFFLINE);
  lastTime = now;
  session.noteDroppedTime(rawFrameTime - frameTime);
  fps += (1 / Math.max(frameTime, 1e-3) - fps) * 0.05;
  quality.update(frameTime);

  // 1. Advance the simulation in fixed ticks; online the clock runs slightly fast or slow to stay in sync.
  accumulator += frameTime * session.timeScale;
  while (accumulator >= DT) {
    session.step(controls());
    cars.sync();
    cars.recordTick();
    const local = session.localId ? session.sim.cars.get(session.localId) : undefined;
    if (local) {
      const p = local.body.translation();
      practiceLaps.update(p.x, p.z, session.tick);
    }
    checkImpact();
    accumulator -= DT;
  }
  wrongWay = updateWrongWay();

  // 2. Apply the newest server snapshot (re-simulates pending inputs). This comes after the
  //    ticks so that, after a long frame, "before" and "after" describe the same moment and a
  //    correction measures misprediction only, not the time we spent frozen.
  const corrections = session.poll();
  if (import.meta.env.DEV && corrections && online?.lastSnapshot && devHooks.timeline.length < 5000) {
    const sn = online.lastSnapshot;
    devHooks.timeline.push([session.tick, sn.tick, sn.ack, sn.lead, online.predictor.pendingCount, Math.round(frameTime * 1000)]);
  }
  cars.sync();
  if (corrections) {
    // A correction can change our velocity abruptly; that's not a crash.
    lastVelocity = null;
    cars.applyCorrections(corrections);
    debug.recordCorrections(corrections, session.localId);
    if (import.meta.env.DEV && devHooks.corrections.length < 20000) {
      for (const c of corrections) {
        const d = Math.hypot(c.before.p[0] - c.after.p[0], c.before.p[1] - c.after.p[1], c.before.p[2] - c.after.p[2]);
        devHooks.corrections.push({ t: session.tick, id: c.id, local: c.id === session.localId, d, skips: online?.predictor.skips ?? 0 });
      }
    }
  }

  // 3. Render, interpolating between ticks.
  const followed = cameraTarget();
  cars.render(accumulator / DT, frameTime, camera, followed);
  effects.update(frameTime);
  const pose = cars.poseOf(followed);
  if (import.meta.env.DEV && devHooks.cameraOverride) {
    const [x, y, z, lx, ly, lz] = devHooks.cameraOverride;
    camera.position.set(x, y, z);
    camera.lookAt(lx, ly, lz);
  } else if (pose) {
    // On the lobby/results card, the arrow keys orbit the camera around the car.
    input.arrowsOrbit = raceUi.cardOpen;
    const orbit = input.orbit();
    chase.orbit(raceUi.cardOpen, orbit.yaw, orbit.tilt, frameTime);
    chase.frame(raceUi.cardOpen ? freeSpaceShift() : 0, frameTime);
    chase.update(pose.pos, pose.rot, pose.speed / session.sim.tuning.maxSpeed, frameTime);
    const [sx, sy, sz] = world.look.sunOffset;
    sun.position.set(pose.pos.x + sx, pose.pos.y + sy, pose.pos.z + sz);
    sun.target.position.copy(pose.pos);
    hud.speed.textContent = String(Math.round(Math.abs(pose.speed) * 3.6));
  }

  // Countdown lights on the gantry: a red lamp per 0.6 s, then all green at GO.
  const nowTick = session.serverTickNow();
  const race = session.race;
  if (race.phase === 'countdown') {
    const elapsed = COUNTDOWN_TICKS - (race.startTick - nowTick);
    world.setStartLights(Math.min(5, Math.max(0, Math.floor(elapsed / (COUNTDOWN_TICKS / 5)) + 1)), false);
  } else if (race.phase === 'racing' && nowTick - race.startTick < 150) {
    world.setStartLights(0, true);
  } else {
    world.setStartLights(0, false);
  }

  soundCues();
  // The results card takes over from the celebration.
  if (race.phase !== 'racing') celebration.stop();
  celebration.update(frameTime);
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  audio.update(carSounds(), { position: camera.position, forward });

  raceUi.update({
    race: session.race,
    players: session.players,
    localId: session.localId,
    isHost: session.isHost,
    now: session.serverTickNow(),
    online: !!online,
    room: online?.room,
    spectating: !!online && !session.localId,
    wrongWay,
    practice: { current: practiceLaps.current(session.tick), last: practiceLaps.lastLap, best: practiceLaps.bestLap },
    trackId: session.track.def.id,
    track: session.track,
    myCar: session.localId || session.race.phase === 'lobby' ? (session.players.get(session.localId ?? '')?.car ?? null) : null,
    botSettings: session.botSettings,
    weather: session.weather,
    celebrating: celebration.active,
  });

  // Phones: the lobby/results card would cover the map, so show it only while racing there.
  minimap.visible = !IS_TOUCH_DEVICE || race.phase === 'countdown' || race.phase === 'racing';
  minimap.update(session.sim, session.localId, (id) => session.players.get(id)?.car.color);

  debug.updateGhosts(online?.lastSnapshot ?? null);
  debug.update({
    mode: online ? 'online' : 'offline',
    room: online?.room,
    players: session.players.size,
    stats: online?.conn.stats,
    serverLead: online?.lastSnapshot?.lead,
    targetLead: online?.predictor.targetLead,
    timeScale: session.timeScale,
    pending: online?.predictor.pendingCount,
    fps,
  });

  // Weather: the race setting drives the scene, headlights and spray.
  world.setWeather(session.weather);
  cars.setHeadlights(world.look.headlights);
  effects.wet = world.look.wet;
  // On a snow road rain falls as snow: silent.
  audio.setRain(session.weather === 'rain' && !session.track.def.snow ? 1 : 0);
  world.update(frameTime);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
