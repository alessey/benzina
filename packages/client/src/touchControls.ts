/**
 * On-screen controls for phones and tablets.
 *
 *  - Left half: drag horizontally anywhere to steer (analog). The steering origin is where
 *    your thumb lands, so there's no fixed joystick to find.
 *  - Right side: GAS and BRAKE pedals, DRIFT (handbrake) above them.
 *  - Small reset button at the top.
 *
 * Built on pointer events with pointer capture, so multi-touch works (steer + gas + drift).
 */

export interface TouchState {
  throttle: number;
  steer: number;
  handbrake: boolean;
}

/** Thumb travel (px) for full steering lock. Scaled down on small screens. */
function steerRange(): number {
  return Math.max(45, Math.min(90, window.innerWidth * 0.09, window.innerWidth * 0.44 * 0.4));
}

export class TouchControls {
  readonly root: HTMLDivElement;
  private steer = 0;
  private steerPointer: number | null = null;
  private steerOriginX = 0;
  /** Thumb origin relative to the (on-screen-clamped) steering pill's centre. */
  private knobOffset = 0;
  private readonly held = { gas: new Set<number>(), brake: new Set<number>(), drift: new Set<number>() };
  private resetLatched = false;
  private readonly knob: HTMLDivElement;
  private readonly base: HTMLDivElement;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'touch';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="steer-zone"><div class="steer-base"><div class="steer-knob"></div></div>
        <div class="steer-hint">drag to steer</div></div>
      <button class="pedal drift" data-key="drift">DRIFT</button>
      <button class="pedal brake" data-key="brake">BRAKE</button>
      <button class="pedal gas" data-key="gas">GAS</button>
      <button class="mini reset" aria-label="Reset car">↺</button>
    `;
    document.body.appendChild(this.root);
    this.knob = this.root.querySelector('.steer-knob')!;
    this.base = this.root.querySelector('.steer-base')!;

    this.bindSteering(this.root.querySelector('.steer-zone')!);
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('.pedal')) {
      this.bindPedal(btn, this.held[btn.dataset.key as keyof typeof this.held]);
    }
    this.root.querySelector('.reset')!.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.resetLatched = true;
      buzz();
    });
  }

  show(): void {
    this.root.hidden = false;
    document.body.classList.add('touch');
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  state(): TouchState {
    const gas = this.held.gas.size > 0;
    const brake = this.held.brake.size > 0;
    return {
      throttle: (gas ? 1 : 0) - (brake ? 1 : 0),
      steer: this.steer,
      handbrake: this.held.drift.size > 0,
    };
  }

  /** Edge-triggered reset, consumed on read. */
  takeReset(): boolean {
    const r = this.resetLatched;
    this.resetLatched = false;
    return r;
  }

  private bindSteering(zone: HTMLElement): void {
    zone.addEventListener('pointerdown', (e) => {
      if (this.steerPointer !== null) return;
      e.preventDefault();
      zone.setPointerCapture(e.pointerId);
      this.steerPointer = e.pointerId;
      this.steerOriginX = e.clientX;
      this.steer = 0;
      // Keep the pill fully on-screen; the knob still starts under the thumb.
      const half = this.base.offsetWidth / 2 || 100;
      const centre = Math.max(half + 4, Math.min(window.innerWidth - half - 4, e.clientX));
      this.knobOffset = e.clientX - centre;
      this.base.style.left = `${centre}px`;
      this.base.style.top = `${e.clientY}px`;
      this.base.classList.add('active');
      zone.classList.add('used');
      this.updateKnob();
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.steerPointer) return;
      this.steer = Math.max(-1, Math.min(1, (e.clientX - this.steerOriginX) / steerRange()));
      this.updateKnob();
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.steerPointer) return;
      this.steerPointer = null;
      this.steer = 0;
      this.base.classList.remove('active');
      this.updateKnob();
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  }

  private updateKnob(): void {
    this.knob.style.transform = `translateX(${this.knobOffset + this.steer * steerRange()}px)`;
  }

  private bindPedal(btn: HTMLButtonElement, held: Set<number>): void {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      held.add(e.pointerId);
      btn.classList.add('down');
      buzz();
    });
    const end = (e: PointerEvent) => {
      held.delete(e.pointerId);
      if (held.size === 0) btn.classList.remove('down');
    };
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointercancel', end);
    btn.addEventListener('lostpointercapture', end);
  }
}

/** Tiny haptic tick where supported (Android); silently ignored elsewhere. */
function buzz(): void {
  try {
    navigator.vibrate?.(8);
  } catch {
    // Not supported.
  }
}
