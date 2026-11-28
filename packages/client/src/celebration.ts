import * as THREE from 'three';
import type { RacerStanding } from '@benzina/shared';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { formatTime } from './lapTimer';

/** How long the celebration stays up before shrinking back to the small banner, seconds. */
const DURATION = 7;
/** When the race ends early (everyone else finished), cut the celebration to this length. */
const SHORT_DURATION = 4.5;
const FADE = 0.6;

/** Trophy metal (tinted towards mirror chrome) and headline for each podium place. */
const PODIUM = [
  { metal: 0xffc93c, label: 'WINNER!' },
  { metal: 0xd9dde3, label: '2ND PLACE' },
  { metal: 0xc77b3f, label: '3RD PLACE' },
];

const NEON = ['#ff2bd6', '#00f0ff', '#fff200', '#ff7a00', '#b14bff'];

export interface FinishInfo {
  position: number;
  racers: number;
  finishTime: number | null;
  /** Seconds behind the winner (null when we won). */
  gap: number | null;
  /** Our car colour, mixed into the confetti. */
  carColor: number;
  /** Our best lap, when it's the fastest of the race so far. */
  fastestLap: number | null;
}

/**
 * 80s synthwave finish celebration with a turbo-era F1 flavour, over CRT scanlines. The podium
 * gets a spinning chrome trophy with neon rings (gold, silver, bronze) and chrome lettering;
 * 1st and 2nd also get a striped sunset over a neon grid, and the winner gets a laurel wreath
 * and Memphis-style confetti. Off the podium it's the place and time on a
 * neon panel. Everyone gets a dot-matrix timing tower, and a purple sign for the fastest lap.
 */
export class Celebration {
  private readonly root: HTMLDivElement;
  private readonly fx: FxCanvas;
  private readonly trophyCanvas: HTMLCanvasElement;
  private readonly text: HTMLDivElement;
  private readonly tower: HTMLDivElement;
  private towerKey = '';
  private trophy: TrophyView | null = null;
  private confetti: Confetti | null = null;
  private time = -1;
  private end = DURATION;
  private podium = false;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'celebration';
    this.root.hidden = true;
    this.root.innerHTML = `<div class="scanlines"></div><div class="sunset"><div class="sun"></div><div class="grid"></div></div>
      <div class="wreath"></div><canvas class="trophy"></canvas><div class="cele-text"></div>
      <div class="tower"></div><canvas class="fx"></canvas>`;
    document.body.appendChild(this.root);
    this.fx = new FxCanvas(this.root.querySelector('canvas.fx')!);
    this.trophyCanvas = this.root.querySelector('canvas.trophy')!;
    this.text = this.root.querySelector('.cele-text')!;
    this.tower = this.root.querySelector('.tower')!;
  }

  get active(): boolean {
    return this.time >= 0;
  }

  start(info: FinishInfo): void {
    const place = PODIUM[info.position - 1];
    this.podium = !!place;
    this.time = 0;
    this.end = DURATION;
    this.root.hidden = false;
    this.root.style.opacity = '1';
    this.root.className = `${this.podium ? `podium p${info.position}` : 'finisher'}${info.position <= 2 ? ' stage' : ''}${info.position === 1 ? ' winner' : ''}`;

    const time = info.finishTime !== null ? formatTime(info.finishTime) : '';
    const gap = info.gap !== null ? `+${info.gap.toFixed(3)}s` : '';
    const headline = place ? place.label : `${ordinal(info.position).toUpperCase()} PLACE`;
    this.text.innerHTML = `<div class="headline">${headline}</div>
      <div class="sub">${ordinal(info.position)} of ${info.racers}${time ? ` · ${time}` : ''}${gap ? ` · <span class="gap">${gap}</span>` : ''}</div>
      ${info.fastestLap !== null ? `<div class="fastest">FASTEST LAP <b>${formatTime(info.fastestLap)}</b></div>` : ''}`;
    this.tower.innerHTML = '';
    this.towerKey = '';
    // A fresh wreath replays the leaf-by-leaf growth.
    this.root.querySelector('.wreath')!.innerHTML = info.position === 1 ? wreathSvg() : '';
    // Restart the CSS entrance animations.
    for (const el of this.root.querySelectorAll<HTMLElement>('.cele-text, .sunset, .cele-text .sub, .tower')) {
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    }

    if (place) {
      this.trophy ??= new TrophyView(this.trophyCanvas);
      this.trophy.show(place.metal, info.position);
    }
    // Confetti is for the winner only.
    this.confetti = info.position === 1 ? new Confetti([...NEON, `#${info.carColor.toString(16).padStart(6, '0')}`]) : null;
  }

  /** Wrap up sooner (the results card is waiting), but not before a short celebration has played. */
  hurry(): void {
    this.end = Math.min(this.end, Math.max(SHORT_DURATION, this.time + FADE));
  }

  stop(): void {
    if (this.time < 0) return;
    this.time = -1;
    this.root.hidden = true;
    this.fx.clear();
    this.confetti = null;
  }

  /**
   * Fill the timing tower from the live standings (call every frame while active: it only
   * touches the DOM when something changes, e.g. another car crosses the line).
   */
  setStandings(standings: readonly RacerStanding[], nameOf: (id: string) => string, localId: string | null, laps: number): void {
    if (this.time < 0) return;
    const leader = standings.find((s) => s.position === 1)?.finishTime ?? null;
    const laps_ = standings.map((s) => s.bestLap).filter((l): l is number => l !== null);
    const fastest = laps_.length ? Math.min(...laps_) : null;
    const rows = standings.map((s) => {
      const status = s.dnf
        ? 'DNF'
        : s.finishTime === null
          ? `LAP ${Math.min(laps, s.lapsDone + 1)}`
          : s.position === 1 || leader === null
            ? formatTime(s.finishTime)
            : `+${(s.finishTime - leader).toFixed(3)}`;
      const name = nameOf(s.id).toUpperCase().slice(0, 9);
      const cls = `${s.id === localId ? 'me' : ''} ${s.bestLap !== null && s.bestLap === fastest ? 'fl' : ''}`;
      return `<li class="${cls}"><span class="pos">${s.position}</span><span class="name">${escapeHtml(name)}</span><span class="status">${status}</span></li>`;
    });
    const key = rows.join('');
    if (key === this.towerKey) return;
    // Rows type in one by one the first time; later changes just update.
    const live = this.towerKey !== '';
    this.towerKey = key;
    this.tower.innerHTML = `<div class="tower-head">CLASSIFICATION</div><ol class="${live ? 'live' : ''}">${rows
      .map((r, i) => r.replace('<li ', `<li style="--i:${i}" `))
      .join('')}</ol>`;
  }

  update(dt: number): void {
    if (this.time < 0) return;
    this.time += dt;
    if (this.time >= this.end) {
      this.stop();
      return;
    }
    this.root.style.opacity = String(Math.min(1, (this.end - this.time) / FADE));
    if (this.podium) this.trophy?.render(this.time);
    if (this.confetti) this.confetti.update(this.fx.begin(), dt, this.time, this.fx.w, this.fx.h);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Laurel wreath, as worn on 80s podiums: two neon-green branches of leaf pairs curving up
 * from a pink ribbon. Each leaf has its own animation delay so the wreath grows in.
 */
function wreathSvg(): string {
  const R = 82;
  const n = 11;
  const deg = Math.PI / 180;
  const leaves: string[] = [];
  let k = 0;
  for (const mirror of [false, true]) {
    for (let i = 0; i < n; i++) {
      // The left branch runs from just left of the bottom (100°) round to the top left (240°),
      // in SVG angles (y down); the right branch mirrors it.
      const a = (100 + (i / (n - 1)) * 140) * deg;
      const size = 1 - (i / n) * 0.45;
      // Leaves point along the branch, one leaning out and one in.
      const along = Math.atan2(Math.cos(a), -Math.sin(a)) / deg - 90;
      for (const [off, lean] of [[6, -35], [-6, 35]]) {
        let x = (R + off) * Math.cos(a);
        const y = (R + off) * Math.sin(a);
        let rot = along + lean;
        if (mirror) {
          x = -x;
          rot = -rot;
        }
        // Placed by the group, so the leaf's own grow animation scales it about its centre.
        leaves.push(
          `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(1)})"><ellipse class="leaf" style="animation-delay:${(0.25 + (k++ % (n * 2)) * 0.035).toFixed(3)}s" rx="${(4.6 * size).toFixed(1)}" ry="${(12 * size).toFixed(1)}"/></g>`,
        );
      }
    }
  }
  const p0 = [R * Math.cos(100 * deg), R * Math.sin(100 * deg)].map((v) => v.toFixed(1));
  const p1 = [R * Math.cos(240 * deg), R * Math.sin(240 * deg)].map((v) => v.toFixed(1));
  return `<svg viewBox="-110 -110 220 220" aria-hidden="true">
    <defs><linearGradient id="leafg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d8ff9a"/><stop offset="1" stop-color="#1fae5a"/></linearGradient></defs>
    <path class="stem" d="M ${p0[0]} ${p0[1]} A ${R} ${R} 0 0 1 ${p1[0]} ${p1[1]}"/>
    <path class="stem" d="M ${-p0[0]} ${p0[1]} A ${R} ${R} 0 0 0 ${-p1[0]} ${p1[1]}"/>
    <g fill="url(#leafg)">${leaves.join('')}</g>
    <path class="ribbon" d="M -6 ${R - 4} L -30 ${R + 24} L -20 ${R + 21} L -16 ${R + 30} L 2 ${R + 4} Z M 6 ${R - 4} L 30 ${R + 24} L 20 ${R + 21} L 16 ${R + 30} L -2 ${R + 4} Z"/>
    <circle class="ribbon" cx="0" cy="${R - 1}" r="8"/>
  </svg>`;
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
  private readonly metal = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.06 });
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
    // Dim studio reflections, so the magenta and cyan lights show in the chrome.
    this.scene.environmentIntensity = 0.45;

    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(3, 5, 4);
    const pink = new THREE.DirectionalLight(0xff2bd6, 4);
    pink.position.set(-4, 1, 2);
    const cyan = new THREE.DirectionalLight(0x00f0ff, 4);
    cyan.position.set(4, 0.5, 1);
    this.scene.add(key, pink, cyan, new THREE.AmbientLight(0xffffff, 0.3));
    this.camera.position.set(0, 1.6, 7.2);
    this.camera.lookAt(0, 1.35, 0);

    // Cup, stem and foot turned on a lathe (x = radius, y = height).
    const profile = [
      [0, 0.62], [0.42, 0.62], [0.46, 0.7], [0.2, 0.8], [0.11, 0.95], [0.1, 1.15], [0.2, 1.22], [0.12, 1.32],
      [0.14, 1.45], [0.38, 1.6], [0.62, 1.9], [0.78, 2.3], [0.84, 2.62], [0.9, 2.7], [0.86, 2.72], [0.78, 2.66],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const cup = new THREE.Mesh(new THREE.LatheGeometry(profile, 48), this.metal);
    this.group.add(cup);
    // Neon tubes: rings round the cup and strips round the plinth.
    const tube = (color: number) => new THREE.MeshBasicMaterial({ color, toneMapped: false });
    const neonCyan = tube(0x00f0ff);
    const neonPink = tube(0xff2bd6);
    const neon = new THREE.Group();
    for (const [y, r, t] of [[2.71, 0.9, 0.035], [2.3, 0.8, 0.028], [1.62, 0.41, 0.025], [1.22, 0.21, 0.025]]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r + 0.01, t, 8, 64), neonCyan);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      neon.add(ring);
    }
    for (const y of [0.04, 0.6]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.05, 1.3), neonPink);
      strip.position.y = y;
      neon.add(strip);
    }
    this.group.add(neon);
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
    // Mirror chrome, tinted by the place.
    this.metal.color.setHex(color).lerp(new THREE.Color(0xffffff), 0.35);
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

/** Full-screen 2D canvas for the confetti, at device resolution. */
class FxCanvas {
  readonly ctx: CanvasRenderingContext2D;
  w = 0;
  h = 0;
  private dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** Resize if needed and clear; returns the context in CSS pixels. */
  begin(): CanvasRenderingContext2D {
    this.dpr = Math.min(window.devicePixelRatio, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.canvas.width = w * this.dpr;
      this.canvas.height = h * this.dpr;
    }
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
    return this.ctx;
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
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
  /** Size, px. */
  r: number;
  color: string;
  /** Memphis shapes: 0 triangle, 1 ring, 2 squiggle, 3 square. */
  shape: number;
}

/**
 * 80s Memphis-pattern confetti (triangles, rings, squiggles, squares) fired from cannons in
 * both bottom corners, then a light drizzle from the top.
 */
class Confetti {
  private readonly pieces: Piece[] = [];
  private fired = false;
  private due = 0;

  constructor(private readonly colors: string[]) {}

  private add(x: number, y: number, vx: number, vy: number, w: number, h: number): void {
    const s = Math.min(w, h) / 90;
    this.pieces.push({
      x,
      y,
      vx,
      vy,
      rot: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 12,
      flip: Math.random() * Math.PI * 2,
      flipSpeed: 6 + Math.random() * 8,
      r: s * (0.8 + Math.random() * 0.6),
      color: this.colors[Math.floor(Math.random() * this.colors.length)],
      shape: Math.floor(Math.random() * 4),
    });
  }

  update(ctx: CanvasRenderingContext2D, dt: number, t: number, w: number, h: number): void {
    const step = Math.min(dt, 1 / 30);
    if (!this.fired) {
      // Fired on the first frame, once the canvas knows the screen size.
      this.fired = true;
      for (const side of [-1, 1]) {
        for (let i = 0; i < 160; i++) {
          const angle = side * (0.25 + Math.random() * 0.45); // from vertical
          const speed = h * (1.1 + Math.random() * 0.9);
          this.add(side < 0 ? -10 : w + 10, h + 10, Math.sin(angle) * speed, -Math.cos(angle) * speed, w, h);
        }
      }
    }
    // Keep a gentle fall going for a few seconds after the burst.
    if (t > 0.6 && t < 4.5) {
      this.due += step * 40;
      for (; this.due >= 1; this.due--) this.add(Math.random() * w, -20, (Math.random() - 0.5) * 40, 40 + Math.random() * 60, w, h);
    }
    const gravity = h * 1.5;
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
      if (p.y > h + 40) continue;
      this.pieces[alive++] = p;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(1, Math.cos(p.flip)); // tumbling: the paper turns edge-on and back
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.cos(p.flip) > 0 ? 1 : 0.75; // the back side catches less light
      drawMemphis(ctx, p);
      ctx.restore();
    }
    this.pieces.length = alive;
  }
}

function drawMemphis(ctx: CanvasRenderingContext2D, p: Piece): void {
  const r = p.r;
  ctx.strokeStyle = p.color;
  ctx.lineWidth = Math.max(1.5, r * 0.32);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  switch (p.shape) {
    case 0:
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.87, r * 0.5);
      ctx.lineTo(-r * 0.87, r * 0.5);
      ctx.closePath();
      ctx.fill();
      break;
    case 1:
      ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 2:
      ctx.moveTo(-r * 1.4, 0);
      for (let i = 1; i <= 4; i++) ctx.lineTo(-r * 1.4 + i * r * 0.7, i % 2 ? -r * 0.45 : r * 0.45);
      ctx.stroke();
      break;
    default:
      ctx.fillRect(-r * 0.6, -r * 0.6, r * 1.2, r * 1.2);
  }
}
