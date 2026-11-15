import * as THREE from 'three';
import {
  botInput,
  buildTrack,
  DEFAULT_TRACK,
  DT,
  initPhysics,
  SimWorld,
  type CarState,
} from '@benzina/shared';
import { createScene } from './scene';
import { CarView } from './carView';
import { ChaseCamera } from './chaseCamera';
import { InputManager } from './input';
import { formatTime, LapTimer } from './lapTimer';
import { createTuningPanel } from './tuningPanel';

const LOCAL_ID = 'local';
/** Never simulate more than this much time in one frame (e.g. after a background tab). */
const MAX_FRAME_TIME = 0.25;
/** Add ?bot to the URL to let the autopilot drive (handy for testing). */
const AUTOPILOT = new URLSearchParams(location.search).has('bot');

await initPhysics();

const track = buildTrack(DEFAULT_TRACK);
const sim = new SimWorld(track);
const car = sim.addCar(LOCAL_ID, 0);
createTuningPanel(sim.tuning);

const { renderer, scene, camera, sun } = createScene(track);
const carView = new CarView();
scene.add(carView.group);
const chase = new ChaseCamera(camera);
const input = new InputManager();
const laps = new LapTimer(track);

const hud = {
  speed: document.getElementById('speed-value')!,
  lapNow: document.getElementById('lap-now')!,
  lapLast: document.getElementById('lap-last')!,
  lapBest: document.getElementById('lap-best')!,
};
document.getElementById('loading')!.remove();

// Fixed-timestep loop: the sim always advances in DT steps, rendering interpolates
// between the previous and current tick so motion is smooth at any refresh rate.
let prevState: CarState = car.getState();
let currState: CarState = prevState;
let accumulator = 0;
let lastTime = performance.now();

const renderPos = new THREE.Vector3();
const renderRot = new THREE.Quaternion();
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

function frame(now: number): void {
  const frameTime = Math.min((now - lastTime) / 1000, MAX_FRAME_TIME);
  lastTime = now;
  accumulator += frameTime;

  while (accumulator >= DT) {
    prevState = currState;
    const controls = AUTOPILOT ? botInput(car, track) : input.sample();
    sim.step(new Map([[LOCAL_ID, controls]]));
    currState = car.getState();
    laps.update(currState.p[0], currState.p[2], sim.tick);
    accumulator -= DT;
  }

  const alpha = accumulator / DT;
  renderPos.set(
    THREE.MathUtils.lerp(prevState.p[0], currState.p[0], alpha),
    THREE.MathUtils.lerp(prevState.p[1], currState.p[1], alpha),
    THREE.MathUtils.lerp(prevState.p[2], currState.p[2], alpha),
  );
  qa.fromArray(prevState.q);
  qb.fromArray(currState.q);
  renderRot.slerpQuaternions(qa, qb, alpha);

  const speed = car.forwardSpeed();
  carView.update(renderPos, renderRot, speed, currState.steer, frameTime);
  chase.update(renderPos, renderRot, speed / sim.tuning.maxSpeed, frameTime);

  // Keep the shadow camera centred on the car.
  sun.position.set(renderPos.x + 30, 60, renderPos.z + 20);
  sun.target.position.copy(renderPos);

  hud.speed.textContent = String(Math.round(Math.abs(speed) * 3.6));
  hud.lapNow.textContent = formatTime(laps.current(sim.tick));
  hud.lapLast.textContent = formatTime(laps.lastLap);
  hud.lapBest.textContent = formatTime(laps.bestLap);

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
