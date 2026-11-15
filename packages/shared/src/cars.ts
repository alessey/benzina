import type { CarTuning } from './config';

/**
 * Car classes: each is better at something and worse at something else, as multipliers on
 * the base handling tuning. Part of the simulation (client and server must agree), so a car's
 * class travels in every snapshot.
 */
export type CarClass = 'equilibrio' | 'bolide' | 'scatto' | 'artiglio';
export const CAR_CLASSES: readonly CarClass[] = ['equilibrio', 'bolide', 'scatto', 'artiglio'];

export interface ClassSpec {
  name: string;
  tagline: string;
  /** Multipliers on the base tuning. */
  speed: number;
  accel: number;
  grip: number;
  steer: number;
  /** Relative mass: heavier cars shove lighter ones further in bumps. */
  mass: number;
}

export const CLASS_SPECS: Record<CarClass, ClassSpec> = {
  equilibrio: { name: 'Equilibrio', tagline: 'Balanced all-rounder', speed: 1, accel: 1, grip: 1, steer: 1, mass: 1 },
  bolide: { name: 'Bolide', tagline: 'Top speed, but a handful in corners', speed: 1.1, accel: 0.85, grip: 0.88, steer: 0.92, mass: 1 },
  scatto: { name: 'Scatto', tagline: 'Explosive acceleration, heavy', speed: 0.97, accel: 1.9, grip: 0.98, steer: 1.02, mass: 1.15 },
  artiglio: { name: 'Artiglio', tagline: 'Grips and turns like it’s on rails', speed: 0.92, accel: 1.05, grip: 1.25, steer: 1.15, mass: 0.9 },
};

/** The base tuning adjusted for a class. */
export function classTuning(base: CarTuning, cls: CarClass): CarTuning {
  const c = CLASS_SPECS[cls];
  return {
    ...base,
    maxSpeed: base.maxSpeed * c.speed,
    accel: base.accel * c.accel,
    grip: base.grip * c.grip,
    driftGrip: base.driftGrip * c.grip,
    cornerGrip: base.cornerGrip * c.grip,
    maxYawRate: base.maxYawRate * c.steer,
  };
}

/** Paint colours players can choose from. */
export const CAR_COLORS: readonly number[] = [
  0xd8262e, 0x2e6fd8, 0xf2b705, 0x2fa84f, 0x9b3fd1, 0xf27405, 0x1fb5b5, 0xe8e8e8, 0xff7ab8, 0x222831,
];

export interface CarChoice {
  cls: CarClass;
  color: number;
}

export const DEFAULT_CAR: CarChoice = { cls: 'equilibrio', color: CAR_COLORS[0] };

/** Sanitise a choice from the network or storage. */
export function parseCarChoice(raw: { cls?: unknown; color?: unknown } | null | undefined): CarChoice {
  const cls = CAR_CLASSES.includes(raw?.cls as CarClass) ? (raw!.cls as CarClass) : DEFAULT_CAR.cls;
  const color = typeof raw?.color === 'number' && raw.color >= 0 && raw.color <= 0xffffff ? Math.floor(raw.color) : DEFAULT_CAR.color;
  return { cls, color };
}

/** A colour nobody in `taken` is using (cycling from `seed`), else any. */
export function freeColor(taken: Iterable<number>, seed: number): number {
  const used = new Set(taken);
  for (let i = 0; i < CAR_COLORS.length; i++) {
    const c = CAR_COLORS[(seed + i) % CAR_COLORS.length];
    if (!used.has(c)) return c;
  }
  return CAR_COLORS[seed % CAR_COLORS.length];
}
