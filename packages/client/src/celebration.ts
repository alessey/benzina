import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { formatTime } from './lapTimer';

/** How long the celebration stays up before shrinking back to the small banner, seconds. */
const DURATION = 7;
const FADE = 0.6;

const PODIUM = [
  { metal: 0xffc93c, glow: '255, 201, 60', label: 'YOU WON!' },
  { metal: 0xd9dde3, glow: '220, 228, 240', label: '2ND PLACE' },
  { metal: 0xc77b3f, glow: '214, 136, 80', label: '3RD PLACE' },
];

export interface FinishInfo {
  position: number;
  racers: number;
  finishTime: number | null;
  /** Seconds behind the winner (null when we won). */
  gap: number | null;
  /** Our car colour, mixed into the confetti. */
  carColor: number;
}

/**
 * Finish-line celebration: a spinning 3D trophy (gold, silver, bronze) over rotating light
 * rays, confetti cannons, and the place and time slammed onto the screen. Off the podium it
 * just shows the place and time.
 */
export class Celebration {
  private readonly root: HTMLDivElement;
  private readonly confettiCanvas: HTMLCanvasElement;
  private readonly trophyCanvas: HTMLCanvasElement;
  private readonly text: HTMLDivElement;
  private trophy: TrophyView | null = null;
  private confetti: Confetti | null = null;
  private time = -1;
  private podium = false;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'celebration';
    this.root.hidden = true;
    this.root.innerHTML = `<canvas class="confetti"></canvas><div class="rays"></div><canvas class="trophy"></canvas><div class="cele-text"></div>`;
    document.body.appendChild(this.root);
    this.confettiCanvas = this.root.querySelector('canvas.confetti')!;
    this.trophyCanvas = this.root.querySelector('canvas.trophy')!;
    this.text = this.root.querySelector('.cele-text')!;
  }

  get active(): boolean {
    return this.time >= 0;
  }

  start(info: FinishInfo): void {
    const place = PODIUM[info.position - 1];
    this.podium = !!place;
    this.time = 0;
    this.root.hidden = false;
    this.root.style.opacity = '1';
    this.root.className = this.podium ? `podium p${info.position}` : 'finisher';
    if (place) this.root.style.setProperty('--glow', place.glow);

    const time = info.finishTime !== null ? formatTime(info.finishTime) : '';
    const gap = info.gap !== null ? `+${info.gap.toFixed(3)}s` : '';
    const headline = place ? place.label : `${ordinal(info.position).toUpperCase()} PLACE`;
    this.text.innerHTML = `<div class="headline">${headline}</div>
      <div class="sub">${ordinal(info.position)} of ${info.racers}${time ? ` · ${time}` : ''}${gap ? ` · <span class="gap">${gap}</span>` : ''}</div>`;
    // Restart the CSS entrance animations.
    for (const el of [this.text, this.root.querySelector<HTMLElement>('.rays')!]) {
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    }

    if (place) {
      this.trophy ??= new TrophyView(this.trophyCanvas);
      this.trophy.show(place.metal, info.position);
      const colors = ['#ffd84a', '#ff4d6d', '#4dd6ff', '#7dff6a', '#ffffff', '#b77bff', `#${info.carColor.toString(16).padStart(6, '0')}`];
      this.confetti = new Confetti(this.confettiCanvas, colors, info.position === 1 ? 1 : 0.5);
    } else {
      this.confetti = null;
    }
  }

  stop(): void {
    if (this.time < 0) return;
    this.time = -1;
    this.root.hidden = true;
    this.confetti?.clear();
    this.confetti = null;
  }

  update(dt: number): void {
    if (this.time < 0) return;
    this.time += dt;
    if (this.time >= DURATION) {
      this.stop();
      return;
    }
    this.root.style.opacity = String(Math.min(1, (DURATION - this.time) / FADE));
    if (this.podium) this.trophy?.render(this.time);
    this.confetti?.update(dt, this.time);
  }
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  const rem10 = n % 10;
  const suffix = rem100 >= 11 && rem100 <= 13 ? 'th' : rem10 === 1 ? 'st' : rem10 === 2 ? 'nd' : rem10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/** A trophy on its own small transparent renderer, so it sits above the HUD. */
class TrophyView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  private readonly group = new THREE.Group();
  private readonly metal = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.18 });
  private readonly plaque: THREE.CanvasTexture;
  private readonly plaqueCtx: CanvasRenderingContext2D;
  private readonly sparkles: THREE.Sprite[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const key = new THREE.DirectionalLight(0xffffff, 2.5);
    key.position.set(3, 5, 4);
    this.scene.add(key, new THREE.AmbientLight(0xffffff, 0.3));
    this.camera.position.set(0, 1.6, 7.2);
    this.camera.lookAt(0, 1.35, 0);

    // Cup, stem and foot turned on a lathe (x = radius, y = height).
    const profile = [
      [0, 0.62], [0.42, 0.62], [0.46, 0.7], [0.2, 0.8], [0.11, 0.95], [0.1, 1.15], [0.2, 1.22], [0.12, 1.32],
      [0.14, 1.45], [0.38, 1.6], [0.62, 1.9], [0.78, 2.3], [0.84, 2.62], [0.9, 2.7], [0.86, 2.72], [0.78, 2.66],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const cup = new THREE.Mesh(new THREE.LatheGeometry(profile, 48), this.metal);
    this.group.add(cup);
    // Handles: half rings either side of the bowl.
    const handleGeo = new THREE.TorusGeometry(0.34, 0.055, 12, 32, Math.PI * 1.15);
    for (const side of [-1, 1]) {
      const handle = new THREE.Mesh(handleGeo, this.metal);
      handle.position.set(side * 0.74, 2.12, 0);
      handle.rotation.z = side > 0 ? -Math.PI * 0.575 : Math.PI * 0.425;
      this.group.add(handle);
    }
    // Plinth with a plaque showing the place.
    const wood = new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.35, metalness: 0.2 });
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.62, 1.25), wood);
    plinth.position.y = 0.31;
    this.group.add(plinth);
    const plaqueCanvas = document.createElement('canvas');
    plaqueCanvas.width = 256;
    plaqueCanvas.height = 128;
    this.plaqueCtx = plaqueCanvas.getContext('2d')!;
    this.plaque = new THREE.CanvasTexture(plaqueCanvas);
    this.plaque.colorSpace = THREE.SRGBColorSpace;
    const plaqueMat = new THREE.MeshStandardMaterial({ map: this.plaque, metalness: 0.6, roughness: 0.3 });
    for (let i = 0; i < 4; i++) {
      // A plaque on every face, so the place reads all the way round the spin.
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.42), plaqueMat);
      const a = (i * Math.PI) / 2;
      plate.position.set(Math.sin(a) * 0.63, 0.31, Math.cos(a) * 0.63);
      plate.rotation.y = a;
      this.group.add(plate);
    }

    // Glints that twinkle around the cup.
    const glint = new THREE.SpriteMaterial({ map: glintTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Sprite(glint);
      this.sparkles.push(s);
      this.scene.add(s);
    }
    this.scene.add(this.group);
  }

  show(color: number, position: number): void {
    this.metal.color.setHex(color);
    const ctx = this.plaqueCtx;
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, `#${new THREE.Color(color).offsetHSL(0, 0, 0.15).getHexString()}`);
    g.addColorStop(1, `#${new THREE.Color(color).offsetHSL(0, 0, -0.2).getHexString()}`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = '#1b1d22';
    ctx.font = 'bold 84px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ordinal(position).toUpperCase(), 128, 70);
    this.plaque.needsUpdate = true;
  }

  render(t: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    // Pop in with an overshoot, then spin (fast at first, settling) and bob.
    const pop = t < 0.7 ? easeOutBack(t / 0.7) : 1;
    this.group.scale.setScalar(Math.max(0.001, pop));
    this.group.rotation.y = t * 1.6 + 5 * (1 - Math.exp(-t * 2.5));
    this.group.position.y = Math.sin(t * 2.2) * 0.06;
    this.group.rotation.z = Math.sin(t * 1.3) * 0.05;
    this.sparkles.forEach((s, i) => {
      const phase = (t * 0.9 + i / this.sparkles.length) % 1;
      const a = i * 2.39996;
      s.position.set(Math.cos(a) * (0.6 + (i % 3) * 0.25), 1.2 + ((i * 0.37) % 1) * 1.6, 0.9);
      s.scale.setScalar(pop * 0.55 * Math.sin(phase * Math.PI) ** 3);
    });
    this.renderer.render(this.scene, this.camera);
  }
}

function easeOutBack(x: number): number {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
}

/** A four-point star for the glints. */
function glintTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.15, 'rgba(255,250,220,0.8)');
  g.addColorStop(1, 'rgba(255,240,200,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? 32 : 5;
    const a = (i * Math.PI) / 4;
    ctx.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
  }
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  flip: number;
  flipSpeed: number;
  w: number;
  h: number;
  color: string;
  ribbon: boolean;
}

/** Paper confetti fired from cannons in both bottom corners, then a light drizzle from the top. */
class Confetti {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly pieces: Piece[] = [];
  private w = 0;
  private h = 0;
  private dpr = 1;
  private drizzle = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly colors: string[],
    private readonly amount: number,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    const n = Math.round(160 * amount);
    for (const side of [0, 1]) {
      for (let i = 0; i < n; i++) {
        const angle = (side === 0 ? -1 : 1) * (0.25 + Math.random() * 0.45); // from vertical
        const speed = this.h * (1.1 + Math.random() * 0.9);
        this.pieces.push(
          this.piece(side === 0 ? -10 : this.w + 10, this.h + 10, Math.sin(angle) * speed, -Math.cos(angle) * speed),
        );
      }
    }
  }

  private piece(x: number, y: number, vx: number, vy: number): Piece {
    const ribbon = Math.random() < 0.15;
    const s = Math.min(this.w, this.h) / 90;
    return {
      x,
      y,
      vx,
      vy,
      rot: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 12,
      flip: Math.random() * Math.PI * 2,
      flipSpeed: 6 + Math.random() * 8,
      w: (ribbon ? 0.5 : 1) * s * (0.8 + Math.random() * 0.6),
      h: (ribbon ? 3.2 : 0.6) * s * (0.8 + Math.random() * 0.6),
      color: this.colors[Math.floor(Math.random() * this.colors.length)],
      ribbon,
    };
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
  }

  update(dt: number, t: number): void {
    this.resize();
    const step = Math.min(dt, 1 / 30);
    // Keep a gentle fall going for a few seconds after the burst.
    if (t > 0.6 && t < 4.5) {
      this.drizzle += step * 40 * this.amount;
      while (this.drizzle >= 1) {
        this.drizzle--;
        this.pieces.push(this.piece(Math.random() * this.w, -20, (Math.random() - 0.5) * 40, 40 + Math.random() * 60));
      }
    }
    const gravity = this.h * 1.5;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    let alive = 0;
    for (const p of this.pieces) {
      // Paper: strong air drag, falls at a slow terminal speed and flutters sideways.
      const drag = Math.exp(-2.6 * step);
      p.vx *= drag;
      p.vy = p.vy * drag + gravity * step * 0.35;
      p.x += (p.vx + Math.sin(p.flip) * 30) * step;
      p.y += p.vy * step;
      p.rot += p.spin * step;
      p.flip += p.flipSpeed * step;
      if (p.y > this.h + 40) continue;
      this.pieces[alive++] = p;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(1, Math.cos(p.flip)); // tumbling: the paper turns edge-on and back
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.cos(p.flip) > 0 ? 1 : 0.75; // the back side catches less light
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    this.pieces.length = alive;
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
