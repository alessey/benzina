import GUI from 'lil-gui';
import { DEFAULT_TUNING, type CarTuning } from '@benzina/shared';

const RANGES: Record<keyof CarTuning, [number, number, number]> = {
  gravity: [5, 60, 0.5],
  airGravity: [0.3, 1, 0.05],
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
  cornerGrip: [10, 120, 1],
  suspensionStiffness: [50, 1000, 10],
  suspensionDamping: [0, 80, 1],
  pivotOffset: [0, 2, 0.05],
  wallFriction: [0, 40, 0.5],
  wallDeflect: [0, 20, 0.5],
  wallPushOff: [0, 10, 0.1],
  bumpSeparation: [0, 10, 0.1],
  bumpDeflect: [0, 15, 0.5],
  bumpSpin: [0, 3, 0.05],
  bumpSpinMax: [0, 10, 0.1],
  spinRecovery: [0, 3, 0.05],
  tireSlipPeak: [0.02, 0.6, 0.01],
  tireSlipFull: [0.1, 1.5, 0.01],
  tireSlideGrip: [0.05, 1, 0.01],
};

const STORAGE_KEY = 'benzina.tuning';

export interface TuningPanelOptions {
  /** Offline: remember tweaks in localStorage. Online the server owns tuning. */
  persist: boolean;
  /** Called after any change (online: forward to the server). */
  onChange?: (tuning: CarTuning) => void;
  /** Start hidden (phones: it would cover the touch controls). */
  hidden?: boolean;
}

/** Dev panel for live handling tweaks. Returns a function that refreshes the displayed values. */
export function createTuningPanel(tuning: CarTuning, opts: TuningPanelOptions): () => void {
  if (opts.persist) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      if (saved) Object.assign(tuning, pick(saved));
    } catch {
      // Ignore unreadable storage.
    }
  }

  const gui = new GUI({ title: opts.persist ? 'Handling (dev)' : 'Handling (dev, shared with room)' });
  gui.close();
  if (opts.hidden) gui.hide();
  const changed = () => {
    if (opts.persist) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning));
      } catch {
        // Ignore unavailable storage.
      }
    }
    opts.onChange?.(tuning);
  };
  for (const key of Object.keys(RANGES) as (keyof CarTuning)[]) {
    const [min, max, step] = RANGES[key];
    gui.add(tuning, key, min, max, step).onFinishChange(changed);
  }
  const refresh = () => gui.controllersRecursive().forEach((c) => c.updateDisplay());
  gui
    .add(
      {
        reset: () => {
          Object.assign(tuning, DEFAULT_TUNING);
          refresh();
          changed();
        },
      },
      'reset',
    )
    .name('Reset to defaults');
  return refresh;
}

function pick(obj: Record<string, unknown>): Partial<CarTuning> {
  const out: Partial<CarTuning> = {};
  for (const key of Object.keys(DEFAULT_TUNING) as (keyof CarTuning)[]) {
    if (typeof obj[key] === 'number') out[key] = obj[key];
  }
  return out;
}
