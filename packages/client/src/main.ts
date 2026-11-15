import * as THREE from 'three';
import { botInput, buildTrack, DEFAULT_TRACK, DT, initPhysics, type CarInput } from '@benzina/shared';
import { createScene } from './scene';
import { CarRenderer } from './carRenderer';
import { ChaseCamera } from './chaseCamera';
import { DebugOverlay } from './debugOverlay';
import { InputManager } from './input';
import { formatTime, LapTimer } from './lapTimer';
import { Connection } from './net/connection';
import { OfflineSession, OnlineSession, type Session } from './session';
import { createTuningPanel } from './tuningPanel';

/** Never simulate more than this much time in one frame (e.g. after a background tab). */
const MAX_FRAME_TIME = 0.25;

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
const { renderer, scene, camera, sun } = createScene(track);
if (import.meta.env.DEV) Object.assign(window, { __benzina: { scene, camera, track, THREE } });

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
});

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
  const frameTime = Math.min((now - lastTime) / 1000, MAX_FRAME_TIME);
  lastTime = now;
  fps += (1 / Math.max(frameTime, 1e-3) - fps) * 0.05;

  // 1. Apply the newest server snapshot (re-simulates pending inputs).
  const corrections = session.poll();
  cars.sync();
  if (corrections) {
    cars.applyCorrections(corrections);
    debug.recordCorrections(corrections, session.localId);
  }

  // 2. Advance the simulation in fixed ticks; online the clock runs slightly fast or slow to stay in sync.
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
    serverBuffered: online?.lastSnapshot?.buffered,
    timeScale: session.timeScale,
    pending: online?.predictor.pendingCount,
    fps,
  });

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
