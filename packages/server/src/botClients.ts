/**
 * Headless bot clients: real WebSocket clients that join a room and drive with the
 * autopilot through the same prediction path as the browser. Use them to fill a room or
 * load-test the server.
 *
 *   npm run bots -- --room ABCD --count 3 [--url ws://localhost:2567/ws]
 */
import {
  botInput,
  buildTrack,
  decodeSnapshot,
  DEFAULT_TRACK,
  DT,
  encodeInput,
  initPhysics,
  Predictor,
  SimWorld,
  type ServerMessage,
} from '@benzina/shared';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = arg('url', 'ws://localhost:2567/ws');
const room = arg('room', '');
const count = Number(arg('count', '3'));

await initPhysics();
const track = buildTrack(DEFAULT_TRACK);

function runBot(n: number): void {
  const params = new URLSearchParams({ name: `HeadlessBot ${n}`, mode: room ? 'join' : 'quick' });
  if (room) params.set('room', room);
  const ws = new WebSocket(`${url}?${params}`);
  ws.binaryType = 'arraybuffer';
  let predictor: Predictor | null = null;
  let localId = '';
  let timer: NodeJS.Timeout | undefined;

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      const msg = JSON.parse(ev.data) as ServerMessage;
      if (msg.type === 'welcome' || msg.type === 'race') {
        predictor?.setFreeze(msg.race.phase === 'countdown' ? msg.race.startTick : null);
      }
      if (msg.type === 'welcome') {
        localId = String(msg.id);
        predictor = new Predictor(new SimWorld(track, { ...msg.tuning }), localId);
        predictor.setFreeze(msg.race.phase === 'countdown' ? msg.race.startTick : null);
        console.log(`bot ${n}: joined room ${msg.room} as car ${msg.id}`);
        let last = performance.now();
        let acc = 0;
        timer = setInterval(() => {
          const now = performance.now();
          acc += ((now - last) / 1000) * predictor!.timeScale;
          last = now;
          while (acc >= DT) {
            acc -= DT;
            const car = predictor!.sim.cars.get(localId);
            if (!car) {
              predictor!.stepWithoutCar(); // spectating until the next lobby
              continue;
            }
            const { seq, input } = predictor!.step(botInput(car, track, 0.85 + Math.random() * 0.15));
            ws.send(encodeInput(seq, input));
          }
        }, 5);
      } else if (msg.type === 'tuning' && predictor) {
        Object.assign(predictor.sim.tuning, msg.tuning);
      }
      return;
    }
    const snap = decodeSnapshot(new Uint8Array(ev.data as ArrayBuffer));
    if (snap && predictor) predictor.reconcile(snap);
  };
  ws.onclose = () => {
    clearInterval(timer);
    console.log(`bot ${n}: disconnected`);
  };
  ws.onerror = () => console.log(`bot ${n}: connection error`);
}

for (let i = 1; i <= count; i++) setTimeout(() => runBot(i), i * 300);
