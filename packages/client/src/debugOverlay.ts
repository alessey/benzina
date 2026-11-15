import * as THREE from 'three';
import { CAR_SHAPE, type Correction, type Snapshot } from '@benzina/shared';
import type { NetStats } from './net/connection';

export interface DebugInfo {
  mode: string;
  room?: string;
  players: number;
  stats?: NetStats;
  serverBuffered?: number;
  timeScale: number;
  pending?: number;
  fps: number;
}

/**
 * Netcode diagnostics: connection stats, correction sizes, and wireframe "ghosts" showing
 * exactly where the server's latest snapshot put each car. Toggle with ` (backquote) or F3.
 */
export class DebugOverlay {
  private readonly el: HTMLDivElement;
  private readonly ghosts = new Map<number, THREE.LineSegments>();
  private readonly ghostGeo: THREE.EdgesGeometry;
  private readonly ghostMat = new THREE.LineBasicMaterial({ color: 0x00ffaa, depthTest: false });
  private visible: boolean;
  private lastText = 0;
  /** Largest correction seen in the current 1 s window (local car / remote cars), metres. */
  private maxLocal = 0;
  private maxRemote = 0;
  private shownLocal = 0;
  private shownRemote = 0;
  private windowStart = performance.now();

  constructor(
    private readonly scene: THREE.Scene,
    initiallyVisible: boolean,
  ) {
    this.visible = initiallyVisible;
    this.el = document.createElement('div');
    this.el.id = 'debug';
    this.el.hidden = !initiallyVisible;
    document.body.appendChild(this.el);
    const w = CAR_SHAPE.halfWidth + CAR_SHAPE.borderRadius;
    const h = CAR_SHAPE.halfHeight + CAR_SHAPE.borderRadius;
    const l = CAR_SHAPE.halfLength + CAR_SHAPE.borderRadius;
    this.ghostGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(w * 2, h * 2, l * 2));
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Backquote' || e.code === 'F3') {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.hidden = !this.visible;
    for (const g of this.ghosts.values()) g.visible = this.visible;
  }

  recordCorrections(corrections: Correction[], localId: string | null): void {
    for (const c of corrections) {
      const d = Math.hypot(c.before.p[0] - c.after.p[0], c.before.p[1] - c.after.p[1], c.before.p[2] - c.after.p[2]);
      if (c.id === localId) this.maxLocal = Math.max(this.maxLocal, d);
      else this.maxRemote = Math.max(this.maxRemote, d);
    }
  }

  updateGhosts(snap: Snapshot | null): void {
    if (!snap) return;
    const seen = new Set<number>();
    for (const c of snap.cars) {
      seen.add(c.id);
      let g = this.ghosts.get(c.id);
      if (!g) {
        g = new THREE.LineSegments(this.ghostGeo, this.ghostMat);
        g.renderOrder = 5;
        g.visible = this.visible;
        this.scene.add(g);
        this.ghosts.set(c.id, g);
      }
      g.position.set(c.state.p[0], c.state.p[1], c.state.p[2]);
      g.quaternion.set(c.state.q[0], c.state.q[1], c.state.q[2], c.state.q[3]);
    }
    for (const [id, g] of this.ghosts) {
      if (seen.has(id)) continue;
      this.scene.remove(g);
      this.ghosts.delete(id);
    }
  }

  update(info: DebugInfo): void {
    const now = performance.now();
    if (now - this.windowStart >= 1000) {
      this.shownLocal = this.maxLocal;
      this.shownRemote = this.maxRemote;
      this.maxLocal = this.maxRemote = 0;
      this.windowStart = now;
    }
    if (!this.visible || now - this.lastText < 250) return;
    this.lastText = now;
    const s = info.stats;
    const lines = [
      `mode       ${info.mode}${info.room ? `  room ${info.room}` : ''}`,
      `players    ${info.players}`,
      `fps        ${info.fps.toFixed(0)}`,
    ];
    if (s) {
      lines.push(
        `rtt        ${s.rttMs.toFixed(0)} ms`,
        `snapshots  ${s.snapshotsPerSec.toFixed(1)} /s`,
        `down       ${(s.bytesInPerSec / 1024).toFixed(1)} KB/s`,
        `up         ${(s.bytesOutPerSec / 1024).toFixed(1)} KB/s`,
        `srv buffer ${info.serverBuffered ?? '-'} inputs`,
        `pending    ${info.pending ?? '-'} inputs`,
        `timescale  ${info.timeScale.toFixed(3)}`,
        `correct.   local ${(this.shownLocal * 100).toFixed(1)} cm  remote ${(this.shownRemote * 100).toFixed(1)} cm`,
        `ghosts     green boxes = raw server state`,
      );
    }
    this.el.textContent = lines.join('\n');
  }
}
