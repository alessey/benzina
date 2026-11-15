import { DT, nearestSampleIndex, type Track } from '@benzina/shared';

/**
 * Local lap timing from centre-line progress. A lap counts when the car crosses the
 * start line forwards after having passed the halfway point. (Server will own this later.)
 */
export class LapTimer {
  private lastIndex = -1;
  private passedHalf = false;
  private lapStartTick: number | null = null;
  lastLap: number | null = null;
  bestLap: number | null = null;

  constructor(private readonly track: Track) {}

  update(x: number, z: number, tick: number): void {
    const n = this.track.samples.length;
    const idx = nearestSampleIndex(this.track, x, z);
    if (idx > n * 0.4 && idx < n * 0.6) this.passedHalf = true;

    const crossedForward = this.lastIndex > n * 0.9 && idx < n * 0.1;
    if (crossedForward) {
      if (this.lapStartTick === null) {
        this.lapStartTick = tick;
      } else if (this.passedHalf) {
        const time = (tick - this.lapStartTick) * DT;
        this.lastLap = time;
        if (this.bestLap === null || time < this.bestLap) this.bestLap = time;
        this.lapStartTick = tick;
      }
      this.passedHalf = false;
    }
    this.lastIndex = idx;
  }

  current(tick: number): number | null {
    return this.lapStartTick === null ? null : (tick - this.lapStartTick) * DT;
  }
}

export function formatTime(t: number | null): string {
  if (t === null) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}
