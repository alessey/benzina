import { CAR_CLASSES, CAR_COLORS, CLASS_SPECS, parseCarChoice, type CarChoice } from '@benzina/shared';

const CAR_KEY = 'benzina.car';

export function savedCar(): CarChoice {
  try {
    return parseCarChoice(JSON.parse(localStorage.getItem(CAR_KEY) ?? 'null'));
  } catch {
    return parseCarChoice(null);
  }
}

export function saveCar(car: CarChoice): void {
  try {
    localStorage.setItem(CAR_KEY, JSON.stringify(car));
  } catch {
    // Storage unavailable.
  }
}

export const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`;

/** 1–5 bars for a multiplier within [lo, hi]. */
function bars(value: number, lo: number, hi: number): string {
  const n = Math.max(1, Math.min(5, Math.round(1 + ((value - lo) / (hi - lo)) * 4)));
  return '▮'.repeat(n) + '<span class="off">' + '▮'.repeat(5 - n) + '</span>';
}

/**
 * Car class + colour picker. Pure HTML; clicks carry data-pick-class / data-pick-color, handled
 * by `handlePickerClick` so the start screen and the lobby card can share it.
 */
export function carPickerHtml(car: CarChoice): string {
  const spec = CLASS_SPECS[car.cls];
  const classes = CAR_CLASSES.map(
    (cls) =>
      `<button type="button" class="cls ${cls === car.cls ? 'on' : ''}" data-pick-class="${cls}">${CLASS_SPECS[cls].name}</button>`,
  ).join('');
  const colors = CAR_COLORS.map(
    (c) =>
      `<button type="button" class="swatch ${c === car.color ? 'on' : ''}" data-pick-color="${c}" style="background:${hex(c)}" aria-label="Colour ${hex(c)}"></button>`,
  ).join('');
  return `<div class="car-picker">
    <div class="classes">${classes}</div>
    <div class="car-info">
      <span class="tagline">${spec.tagline}</span>
      <span class="stat">Speed <b>${bars(spec.speed, 0.9, 1.12)}</b></span>
      <span class="stat">Accel <b>${bars(spec.accel, 0.8, 2)}</b></span>
      <span class="stat">Grip <b>${bars(spec.grip, 0.85, 1.3)}</b></span>
    </div>
    <div class="colors">${colors}</div>
  </div>`;
}

/** Apply a click inside a picker; returns the new choice, or null if the click wasn't on it. */
export function handlePickerClick(target: EventTarget | null, car: CarChoice): CarChoice | null {
  const el = (target as HTMLElement | null)?.closest<HTMLElement>('[data-pick-class],[data-pick-color]');
  if (!el) return null;
  if (el.dataset.pickClass) return parseCarChoice({ cls: el.dataset.pickClass, color: car.color });
  return parseCarChoice({ cls: car.cls, color: Number(el.dataset.pickColor) });
}
