/** Fixed simulation rate. Client and server both step the world at exactly this rate. */
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

/**
 * Arcade handling parameters. Everything that affects the simulation lives here so the
 * client and server always agree (and so the dev tuning panel can tweak it live).
 */
export interface CarTuning {
  /** Downward gravity, m/s². Higher than real life keeps cars planted and snappy. */
  gravity: number;
  /** Top forward speed, m/s. */
  maxSpeed: number;
  /** Forward acceleration from standstill, m/s². Tapers toward zero at maxSpeed. */
  accel: number;
  /** Deceleration when braking while moving forward, m/s². */
  brakeDecel: number;
  reverseAccel: number;
  maxReverseSpeed: number;
  /** Coasting deceleration with no throttle, m/s². */
  rollDrag: number;
  /** How quickly sideways velocity is killed (1/s). Higher = more grip. */
  grip: number;
  /** Sideways grip while the handbrake is held; low values let the car drift. */
  driftGrip: number;
  /** Extra deceleration while the handbrake is held, m/s². */
  handbrakeDecel: number;
  /** Maximum yaw rate at full steering lock, rad/s. */
  maxYawRate: number;
  /** Speed (m/s) at which steering reaches full authority. Below this you can't spin in place. */
  steerFullSpeed: number;
  /** Fraction of steering authority left at top speed. */
  highSpeedSteer: number;
  /** Yaw-rate multiplier while drifting on the handbrake. */
  handbrakeYawBoost: number;
  /** How fast the steering input moves toward the target (1/s). Smooths keyboard input. */
  steerSpeed: number;
  /** How fast the actual yaw rate converges on the target (1/s). Lower = collisions spin you more. */
  yawResponse: number;
  /** Hover suspension spring, as acceleration per metre of compression (1/s²). */
  suspensionStiffness: number;
  /** Hover suspension damping (1/s). ~2·√stiffness is critically damped. */
  suspensionDamping: number;
  /**
   * Distance behind the car's centre that it turns around (≈ rear axle), metres. Real cars
   * pivot near the rear axle, so the tail doesn't swing out; 0 pivots around the centre.
   */
  pivotOffset: number;
  /** Deceleration while scraping a wall, m/s². */
  wallFriction: number;
  /** How strongly a car pointed into a wall is turned parallel to it (rad/s per unit). */
  wallDeflect: number;
  /** Sideways speed away from a wall when touching it and steering away, m/s (at full lock). */
  wallPushOff: number;
  /** Touching cars always separate at least this fast (m/s), so bumps shove instead of grind. */
  bumpSeparation: number;
  /** How strongly a car pointed into another car is turned parallel to it (rad/s per unit). */
  bumpDeflect: number;
  /**
   * Spin from off-centre hits, as a fraction of the physically correct amount (1 = physical).
   * A tap on the rear quarter turns a car; a centred rear-end hit doesn't.
   */
  bumpSpin: number;
  /** Tyre saturation (applies only while a car is upset by a hit). Slip angle (rad) of full grip. */
  tireSlipPeak: number;
  /** Slip angle (rad) at which tyres are fully sliding. */
  tireSlipFull: number;
  /** Fraction of grip and steering authority left when fully sliding. */
  tireSlideGrip: number;
}

export const DEFAULT_TUNING: CarTuning = {
  gravity: 25,
  maxSpeed: 45,
  accel: 22,
  brakeDecel: 40,
  reverseAccel: 12,
  maxReverseSpeed: 12,
  rollDrag: 4,
  grip: 8,
  driftGrip: 1.2,
  handbrakeDecel: 6,
  maxYawRate: 2.4,
  steerFullSpeed: 6,
  highSpeedSteer: 0.55,
  handbrakeYawBoost: 1.5,
  steerSpeed: 6,
  yawResponse: 12,
  suspensionStiffness: 300,
  suspensionDamping: 32,
  pivotOffset: 1.2,
  wallFriction: 14,
  wallDeflect: 6,
  wallPushOff: 3,
  bumpSeparation: 3,
  bumpDeflect: 4,
  bumpSpin: 2,
  tireSlipPeak: 0.1,
  tireSlipFull: 0.35,
  tireSlideGrip: 0.15,
};

/** Car collision box, metres. Collider is a rounded cuboid: half extents + border radius. */
export const CAR_SHAPE = {
  halfWidth: 0.85,
  halfHeight: 0.3,
  halfLength: 1.85,
  borderRadius: 0.15,
  /** Gives a car a mass of roughly 1000 kg. */
  density: 140,
} as const;

/** Distance from the car's centre to the bottom of its collider. */
export const CAR_HALF_HEIGHT = CAR_SHAPE.halfHeight + CAR_SHAPE.borderRadius;

/**
 * Cars hover: a raycast spring holds the collider this far above the road, so normal driving
 * never touches Rapier's contact solver. Contact state is history-dependent and can't be
 * restored from a snapshot; the spring depends only on position and velocity, so client
 * re-simulation matches the server.
 */
export const HOVER_CLEARANCE = 0.12;

/** Height of the car's centre above flat ground at rest. */
export const CAR_RIDE_HEIGHT = CAR_HALF_HEIGHT + HOVER_CLEARANCE;

/** Extra ray length below rest height: how far the road can drop away before the car is airborne. */
export const SUSPENSION_TRAVEL = 0.4;
