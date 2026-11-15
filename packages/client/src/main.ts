import * as THREE from 'three';
import { botInput, buildTrack, DEFAULT_TRACK, DT, initPhysics, nearestSampleIndex, type CarInput } from '@benzina/shared';
import { createScene } from './scene';
import { CarRenderer } from './carRenderer';
import { CarView } from './carView';
import { ChaseCamera } from './chaseCamera';
import { DebugOverlay } from './debugOverlay';
import { enterFullscreenLandscape, fullscreenSupported, keepScreenAwake, preventBrowserGestures } from './device';
import { InputManager, IS_TOUCH_DEVICE } from './input';
import { AdaptiveResolution } from './quality';
import { LapTimer } from './lapTimer';
import { Connection } from './net/connection';
import { RaceUi } from './raceUi';
import { OfflineSession, OnlineSession, type Session } from './session';
import { showStartScreen, type StartChoice } from './startScreen';
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
const track = buildTrack(DEFAULT_TRACK);
const { renderer, scene, camera, sun } = createScene(track, { mobile: IS_TOUCH_DEVICE });
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
  track,
  THREE,
  session: null as Session | null,
  corrections: [] as { t: number; id: string; local: boolean; d: number; skips: number }[],
  /** Per-reconcile timeline: client tick, server tick, ack, lead, pending (after), frame ms. */
  timeline: [] as number[][],
};
if (import.meta.env.DEV) Object.assign(window, { __benzina: devHooks });

// ------------------------------------------------------------ menu

/** Slow fly-around of the circuit behind the start screen. */
function attractLoop(): () => void {
  let running = true;
  const centre = track.samples.reduce((a, s) => ({ x: a.x + s.x / track.samples.length, z: a.z + s.z / track.samples.length }), { x: 0, z: 0 });
  const loop = (t: number) => {
    if (!running) return;
    const a = t / 20000;
    camera.position.set(centre.x + Math.cos(a) * 260, 110, centre.z + Math.sin(a) * 260);
    camera.lookAt(centre.x, 0, centre.z);
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return () => (running = false);
}

function choiceFromUrl(): StartChoice | null {
  const name = params.get('name') ?? `Driver ${100 + Math.floor(Math.random() * 900)}`;
  if (params.has('offline')) return { mode: 'offline', name, bots: num('bots', 3) };
  if (!params.has('autojoin')) return null;
  const code = params.get('room');
  return code ? { mode: 'join', name, code } : { mode: 'quick', name };
}

async function openSession(): Promise<Session> {
  let error: string | undefined;
  for (;;) {
    const choice = (!error && choiceFromUrl()) || (await showStartScreen({ inviteCode: params.get('room'), error }));
    if (choice.mode === 'offline') return new OfflineSession(track, choice.bots);
    setStatus('Connecting…');
    try {
      const { conn, welcome } = await Connection.open({
        mode: choice.mode,
        room: choice.mode === 'join' ? choice.code : null,
        name: choice.name,
        // Rooms created by a join-by-code (e.g. ?autojoin&room=X) also honour ?bots.
        bots: choice.mode === 'create' ? choice.bots : num('bots'),
        conditions: { lagMs: num('lag'), jitterMs: num('jitter'), lossPct: num('loss') },
      });
      setStatus('');
      // Put the room code in the URL so a reload rejoins and the address bar is shareable.
      params.set('room', welcome.room);
      history.replaceState(null, '', `?${params}`);
      return new OnlineSession(track, conn, welcome);
    } catch (err) {
      setStatus('');
      error = `Couldn't connect: ${(err as Error).message}`;
    }
  }
}

const stopAttract = attractLoop();
const session = await openSession();
stopAttract();
devHooks.session = session;
const online = session instanceof OnlineSession ? session : null;

// ------------------------------------------------------------ game

const refreshTuning = createTuningPanel(session.sim.tuning, {
  persist: !online,
  onChange: online ? (t) => online.sendTuning(t) : undefined,
  hidden: IS_TOUCH_DEVICE && !params.has('debug'),
});

if (IS_TOUCH_DEVICE && fullscreenSupported()) {
  const btn = document.getElementById('fullscreen')!;
  btn.hidden = false;
  btn.addEventListener('click', () => void enterFullscreenLandscape());
  document.addEventListener('fullscreenchange', () => (btn.hidden = !!document.fullscreenElement));
}

const cars = new CarRenderer(
  scene,
  session.sim,
  (id) => session.players.get(id)?.name ?? `Car ${id}`,
  () => session.localId,
);
const chase = new ChaseCamera(camera);
const input = new InputManager();
let practiceLaps = new LapTimer(track);
const debug = new DebugOverlay(scene, params.has('debug'));

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

const raceUi = new RaceUi({ start: (laps) => session.startRace(laps), invite: () => void invite() });

let lastPhase = session.race.phase;
function onSessionChange(): void {
  const phase = session.race.phase;
  // Fresh practice timer whenever a race starts or ends (cars get teleported).
  if (phase !== lastPhase) practiceLaps = new LapTimer(track);
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

function controls(): CarInput {
  const human = input.sample();
  const car = session.localId ? session.sim.cars.get(session.localId) : undefined;
  return AUTOPILOT && car ? { ...botInput(car, track), reset: human.reset } : human;
}

/** Is our car driving the wrong way round? (moving backwards along the track at speed) */
let wrongWayTicks = 0;
function updateWrongWay(): boolean {
  const car = session.localId ? session.sim.cars.get(session.localId) : undefined;
  if (!car) return false;
  const p = car.body.translation();
  const v = car.body.linvel();
  const s = track.samples[nearestSampleIndex(track, p.x, p.z)];
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
  const rawFrameTime = (now - lastTime) / 1000;
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
  cars.render(accumulator / DT, frameTime);
  const pose = cars.poseOf(cameraTarget());
  if (pose) {
    chase.update(pose.pos, pose.rot, pose.speed / session.sim.tuning.maxSpeed, frameTime);
    sun.position.set(pose.pos.x + 30, 60, pose.pos.z + 20);
    sun.target.position.copy(pose.pos);
    hud.speed.textContent = String(Math.round(Math.abs(pose.speed) * 3.6));
  }

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
  });

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

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
