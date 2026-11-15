import GUI from 'lil-gui';
import { DEFAULT_TUNING, type CarTuning } from '@benzina/shared';

const RANGES: Record<keyof CarTuning, [number, number, number]> = {
  gravity: [5, 60, 0.5],
  maxSpeed: [10, 90, 1],
  accel: [5, 60, 0.5],
  brakeDecel: [5, 100, 1],
  reverseAccel: [2, 40, 0.5],
  maxReverseSpeed: [2, 30, 0.5],
  rollDrag: [0, 20, 0.1],
  grip: [0.5, 30, 0.1],
  driftGrip: [0, 10, 0.05],
  handbrakeDecel: [0, 30, 0.5],
  maxYawRate: [0.5, 6, 0.05],
  steerFullSpeed: [0.5, 20, 0.1],
  highSpeedSteer: [0.1, 1, 0.01],
  handbrakeYawBoost: [1, 3, 0.05],
  steerSpeed: [1, 30, 0.5],
  yawResponse: [1, 40, 0.5],
};

const STORAGE_KEY = 'benzina.tuning';

/** Dev panel for live handling tweaks. Values persist in localStorage. */
export function createTuningPanel(tuning: CarTuning): void {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved) Object.assign(tuning, pick(saved));
  } catch {
    // Ignore unreadable storage.
  }

  const gui = new GUI({ title: 'Handling (dev)' });
  gui.close();
  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning));
    } catch {
      // Ignore unavailable storage.
    }
  };
  for (const key of Object.keys(RANGES) as (keyof CarTuning)[]) {
    const [min, max, step] = RANGES[key];
    gui.add(tuning, key, min, max, step).onChange(save);
  }
  gui.add(
    {
      reset: () => {
        Object.assign(tuning, DEFAULT_TUNING);
        gui.controllersRecursive().forEach((c) => c.updateDisplay());
        save();
      },
    },
    'reset',
  ).name('Reset to defaults');
}

function pick(obj: Record<string, unknown>): Partial<CarTuning> {
  const out: Partial<CarTuning> = {};
  for (const key of Object.keys(DEFAULT_TUNING) as (keyof CarTuning)[]) {
    if (typeof obj[key] === 'number') out[key] = obj[key];
  }
  return out;
}
