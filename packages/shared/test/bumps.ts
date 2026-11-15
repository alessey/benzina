/** Scripted two-car collisions for measuring bump response. Shared by tests. */
import { carsInContact, SimWorld, yawQuat, type Car, type CarInput, type Track } from '../src';

export interface BumpReport {
  /** Peak sideways speed of the car that was hit (m/s, relative to its heading). */
  victimLateral: number;
  /** Peak yaw rate of the car that was hit (rad/s). */
  victimSpin: number;
  /** Victim's heading change after 1 s (rad). */
  victimHeadingChange: number;
  /** Victim's forward speed change (m/s), measured 1 s after impact. */
  victimSpeedChange: number;
  /** Attacker's forward speed change (m/s), 1 s after impact. */
  attackerSpeedChange: number;
  /** Highest either car rose above ride height (m): launches. */
  maxRise: number;
  /** Did they touch at all? */
  contact: boolean;
  /** Ticks the cars stayed overlapping/touching (sticky collisions). */
  contactTicks: number;
  /** 3 s after impact: victim's yaw rate (rad/s) and tyre grip fraction. Recovered = ~0 and ~1. */
  victimYawRateLater: number;
  victimTyreLater: number;
}

const NEUTRAL: CarInput = { throttle: 0, steer: 0, handbrake: false, reset: false };

function place(car: Car, x: number, z: number, yaw: number, speed: number) {
  const q = yawQuat(yaw);
  car.setState({
    p: [x, car.body.translation().y, z],
    q: [q.x, q.y, q.z, q.w],
    v: [Math.sin(yaw) * speed, 0, Math.cos(yaw) * speed],
    w: [0, 0, 0],
    steer: 0,
    upset: 0,
  });
}

function lateralOf(car: Car): number {
  const v = car.body.linvel();
  const q = car.body.rotation();
  const yaw = 2 * Math.atan2(q.y, q.w);
  return v.x * -Math.cos(yaw) + v.z * Math.sin(yaw);
}

/**
 * Run a scripted bump on a long straight far from walls. The world is the real SimWorld (so the
 * track exists), but we place the cars in open space beside it where there are no walls.
 */
export function bump(
  track: Track,
  kind: 'sideswipe' | 'rear-end' | 't-bone' | 'pit',
  tuning?: SimWorld['tuning'],
  /** PIT only: attacker's speed advantage over the victim (m/s). */
  closingSpeed = 8,
): BumpReport {
  const sim = new SimWorld(track, tuning ? { ...tuning } : undefined);
  const attacker = sim.addCar('1', 0);
  const victim = sim.addCar('2', 1);
  // Open grass well outside the circuit: no walls to interfere.
  const X = -300;
  const Z = -300;
  let attackerInput: (t: number) => CarInput;
  let victimInput: (t: number) => CarInput;
  if (kind === 'sideswipe') {
    place(victim, X, Z, 0, 35);
    place(attacker, X - 2.6, Z, 0, 35);
    // Attacker swerves into the victim for 0.3 s, then straightens.
    // (The victim is on the attacker's left: right is -X when heading +Z.)
    attackerInput = (t) => ({ ...NEUTRAL, throttle: 1, steer: t < 18 ? -1 : 0 });
    victimInput = () => ({ ...NEUTRAL, throttle: 1 });
  } else if (kind === 'rear-end') {
    place(victim, X, Z, 0, 20);
    place(attacker, X, Z - 12, 0, 40);
    attackerInput = () => ({ ...NEUTRAL, throttle: 1 });
    victimInput = () => ({ ...NEUTRAL, throttle: 0.4 });
  } else if (kind === 'pit') {
    // Attacker's front-right corner catches the victim's rear-left quarter.
    place(victim, X, Z, 0, 28);
    place(attacker, X - 1.6, Z - 6, 0, 28 + closingSpeed);
    attackerInput = (t) => ({ ...NEUTRAL, throttle: 1, steer: t < 40 ? -0.15 : 0 });
    victimInput = () => ({ ...NEUTRAL, throttle: 0.3 });
  } else {
    place(victim, X, Z, 0, 0);
    place(attacker, X - 14, Z, Math.PI / 2, 30);
    attackerInput = () => ({ ...NEUTRAL, throttle: 1 });
    victimInput = () => NEUTRAL;
  }

  const rideY = victim.body.translation().y;
  let impactTick = -1;
  let contactTicks = 0;
  let victimSpeedAtImpact = 0;
  let attackerSpeedAtImpact = 0;
  let headingAtImpact = 0;
  const report: BumpReport = {
    victimLateral: 0,
    victimSpin: 0,
    victimHeadingChange: 0,
    victimSpeedChange: 0,
    attackerSpeedChange: 0,
    maxRise: 0,
    contact: false,
    contactTicks: 0,
    victimYawRateLater: 0,
    victimTyreLater: 1,
  };
  const yawOfCar = (c: Car) => 2 * Math.atan2(c.body.rotation().y, c.body.rotation().w);

  for (let t = 0; t < 300; t++) {
    const before = { v: victim.forwardSpeed(), a: attacker.forwardSpeed(), h: yawOfCar(victim) };
    sim.step(
      new Map([
        ['1', attackerInput(t)],
        ['2', victimInput(t)],
      ]),
    );
    const touching = carsInContact(attacker, victim);
    if (touching) {
      contactTicks++;
      if (impactTick < 0) {
        impactTick = t;
        victimSpeedAtImpact = before.v;
        attackerSpeedAtImpact = before.a;
        headingAtImpact = before.h;
      }
    }
    if (impactTick >= 0 && t - impactTick <= 60) {
      report.victimLateral = Math.max(report.victimLateral, Math.abs(lateralOf(victim)));
      report.victimSpin = Math.max(report.victimSpin, Math.abs(victim.body.angvel().y));
      if (t - impactTick === 60) {
        report.victimSpeedChange = victim.forwardSpeed() - victimSpeedAtImpact;
        report.attackerSpeedChange = attacker.forwardSpeed() - attackerSpeedAtImpact;
        const dh = yawOfCar(victim) - headingAtImpact;
        report.victimHeadingChange = Math.abs(Math.atan2(Math.sin(dh), Math.cos(dh)));
      }
    }
    if (impactTick >= 0 && t - impactTick === 180) {
      report.victimYawRateLater = Math.abs(victim.body.angvel().y);
      report.victimTyreLater = victim.tyre;
    }
    for (const c of [attacker, victim]) report.maxRise = Math.max(report.maxRise, c.body.translation().y - rideY);
  }
  report.contact = impactTick >= 0;
  report.contactTicks = contactTicks;
  sim.free();
  return report;
}
