import type * as THREE from 'three';

/**
 * Dynamic resolution: if frames are slow, render fewer pixels; if there's headroom,
 * render more. Changes happen at most every 2 s, with hysteresis, since resizing the
 * drawing buffer isn't free.
 *
 * Some devices cap the frame rate regardless of load (iPhone Low Power Mode runs at 30 fps).
 * If dropping resolution doesn't raise fps, we undo it and stop going lower.
 */
export class AdaptiveResolution {
  private scale: number;
  private floor: number;
  private frames = 0;
  private elapsed = 0;
  private lastDownscale: { from: number; fps: number } | null = null;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    min: number,
    private readonly max: number,
  ) {
    this.scale = max;
    this.floor = min;
    renderer.setPixelRatio(this.scale);
  }

  get pixelRatio(): number {
    return this.scale;
  }

  update(frameTime: number): void {
    this.frames++;
    this.elapsed += frameTime;
    if (this.elapsed < 2) return;
    const fps = this.frames / this.elapsed;
    this.frames = 0;
    this.elapsed = 0;

    if (this.lastDownscale) {
      const { from, fps: before } = this.lastDownscale;
      this.lastDownscale = null;
      if (fps < before * 1.05) {
        // Fewer pixels didn't help: the frame rate is capped, not GPU-bound.
        this.floor = from;
        this.apply(from);
        return;
      }
    }

    if (fps < 50 && this.scale > this.floor) {
      this.lastDownscale = { from: this.scale, fps };
      this.apply(Math.max(this.floor, this.scale * 0.8));
    } else if (fps > 58 && this.scale < this.max) {
      this.apply(Math.min(this.max, this.scale * 1.1));
    }
  }

  private apply(next: number): void {
    if (Math.abs(next - this.scale) < 0.01) return;
    this.scale = next;
    this.renderer.setPixelRatio(next);
  }
}
