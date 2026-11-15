import * as THREE from 'three';

const DISTANCE = 9;
const HEIGHT = 3.4;
const LOOK_AHEAD = 4;
const BASE_FOV = 65;
const SPEED_FOV = 15;

/** Third-person camera that trails the car with exponential smoothing. */
export class ChaseCamera {
  private readonly pos = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private initialised = false;

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  update(carPos: THREE.Vector3, carRot: THREE.Quaternion, speedRatio: number, dt: number): void {
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(carRot).setY(0).normalize();
    const desired = carPos.clone().addScaledVector(forward, -DISTANCE).setY(carPos.y + HEIGHT);
    const look = carPos.clone().addScaledVector(forward, LOOK_AHEAD).setY(carPos.y + 1);

    if (!this.initialised) {
      this.pos.copy(desired);
      this.target.copy(look);
      this.initialised = true;
    }
    this.pos.lerp(desired, 1 - Math.exp(-6 * dt));
    this.target.lerp(look, 1 - Math.exp(-12 * dt));

    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.target);
    const fov = BASE_FOV + SPEED_FOV * Math.min(Math.abs(speedRatio), 1);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, fov, 1 - Math.exp(-4 * dt));
      this.camera.updateProjectionMatrix();
    }
  }
}
