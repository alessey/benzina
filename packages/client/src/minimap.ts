import type { SimWorld, Track } from '@benzina/shared';
import { carColor } from './carRenderer';

const PAD = 8;

/**
 * Overhead track map with a dot per car. The circuit outline is drawn once per track into an
 * offscreen canvas; each update just blits it and draws the dots (cheap enough at 20 Hz).
 */
export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private background: HTMLCanvasElement | null = null;
  private track: Track | null = null;
  private scale = 1;
  private ox = 0;
  private oz = 0;
  private lastDraw = 0;

  constructor(private readonly size: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'minimap';
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = this.canvas.height = Math.round(size * dpr);
    this.canvas.style.width = this.canvas.style.height = `${size}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    document.getElementById('hud')!.appendChild(this.canvas);
  }

  set visible(v: boolean) {
    this.canvas.hidden = !v;
  }

  private setTrack(track: Track): void {
    this.track = track;
    const b = track.bounds;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    this.scale = (this.size - PAD * 2) / span;
    // Centre the circuit; x to the right, z up the screen (so the map matches a top-down view).
    this.ox = this.size / 2 - ((b.minX + b.maxX) / 2) * this.scale;
    this.oz = this.size / 2 + ((b.minZ + b.maxZ) / 2) * this.scale;

    const bg = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio, 2);
    bg.width = bg.height = Math.round(this.size * dpr);
    const g = bg.getContext('2d')!;
    g.scale(dpr, dpr);
    g.fillStyle = 'rgba(10, 16, 22, 0.45)';
    g.beginPath();
    g.roundRect(0, 0, this.size, this.size, 10);
    g.fill();
    const path = new Path2D();
    track.samples.forEach((s, i) => (i === 0 ? path.moveTo(...this.toMap(s.x, s.z)) : path.lineTo(...this.toMap(s.x, s.z))));
    path.closePath();
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 5;
    g.stroke(path);
    g.strokeStyle = 'rgba(60,64,70,1)';
    g.lineWidth = 3;
    g.stroke(path);
    // Start line tick.
    const s0 = track.samples[0];
    const [sx, sy] = this.toMap(s0.x, s0.z);
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(sx, sy, 2.5, 0, Math.PI * 2);
    g.fill();
    this.background = bg;
  }

  private toMap(x: number, z: number): [number, number] {
    return [this.ox + x * this.scale, this.oz - z * this.scale];
  }

  update(sim: SimWorld, localId: string | null): void {
    const now = performance.now();
    if (now - this.lastDraw < 50 || this.canvas.hidden) return;
    this.lastDraw = now;
    if (sim.track !== this.track) this.setTrack(sim.track);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.size, this.size);
    ctx.drawImage(this.background!, 0, 0, this.size, this.size);
    // Others first, us on top.
    const cars = [...sim.cars].sort(([a], [b]) => Number(a === localId) - Number(b === localId));
    for (const [id, car] of cars) {
      const p = car.body.translation();
      const [x, y] = this.toMap(p.x, p.z);
      const local = id === localId;
      ctx.beginPath();
      ctx.arc(x, y, local ? 5 : 3.6, 0, Math.PI * 2);
      ctx.fillStyle = `#${carColor(id, local).toString(16).padStart(6, '0')}`;
      ctx.fill();
      ctx.lineWidth = local ? 2 : 1;
      ctx.strokeStyle = local ? '#fff' : 'rgba(0,0,0,0.6)';
      ctx.stroke();
    }
  }
}
