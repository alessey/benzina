import * as THREE from 'three';
import { botInput, buildTrack, DEFAULT_TRACK, DT, initPhysics, type CarInput } from '@benzina/shared';
import { createScene } from './scene';
import { CarRenderer } from './carRenderer';
import { CarView } from './carView';
import { ChaseCamera } from './chaseCamera';
import { DebugOverlay } from './debugOverlay';
import { enterFullscreenLandscape, fullscreenSupported, keepScreenAwake, preventBrowserGestures } from './device';
import { InputManager, IS_TOUCH_DEVICE } from './input';
import { AdaptiveResolution } from './quality';
import { formatTime, LapTimer } from './lapTimer';
import { Connection } from './net/connection';
import { OfflineSession, OnlineSession, type Session } from './session';
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
//   ?room=CODE   join/create a specific room     ?name=NAME   driver name
//   ?bots=N      server bots when creating a room ?offline     single player, no server
//   ?bot         autopilot drives your car         ?debug       show netcode overlay
//   ?lag=MS ?jitter=MS ?loss=PCT                  simulate a bad network (round trip)
const params = new URLSearchParams(location.search);
const num = (key: string) => Math.max(0, Number(params.get(key) ?? 0) || 0);
const AUTOPILOT = params.has('bot');

const hud = {
  speed: document.getElementById('speed-value')!,
  lapNow: document.getElementById('lap-now')!,
  lapLast: document.getElementById('lap-last')!,
  lapBest: document.getElementById('lap-best')!,
  room: document.getElementById('room')!,
  status: document.getElementById('status')!,
  loading: document.getElementById('loading')!,
};

function setStatus(text: string): void {
  hud.status.textContent = text;
  hud.status.hidden = text === '';
}

await initPhysics();
const track = buildTrack(DEFAULT_TRACK);
const { renderer, scene, camera, sun } = createScene(track, { mobile: IS_TOUCH_DEVICE });
// Compile every shader now, while the loading screen is up, instead of stalling the first
// frames of the race (shader compilation can take hundreds of ms on phones). A throwaway
// car makes sure the car materials are included.
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
/** Dev-only hooks for automated testing (headless Chrome over CDP). */
const devHooks = {
  scene,
  camera,
  track,
  THREE,
  corrections: [] as { t: number; id: string; local: boolean; d: number; skips: number }[],
  /** Per-reconcile timeline: client tick, server tick, ack, lead, pending (after), frame ms. */
  timeline: [] as number[][],
};
if (import.meta.env.DEV) Object.assign(window, { __benzina: devHooks });

let session: Session;
let online: OnlineSession | null = null;

if (params.has('offline')) {
  session = new OfflineSession(track);
} else {
  hud.loading.textContent = 'Connecting…';
  try {
    const { conn, welcome } = await Connection.open({
      room: params.get('room'),
      name: params.get('name') ?? `Driver ${100 + Math.floor(Math.random() * 900)}`,
      bots: num('bots'),
      conditions: { lagMs: num('lag'), jitterMs: num('jitter'), lossPct: num('loss') },
    });
    online = new OnlineSession(track, conn, welcome.room, welcome.id, welcome.tuning, welcome.players);
    session = online;
    // Put the room code in the URL so it can be shared to invite friends.
    params.set('room', welcome.room);
    params.delete('bots');
    history.replaceState(null, '', `?${params}`);
  } catch (err) {
    session = new OfflineSession(track);
    setStatus(`Offline: ${(err as Error).message}`);
  }
}
hud.loading.remove();

const refreshTuning = createTuningPanel(session.sim.tuning, {
  persist: !online,
  onChange: online ? (t) => online!.sendTuning(t) : undefined,
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
const laps = new LapTimer(track);
const debug = new DebugOverlay(scene, params.has('debug'));

function updateRoomHud(): void {
  if (!online) {
    hud.room.textContent = 'Offline practice';
    return;
  }
  const names = [...online.players.values()].map((p) => p.name).join(' · ');
  hud.room.textContent = `Room ${online.room} — ${online.players.size}/8 — ${names}`;
}
updateRoomHud();

if (online) {
  online.onPlayersChanged = updateRoomHud;
  online.onTuning = refreshTuning;
  online.onDisconnect = () => setStatus('Disconnected from server. Reload to rejoin.');
}

function controls(): CarInput {
  const human = input.sample();
  const car = session.localId ? session.sim.cars.get(session.localId) : undefined;
  return AUTOPILOT && car ? { ...botInput(car, track), reset: human.reset } : human;
}

let accumulator = 0;
let lastTime = performance.now();
let fps = 60;

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
      laps.update(p.x, p.z, session.tick);
    }
    accumulator -= DT;
  }

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
  const pose = cars.poseOf(session.localId);
  if (pose) {
    chase.update(pose.pos, pose.rot, pose.speed / session.sim.tuning.maxSpeed, frameTime);
    sun.position.set(pose.pos.x + 30, 60, pose.pos.z + 20);
    sun.target.position.copy(pose.pos);
    hud.speed.textContent = String(Math.round(Math.abs(pose.speed) * 3.6));
  }
  hud.lapNow.textContent = formatTime(laps.current(session.tick));
  hud.lapLast.textContent = formatTime(laps.lastLap);
  hud.lapBest.textContent = formatTime(laps.bestLap);

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
