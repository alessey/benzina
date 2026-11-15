import { RAPIER } from './physics';
import { Car, HALF_L, HALF_W } from './car';
import { DEFAULT_TUNING, DT, type CarTuning } from './config';
import { NEUTRAL_INPUT, type CarInput } from './input';
import { gridSlot, type Track, type Vec3 } from './track';

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
    /** Continue the tick count from a previous world (track changes keep timelines aligned). */
    startTick = 0,
  ) {
    this.tick = startTick;
    this.world = new RAPIER.World({ x: 0, y: -tuning.gravity, z: 0 });
    this.world.timestep = DT;

    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(GROUND_HALF_SIZE, 0.5, GROUND_HALF_SIZE)
        .setTranslation(0, -0.5, 0)
        .setFriction(0),
    );

    // The road surface: a static triangle mesh following the track's heights and banking. Cars
    // hover over it on a raycast spring, so normal driving never touches it.
    this.world.createCollider(RAPIER.ColliderDesc.trimesh(...roadMesh(track)).setFriction(0));

    // One triangle-mesh collider per side, standing on the road edge. Hundreds of separate
    // box colliders cost ~4x more per step, which matters because clients re-simulate
    // many ticks per snapshot (and phones are slow).
    for (const [edge, facing] of [
      [track.leftEdge, 1],
      [track.rightEdge, -1],
    ] as const) {
      this.world.createCollider(
        RAPIER.ColliderDesc.trimesh(
          ...wallMesh(edge, track, track.def.wallHeight, facing),
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
    const car = new Car(this.world, this.track, id, g.x, g.y, g.z, g.yaw);
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
    this.resolveBumps();
    for (const [id, car] of this.cars) {
      car.applyControls(inputs.get(id) ?? NEUTRAL_INPUT, this.tuning, DT);
    }
    this.world.step();
    this.tick++;
  }

  free(): void {
    this.world.free();
  }

  /**
   * Arcade layer for car-to-car contact, on top of Rapier's collision response (which still
   * stops cars passing through each other). Touching cars are pushed apart to at least
   * `bumpSeparation`, split equally, so bumps are a crisp shove rather than a grind, and a car
   * pointed into another is turned parallel to it.
   *
   * Contacts come from a box-overlap test on positions and headings, not from Rapier's contact
   * state (which isn't in snapshots), and pairs are visited in id order: the client's car
   * map may be in a different order than the server's, and float sums depend on order.
   */
  private resolveBumps(): void {
    const t = this.tuning;
    const cars = [...this.cars.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const frames = cars.map((car) => {
      const p = car.body.translation();
      const q = car.body.rotation();
      const yaw = 2 * Math.atan2(q.y, q.w);
      car.bumpYaw = 0;
      return {
        car,
        x: p.x,
        z: p.z,
        fx: Math.sin(yaw),
        fz: Math.cos(yaw),
        v: car.body.linvel(),
        w: car.body.angvel().y,
        speed: car.forwardSpeed(),
      };
    });

    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        const a = frames[i];
        const b = frames[j];
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        if (dx * dx + dz * dz > (2 * HALF_L + 1) ** 2) continue;
        const contact = boxContact(a, b, dx, dz);
        if (!contact) continue;
        // n points from b to a.
        const { nx, nz, cx, cz } = contact;

        // Spin from off-centre hits: a rigid-body impulse at the contact point, from the closing
        // speed there (including rotation), applied only while approaching, so each hit
        // twists once instead of continuously while touching. Equal masses.
        const rax = cx - a.x;
        const raz = cz - a.z;
        const rbx = cx - b.x;
        const rbz = cz - b.z;
        // Velocity of each car at the contact point: v + ω × r (ω about +Y).
        const vax = a.v.x + a.w * raz;
        const vaz = a.v.z - a.w * rax;
        const vbx = b.v.x + b.w * rbz;
        const vbz = b.v.z - b.w * rbx;
        const closing = -((vax - vbx) * nx + (vaz - vbz) * nz);
        if (closing > 0 && t.bumpSpin > 0) {
          const raCrossN = raz * nx - rax * nz;
          const rbCrossN = rbz * nx - rbx * nz;
          const j = ((1 + BUMP_RESTITUTION) * closing) / (2 + (raCrossN ** 2 + rbCrossN ** 2) / CAR_INERTIA);
          // a receives +j·n, b receives −j·n.
          const dwa = (t.bumpSpin * raCrossN * j) / CAR_INERTIA;
          const dwb = (-t.bumpSpin * rbCrossN * j) / CAR_INERTIA;
          a.w += dwa;
          b.w += dwb;
          // A hard twist unsettles the car, letting tyre saturation turn it into a spin.
          a.car.upset = Math.min(1, a.car.upset + Math.abs(dwa) / UPSET_PER_SPIN);
          b.car.upset = Math.min(1, b.car.upset + Math.abs(dwb) / UPSET_PER_SPIN);
        }

        const separating = (a.v.x - b.v.x) * nx + (a.v.z - b.v.z) * nz;
        if (separating < t.bumpSeparation) {
          const dv = (t.bumpSeparation - separating) / 2;
          a.v = { x: a.v.x + nx * dv, y: a.v.y, z: a.v.z + nz * dv };
          b.v = { x: b.v.x - nx * dv, y: b.v.y, z: b.v.z - nz * dv };
        }
        // Glance: nose pointed at the other car? Turn away (parallel to the contact surface).
        for (const [self, sx, sz] of [
          [a, -nx, -nz],
          [b, nx, nz],
        ] as const) {
          const into = self.fx * sx + self.fz * sz; // >0: heading toward the other car
          if (into <= 0) continue;
          // Positive yaw turns left; turn toward whichever side moves the nose away.
          const side = Math.sign(self.fx * -sz + self.fz * sx) || 1; // other car is to the right (+) or left (-)
          self.car.bumpYaw += side * into * t.bumpDeflect * Math.sign(self.speed || 1);
        }
      }
    }
    for (const f of frames) {
      f.car.body.setLinvel(f.v, true);
      f.car.body.setAngvel({ x: 0, y: f.w, z: 0 }, true);
    }
  }
}

/** Are two cars' boxes touching (or within the contact gap)? Same test the bump layer uses. */
export function carsInContact(a: Car, b: Car): boolean {
  const frame = (c: Car) => {
    const p = c.body.translation();
    const q = c.body.rotation();
    const yaw = 2 * Math.atan2(q.y, q.w);
    return { x: p.x, z: p.z, fx: Math.sin(yaw), fz: Math.cos(yaw) };
  };
  const fa = frame(a);
  const fb = frame(b);
  return boxContact(fa, fb, fa.x - fb.x, fa.z - fb.z) !== null;
}

const CAR_CONTACT_GAP = 0.05;
const BUMP_RESTITUTION = 0.3;
/** Yaw-rate kick (rad/s) from a hit that fully unsettles a car. */
const UPSET_PER_SPIN = 2;
/** Yaw moment of inertia per unit mass of a solid 2 m × 4 m box: (w² + l²) / 12. */
const CAR_INERTIA = ((2 * HALF_W) ** 2 + (2 * HALF_L) ** 2) / 12;

/**
 * The point of a car's box furthest along (ux, uz). Uses a soft sign so that when a face is
 * square-on, the answer is the face centre rather than an arbitrary corner.
 */
function support(c: { x: number; z: number; fx: number; fz: number }, ux: number, uz: number): [number, number] {
  const soft = (v: number) => Math.max(-1, Math.min(1, v / 0.15));
  const along = soft(c.fx * ux + c.fz * uz) * HALF_L;
  const across = soft(-c.fz * ux + c.fx * uz) * HALF_W;
  return [c.x + c.fx * along - c.fz * across, c.z + c.fz * along + c.fx * across];
}

/**
 * 2D separating-axis test between two car boxes on the ground plane. Returns the contact
 * normal (unit, from b toward a) and an estimated contact point, if they overlap or are
 * within CAR_CONTACT_GAP; else null.
 */
function boxContact(
  a: { x: number; z: number; fx: number; fz: number },
  b: { x: number; z: number; fx: number; fz: number },
  dx: number,
  dz: number,
): { nx: number; nz: number; cx: number; cz: number } | null {
  // Candidate axes: each car's forward and right vectors.
  const axes = [
    [a.fx, a.fz],
    [-a.fz, a.fx],
    [b.fx, b.fz],
    [-b.fz, b.fx],
  ];
  let best = Infinity;
  let bestAxis = axes[0];
  for (const [ux, uz] of axes) {
    const reach = (c: { fx: number; fz: number }) =>
      HALF_L * Math.abs(c.fx * ux + c.fz * uz) + HALF_W * Math.abs(-c.fz * ux + c.fx * uz);
    const dist = dx * ux + dz * uz;
    const overlap = reach(a) + reach(b) - Math.abs(dist);
    if (overlap < -CAR_CONTACT_GAP) return null; // separating axis found
    if (overlap < best) {
      best = overlap;
      bestAxis = dist >= 0 ? [ux, uz] : [-ux, -uz];
    }
  }
  const [nx, nz] = bestAxis;
  // Contact point: midway between the deepest points of each box toward the other.
  const [ax, az] = support(a, -nx, -nz);
  const [bx, bz] = support(b, nx, nz);
  return { nx, nz, cx: (ax + bx) / 2, cz: (az + bz) / 2 };
}

/** Closed strip between the left and right road edges, facing up. */
function roadMesh(track: Track): [Float32Array, Uint32Array] {
  const n = track.samples.length;
  const vertices = new Float32Array(n * 6);
  const indices = new Uint32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const l = track.leftEdge[i];
    const r = track.rightEdge[i];
    vertices.set([l.x, l.y, l.z, r.x, r.y, r.z], i * 6);
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    // Left(i), right(i), left(i+1): with left = -right, this winding faces up.
    indices.set([a, a + 1, b, a + 1, b + 1, b], i * 6);
  }
  return [vertices, indices];
}

/** Extra invisible wall height above the visible wall, so nothing ever goes over the top. */
const WALL_TOP_MARGIN = 1.5;

/**
 * A vertical ribbon along a closed edge loop, from below the road up past the visible wall.
 * Its top is measured from the higher of the edge and the centre line: on a banked corner the
 * inside edge is well below the centre, and cars stay level in physics at centre height, so a
 * wall measured from the low edge would let them slide right over it.
 *
 * Triangles must face the road: with internal-edge fixing, Rapier treats them as one-sided.
 * With the default winding, normals point to the right of the driving direction; `facing = -1`
 * flips them.
 */
function wallMesh(edge: Vec3[], track: Track, height: number, facing: 1 | -1): [Float32Array, Uint32Array] {
  const n = edge.length;
  const vertices = new Float32Array(n * 6);
  const indices = new Uint32Array(n * 6);
  edge.forEach((p, i) => {
    const top = Math.max(p.y, track.samples[i].y) + height + WALL_TOP_MARGIN;
    vertices.set([p.x, p.y - 1, p.z, p.x, top, p.z], i * 6);
  });
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    if (facing === 1) indices.set([a, b, a + 1, a + 1, b, b + 1], i * 6);
    else indices.set([a, a + 1, b, a + 1, b + 1, b], i * 6);
  }
  return [vertices, indices];
}
