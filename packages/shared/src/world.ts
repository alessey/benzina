import { RAPIER } from './physics';
import { Car } from './car';
import { DEFAULT_TUNING, DT, type CarTuning } from './config';
import { NEUTRAL_INPUT, type CarInput } from './input';
import { gridSlot, type Track, type Vec2 } from './track';

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

    // One triangle-mesh collider per side, standing on the road edge. Hundreds of separate
    // box colliders cost ~4x more per step, which matters because clients re-simulate
    // many ticks per snapshot (and phones are slow).
    for (const [edge, facing] of [
      [track.leftEdge, 1],
      [track.rightEdge, -1],
    ] as const) {
      this.world.createCollider(
        RAPIER.ColliderDesc.trimesh(
          ...wallMesh(edge, track.def.wallHeight, facing),
          RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES,
        )
          .setFriction(0)
          .setRestitution(0.3),
      );
    }

    // Rapier builds its query acceleration structure during step(). Step once with only
    // static geometry so ground raycasts work from the very first real tick.
    this.world.step();
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

/**
 * A vertical ribbon along a closed edge loop, from the ground up to `height`. Triangles must
 * face the road: with internal-edge fixing, Rapier treats them as one-sided. With the
 * default winding, normals point to the right of the driving direction; `facing = -1` flips them.
 */
function wallMesh(edge: Vec2[], height: number, facing: 1 | -1): [Float32Array, Uint32Array] {
  const n = edge.length;
  const vertices = new Float32Array(n * 6);
  const indices = new Uint32Array(n * 6);
  edge.forEach((p, i) => vertices.set([p.x, 0, p.z, p.x, height, p.z], i * 6));
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    if (facing === 1) indices.set([a, b, a + 1, a + 1, b, b + 1], i * 6);
    else indices.set([a, a + 1, b, a + 1, b + 1, b], i * 6);
  }
  return [vertices, indices];
}
