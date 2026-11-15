import type { CarInput } from '@benzina/shared';

const DEADZONE = 0.12;

function deadzone(v: number): number {
  return Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE);
}

/** Merges keyboard and the first connected gamepad into a single CarInput per tick. */
export class InputManager {
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
  }

  private down(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  /** Read the controls for one tick. Reset is edge-triggered and consumed here. */
  sample(): CarInput {
    let throttle = (this.down('KeyW', 'ArrowUp') ? 1 : 0) - (this.down('KeyS', 'ArrowDown') ? 1 : 0);
    let steer = (this.down('KeyD', 'ArrowRight') ? 1 : 0) - (this.down('KeyA', 'ArrowLeft') ? 1 : 0);
    let handbrake = this.down('Space');

    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    if (pad && pad.mapping === 'standard') {
      const padThrottle = (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
      const padSteer = deadzone(pad.axes[0] ?? 0);
      if (Math.abs(padThrottle) > Math.abs(throttle)) throttle = padThrottle;
      if (Math.abs(padSteer) > Math.abs(steer)) steer = padSteer;
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
