/**
 * One tick of player controls. This is the only thing a client will send to the server,
 * so keep it small and fully deterministic.
 */
export interface CarInput {
  /** -1..1. Positive accelerates; negative brakes, then reverses once stopped. */
  throttle: number;
  /** -1..1. Positive steers right. */
  steer: number;
  handbrake: boolean;
  /** Put the car back on the track centre line. */
  reset: boolean;
}

export const NEUTRAL_INPUT: Readonly<CarInput> = Object.freeze({
  throttle: 0,
  steer: 0,
  handbrake: false,
  reset: false,
});
