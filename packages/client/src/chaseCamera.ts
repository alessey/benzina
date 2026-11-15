import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const DISTANCE = 9;
const HEIGHT = 3.4;
const LOOK_AHEAD = 4;
const BASE_FOV = 65;
const SPEED_FOV = 15;
/** Keep at least this much horizontal view, so portrait phones aren't looking through a slit. */
const MIN_HORIZONTAL_FOV = 75;
const MAX_FOV = 100;

/** Vertical FOV (degrees) for the current aspect ratio. */
function baseFov(aspect: number): number {
  const rad = THREE.MathUtils.degToRad;
  const needed = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(rad(MIN_HORIZONTAL_FOV) / 2) / aspect));
  return Math.min(MAX_FOV, Math.max(BASE_FOV, needed));
}

/** Third-person camera that trails the car with exponential smoothing. */
export class ChaseCamera {
  private readonly pos = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private initialised = false;
  /** Orbit around the car (lobby): yaw from behind, and extra elevation. Ease back when released. */
  private yaw = 0;
  private tilt = 0;
  /** Vertical framing shift (fraction of screen height, + = car lower on screen). */
  private shift = 0;

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  /**
   * Spin the camera around the car. `active` false eases it back behind the car.
   * @param yawInput -1..1 (right = clockwise from above), tiltInput -1..1 (up = higher)
   */
  orbit(active: boolean, yawInput: number, tiltInput: number, dt: number): void {
    if (active) {
      this.yaw += yawInput * 2.2 * dt;
      this.tilt = THREE.MathUtils.clamp(this.tilt + tiltInput * 0.9 * dt, -0.3, 0.9);
    } else {
      // Unwind the shortest way, then settle behind the car.
      this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
      const k = 1 - Math.exp(-3 * dt);
      this.yaw -= this.yaw * k;
      this.tilt -= this.tilt * k;
    }
  }

  /**
   * Put the car off-centre vertically (e.g. into the free space under a menu card).
   * @param target fraction of the screen height, + moves the car down
   */
  frame(target: number, dt: number): void {
    this.shift += (target - this.shift) * (1 - Math.exp(-5 * dt));
    if (Math.abs(this.shift) < 0.002) {
      this.shift = 0;
      if (this.camera.view?.enabled) this.camera.clearViewOffset();
      return;
    }
    const h = 1000;
    const w = h * this.camera.aspect;
    // Rendering a window above the real frame moves the scene down on screen.
    this.camera.setViewOffset(w, h, 0, -this.shift * h, w, h);
  }

  update(carPos: THREE.Vector3, carRot: THREE.Quaternion, speedRatio: number, dt: number): void {
    // On tall (portrait) screens, raise the camera and tilt it down so the road fills the
    // frame instead of the sky. 0 = landscape, 1 = phone portrait.
    const portrait = THREE.MathUtils.clamp((1.2 - this.camera.aspect) / 0.7, 0, 1);
    const height = HEIGHT + portrait * 5;
    const distance = DISTANCE + portrait * 2;
    const lookAhead = LOOK_AHEAD - portrait * 3;

    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(carRot).setY(0).normalize();
    // Orbit: rotate the "behind" direction around the car, and raise it along an arc.
    const back = forward.clone().negate().applyAxisAngle(UP, -this.yaw);
    const radius = Math.hypot(distance, height);
    const elev = Math.atan2(height, distance) + this.tilt;
    const desired = carPos
      .clone()
      .addScaledVector(back, radius * Math.cos(elev))
      .setY(carPos.y + radius * Math.sin(elev));
    // Looking ahead of the car only makes sense from behind it; orbiting, look at the car.
    const ahead = lookAhead * Math.max(0, Math.cos(this.yaw));
    const look = carPos.clone().addScaledVector(forward, ahead).setY(carPos.y + 1 - portrait);

    if (!this.initialised) {
      this.pos.copy(desired);
      this.target.copy(look);
      this.initialised = true;
    }
    this.pos.lerp(desired, 1 - Math.exp(-6 * dt));
    this.target.lerp(look, 1 - Math.exp(-12 * dt));

    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.target);
    const fov = Math.min(MAX_FOV + 10, baseFov(this.camera.aspect) + SPEED_FOV * Math.min(Math.abs(speedRatio), 1));
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, fov, 1 - Math.exp(-4 * dt));
      this.camera.updateProjectionMatrix();
    }
  }
}
