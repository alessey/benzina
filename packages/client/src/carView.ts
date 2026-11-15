import * as THREE from 'three';
import { CAR_RIDE_HEIGHT } from '@benzina/shared';

const WHEEL_RADIUS = 0.38;

/** Low-poly car mesh. Purely visual: it follows a sim state, it never drives physics. */
export class CarView {
  readonly group = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly wheels: THREE.Mesh[] = [];
  private readonly frontPivots: THREE.Group[] = [];
  private wheelSpin = 0;

  constructor(color = 0xd8262e) {
    const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.2 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1b2430, roughness: 0.1, metalness: 0.5 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
    const rim = new THREE.MeshStandardMaterial({ color: 0xbfc4c9, roughness: 0.4, metalness: 0.7 });

    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.5, 4.0), paint);
    chassis.position.y = -0.05;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.45, 1.9), glass);
    cabin.position.set(0, 0.42, -0.25);
    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.08, 0.35), paint);
    spoiler.position.set(0, 0.45, -1.85);
    for (const m of [chassis, cabin, spoiler]) {
      m.castShadow = true;
      this.body.add(m);
    }
    this.group.add(this.body);

    const tyreGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.32, 14);
    tyreGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.34, 8);
    rimGeo.rotateZ(Math.PI / 2);
    // Wheel centres relative to the body centre, which sits CAR_RIDE_HEIGHT above the road.
    const wheelY = WHEEL_RADIUS - CAR_RIDE_HEIGHT;
    for (const [x, z, front] of [
      [-0.95, 1.3, true],
      [0.95, 1.3, true],
      [-0.95, -1.3, false],
      [0.95, -1.3, false],
    ] as const) {
      const wheel = new THREE.Mesh(tyreGeo, rubber);
      wheel.add(new THREE.Mesh(rimGeo, rim));
      wheel.castShadow = true;
      const pivot = new THREE.Group();
      pivot.position.set(x, wheelY, z);
      pivot.add(wheel);
      this.group.add(pivot);
      this.wheels.push(wheel);
      if (front) this.frontPivots.push(pivot);
    }
  }

  /**
   * @param speed forward speed m/s
   * @param steer -1..1, positive right
   */
  update(pos: THREE.Vector3, rot: THREE.Quaternion, speed: number, steer: number, dt: number): void {
    this.group.position.copy(pos);
    this.group.quaternion.copy(rot);
    this.wheelSpin += (speed * dt) / WHEEL_RADIUS;
    for (const w of this.wheels) w.rotation.x = this.wheelSpin;
    for (const p of this.frontPivots) p.rotation.y = -steer * 0.45;
    // A little body roll into corners sells the motion.
    const roll = steer * Math.min(Math.abs(speed) / 30, 1) * 0.06;
    this.body.rotation.z = THREE.MathUtils.lerp(this.body.rotation.z, roll, 1 - Math.exp(-8 * dt));
  }
}
