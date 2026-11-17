import type { CarTuning } from './config';
import { onDirt, rightOf, type Track } from './track';

/**
 * Weather is a race setting, like the track: the server and every client simulate the same
 * conditions, so prediction stays exact. Only rain changes the physics (wet grip, puddles);
 * the others change what you see (overcast light, fog, dusk).
 */
export type Weather = 'clear' | 'overcast' | 'rain' | 'fog' | 'dusk';
export const WEATHERS: readonly Weather[] = ['clear', 'overcast', 'rain', 'fog', 'dusk'];
export const WEATHER_NAMES: Record<Weather, string> = {
  clear: 'Clear',
  overcast: 'Overcast',
  rain: 'Rain',
  fog: 'Fog',
  dusk: 'Dusk',
};

export function parseWeather(raw: unknown): Weather {
  return WEATHERS.includes(raw as Weather) ? (raw as Weather) : 'clear';
}

/** Wet road: multipliers on the class tuning. */
export const WET = { grip: 0.72, driftGrip: 0.8, cornerGrip: 0.8, brakeDecel: 0.72, accel: 0.9 };
/** Standing water on top of that: the car slides and slows. */
export const PUDDLE = { grip: 0.3, cornerGrip: 0.6, accel: 0.5, drag: 4 };
/**
 * Dirt: loose, drifty and a bit slower (multipliers on the class tuning). Mud is dirt in the
 * rain: looser and slower still. (They replace the wet-road multipliers, not stack on them.)
 */
export const DIRT = { grip: 0.45, driftGrip: 0.85, cornerGrip: 0.7, brakeDecel: 0.7, accel: 0.85, maxSpeed: 0.82 };
export const MUD = { grip: 0.32, driftGrip: 0.7, cornerGrip: 0.56, brakeDecel: 0.55, accel: 0.7, maxSpeed: 0.72 };

/** Dirt or mud multipliers at sample i, or null on tarmac. */
export function looseSurface(track: Track, i: number, weather: Weather): typeof DIRT | null {
  if (!onDirt(track, i)) return null;
  return weather === 'rain' ? MUD : DIRT;
}

/**
 * Cornering grip at sample i relative to the tuning bots are given (already wet in the rain):
 * what a bot multiplies its corner grip by on dirt or mud.
 */
export function surfaceCornerFactor(track: Track, i: number, weather: Weather): number {
  const loose = looseSurface(track, i, weather);
  if (!loose) return 1;
  return loose.cornerGrip / (weather === 'rain' ? WET.cornerGrip : 1);
}

/** Tuning for a wet road (no puddle): what bots plan their corner speeds with in the rain. */
export function weatherTuning(t: CarTuning, weather: Weather): CarTuning {
  if (weather !== 'rain') return t;
  return {
    ...t,
    grip: t.grip * WET.grip,
    driftGrip: t.driftGrip * WET.driftGrip,
    cornerGrip: t.cornerGrip * WET.cornerGrip,
    brakeDecel: t.brakeDecel * WET.brakeDecel,
    accel: t.accel * WET.accel,
  };
}

/** A patch of standing water: a run of samples along the track, at a lateral offset. */
export interface Puddle {
  /** First and last sample index (i0 <= i1, never wrapping past the start). */
  i0: number;
  i1: number;
  /** Centre offset to the right of the centre line, and half width, metres. */
  lat: number;
  halfWidth: number;
}

const puddleCache = new WeakMap<Track, Puddle[]>();

/** Small deterministic PRNG, seeded per track so puddles sit in the same places for everyone. */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Is sample i inside the track's tunnel (which stays dry)? */
export function inTunnel(track: Track, i: number): boolean {
  if (!track.tunnel) return false;
  const [a, b] = track.tunnel;
  return a <= b ? i >= a && i <= b : i >= a || i <= b;
}

/** Puddles for a track (used in rain): fixed spots, so players can learn a line around them. */
export function trackPuddles(track: Track): Puddle[] {
  const cached = puddleCache.get(track);
  if (cached) return cached;
  // A bobsled channel's ice has no standing water.
  if (track.def.pipe) {
    puddleCache.set(track, []);
    return [];
  }
  const rand = rng(track.def.id);
  const n = track.samples.length;
  const count = Math.max(3, Math.floor(track.length / 150));
  const hw = track.def.width / 2;
  const puddles: Puddle[] = [];
  for (let k = 0; k < count; k++) {
    const d = ((k + 0.5 + (rand() - 0.5) * 0.6) / count) * track.length;
    // Keep the grid and the run to the line clear.
    if (d < 90 || d > track.length - 40) continue;
    const i0 = track.samples.findIndex((s) => s.dist >= d);
    const len = 2 + Math.floor(rand() * 3);
    const i1 = Math.min(n - 1, i0 + len);
    // No standing water in the tunnel, or on dirt (that's mud instead).
    if (i0 < 0 || inTunnel(track, i0) || inTunnel(track, i1) || onDirt(track, i0) || onDirt(track, i1)) continue;
    const halfWidth = 1.3 + rand() * 0.9;
    const room = Math.max(0, hw - halfWidth - 0.6);
    puddles.push({ i0, i1, lat: (rand() * 2 - 1) * room, halfWidth });
  }
  puddleCache.set(track, puddles);
  return puddles;
}

/** Is (x, z), nearest to sample i, in standing water? */
export function inPuddle(track: Track, i: number, x: number, z: number): boolean {
  const s = track.samples[i];
  const r = rightOf(s.tx, s.tz);
  const lat = (x - s.x) * r.x + (z - s.z) * r.z;
  for (const p of trackPuddles(track)) {
    if (i >= p.i0 && i <= p.i1 && Math.abs(lat - p.lat) <= p.halfWidth) return true;
  }
  return false;
}

/**
 * Tuning for where a car is right now: dry, wet, in a puddle, on dirt or in mud. (Rain only
 * wets the road; the tunnel is dry.)
 */
export function surfaceTuning(
  t: CarTuning,
  weather: Weather,
  track: Track,
  i: number,
  x: number,
  z: number,
): { tuning: CarTuning; puddle: boolean; dirt: boolean } {
  const loose = looseSurface(track, i, weather);
  if (loose) {
    return {
      tuning: {
        ...t,
        grip: t.grip * loose.grip,
        driftGrip: t.driftGrip * loose.driftGrip,
        cornerGrip: t.cornerGrip * loose.cornerGrip,
        brakeDecel: t.brakeDecel * loose.brakeDecel,
        accel: t.accel * loose.accel,
        maxSpeed: t.maxSpeed * loose.maxSpeed,
      },
      puddle: false,
      dirt: true,
    };
  }
  if (weather !== 'rain' || inTunnel(track, i)) return { tuning: t, puddle: false, dirt: false };
  const wet = weatherTuning(t, weather);
  if (!inPuddle(track, i, x, z)) return { tuning: wet, puddle: false, dirt: false };
  return {
    tuning: {
      ...wet,
      grip: wet.grip * PUDDLE.grip,
      driftGrip: wet.driftGrip * PUDDLE.grip,
      cornerGrip: wet.cornerGrip * PUDDLE.cornerGrip,
      accel: wet.accel * PUDDLE.accel,
    },
    puddle: true,
    dirt: false,
  };
}
