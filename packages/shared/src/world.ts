import { RAPIER } from './physics';
import { Car } from './car';
import { DEFAULT_TUNING, DT, type CarTuning } from './config';
import { NEUTRAL_INPUT, type CarInput } from './input';
import { yawQuat } from './state';
import { gridSlot, type Track } from './track';

const GROUND_HALF_SIZE = 2000;

/**
 * The authoritative game simulation: one physics world, one track, N cars.
 * Runs identically in the browser (prediction) and on the server (authority).
 * Call initPhysics() before constructing.
 */
export class SimWorld {
  readonly world: RAPIER.World;
  readonly cars = new Map<string, Car>();
  tick = 0;

  constructor(
    readonly track: Track,
    readonly tuning: CarTuning = { ...DEFAULT_TUNING },
  ) {
    this.world = new RAPIER.World({ x: 0, y: -tuning.gravity, z: 0 });
    this.world.timestep = DT;

    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(GROUND_HALF_SIZE, 0.5, GROUND_HALF_SIZE)
        .setTranslation(0, -0.5, 0)
        .setFriction(0),
    );

    const { wallHeight, wallThickness } = track.def;
    for (const w of track.walls) {
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(wallThickness / 2, wallHeight / 2, w.length / 2)
          .setTranslation(w.x, wallHeight / 2, w.z)
          .setRotation(yawQuat(w.yaw))
          .setFriction(0)
          .setRestitution(0.3),
      );
    }
  }

  /** Add a car on the starting grid. */
  addCar(id: string, slot: number): Car {
    if (this.cars.has(id)) throw new Error(`car ${id} already exists`);
    const g = gridSlot(this.track, slot);
    const car = new Car(this.world, this.track, id, g.x, g.z, g.yaw);
    this.cars.set(id, car);
    return car;
  }

  removeCar(id: string): void {
    const car = this.cars.get(id);
    if (!car) return;
    this.world.removeRigidBody(car.body);
    this.cars.delete(id);
  }

  /** Advance one fixed tick. Cars without an input this tick coast with neutral controls. */
  step(inputs: ReadonlyMap<string, CarInput>): void {
    this.world.gravity = { x: 0, y: -this.tuning.gravity, z: 0 };
    for (const [id, car] of this.cars) {
      car.applyControls(inputs.get(id) ?? NEUTRAL_INPUT, this.tuning, DT);
    }
    this.world.step();
    this.tick++;
  }

  free(): void {
    this.world.free();
  }
}
