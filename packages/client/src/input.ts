import type { CarInput } from '@benzina/shared';
import { TouchControls } from './touchControls';

const DEADZONE = 0.12;

function deadzone(v: number): number {
  return Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE);
}

/** True on phones/tablets: the primary pointer is a finger. */
export const IS_TOUCH_DEVICE =
  typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;

/**
 * Merges keyboard, the first connected gamepad and on-screen touch controls into one
 * CarInput per tick. For each axis the strongest source wins.
 */
export class InputManager {
  readonly touch = new TouchControls();
  private keys = new Set<string>();
  private resetLatched = false;
  private padResetHeld = false;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyR' && !e.repeat) this.resetLatched = true;
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    if (IS_TOUCH_DEVICE) this.touch.show();
    // Touchscreen laptops etc.: show touch controls the first time someone touches the screen.
    window.addEventListener('touchstart', () => this.touch.show(), { once: true, passive: true });
  }

  private down(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  /** Read the controls for one tick. Reset is edge-triggered and consumed here. */
  sample(): CarInput {
    let throttle = (this.down('KeyW', 'ArrowUp') ? 1 : 0) - (this.down('KeyS', 'ArrowDown') ? 1 : 0);
    let steer = (this.down('KeyD', 'ArrowRight') ? 1 : 0) - (this.down('KeyA', 'ArrowLeft') ? 1 : 0);
    let handbrake = this.down('Space');

    const strongest = (a: number, b: number) => (Math.abs(b) > Math.abs(a) ? b : a);

    if (this.touch.visible) {
      const t = this.touch.state();
      throttle = strongest(throttle, t.throttle);
      steer = strongest(steer, t.steer);
      handbrake ||= t.handbrake;
      if (this.touch.takeReset()) this.resetLatched = true;
    }

    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    if (pad && pad.mapping === 'standard') {
      throttle = strongest(throttle, (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0));
      steer = strongest(steer, deadzone(pad.axes[0] ?? 0));
      handbrake ||= pad.buttons[0]?.pressed ?? false;
      const resetPressed = pad.buttons[3]?.pressed ?? false;
      if (resetPressed && !this.padResetHeld) this.resetLatched = true;
      this.padResetHeld = resetPressed;
    }

    const reset = this.resetLatched;
    this.resetLatched = false;
    return { throttle, steer, handbrake, reset };
  }
}
