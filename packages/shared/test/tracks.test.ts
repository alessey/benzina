import { beforeAll, describe, expect, it } from 'vitest';
import { botInput, buildTrack, CAR_RIDE_HEIGHT, initPhysics, nearestSampleIndex, rightOf, roadHeightAt, SimWorld, TRACKS, yawQuat } from '../src';

beforeAll(async () => {
  await initPhysics();
});

declare const console: { log(...a: unknown[]): void };

/** Geometry checks every track must pass: they keep physics, walls and lookups sane. */
describe.each(TRACKS.map((def) => [def.name, def] as const))('%s', (_name, def) => {
  const track = buildTrack(def);
  const n = track.samples.length;
  const spacing = track.length / n;

  it('never comes close to another part of itself', () => {
    // Samples more than ~60 m apart along the track must be > a road width + margin apart in space.
    const skip = Math.ceil(60 / spacing);
    let closest = Infinity;
    for (let i = 0; i < n; i++) {
      for (let j = i + skip; j < n && j < i + n - skip; j++) {
        const a = track.samples[i];
        const b = track.samples[j];
        closest = Math.min(closest, Math.hypot(a.x - b.x, a.z - b.z));
      }
    }
    expect(closest).toBeGreaterThan(def.width + 12);
  });

  it('has drivable grades, corners and crests', () => {
    const maxGrade = Math.max(...track.samples.map((s) => Math.abs(s.slope)));
    const minRadius = 1 / Math.max(...track.samples.map((s) => Math.abs(s.curvature)));
    // Crest airborne speed: cars leave the road where gravity < v² × downward curvature.
    let airborne = Infinity;
    for (let i = 0; i < n; i++) {
      const a = track.samples[(i - 1 + n) % n];
      const b = track.samples[(i + 1) % n];
      const vCurv = (b.slope - a.slope) / (2 * spacing);
      if (vCurv < 0) airborne = Math.min(airborne, Math.sqrt(25 / -vCurv));
    }
    console.log(
      `${def.name}: ${track.length.toFixed(0)} m, climb ${track.bounds.maxY.toFixed(1)} m, max grade ${(maxGrade * 100).toFixed(1)}%, ` +
        `tightest radius ${minRadius.toFixed(0)} m, max bank ${((Math.max(...track.samples.map((s) => Math.abs(s.bank))) * 180) / Math.PI).toFixed(1)}°, ` +
        `crest air above ${(airborne * 3.6).toFixed(0)} km/h`,
    );
    // Jump tracks have short steep kickers (the car body doesn't collide with the road, so a
    // level car can't catch a ramp; the hover spring follows it).
    expect(maxGrade).toBeLessThan(def.jumps ? 0.32 : 0.12);
    expect(minRadius).toBeGreaterThan(14);
    expect(Math.min(...track.samples.map((s) => s.y))).toBeGreaterThanOrEqual(0);
    // Both edges stay above ground even on banked corners (else the ground covers the road).
    const lowestEdge = Math.min(...track.leftEdge.map((e) => e.y), ...track.rightEdge.map((e) => e.y));
    expect(lowestEdge).toBeGreaterThanOrEqual(0.04);
  });

  it('the autopilot laps it cleanly: no falls, resets, or scraping the road', () => {
    const sim = new SimWorld(track);
    const car = sim.addCar('a', 0);
    const road = sim.world.getCollider(roadColliderHandle(sim));
    let last = nearestSampleIndex(track, car.body.translation().x, car.body.translation().z);
    let travelled = 0;
    let airborne = 0;
    let maxDrop = 0;
    let scrapes = 0;
    let t = 0;
    for (; t < 60 * 120 && travelled < n; t++) {
      sim.step(new Map([['a', botInput(car, track)]]));
      const p = car.body.translation();
      const i = nearestSampleIndex(track, p.x, p.z);
      let d = i - last;
      if (d < -n / 2) d += n;
      if (d > n / 2) d -= n;
      // A reset teleports the car; that would show up as a jump in track position.
      expect(Math.abs(d)).toBeLessThan(10);
      travelled += d;
      last = i;
      if (!car.grounded) airborne++;
      maxDrop = Math.max(maxDrop, roadHeightAt(track, p.x, p.z, i) + 0.4 - p.y);
      // Actual contact points between the car body and the road surface mean it scraped.
      sim.world.contactPair(car.collider, road, (manifold) => {
        for (let k = 0; k < manifold.numContacts(); k++) if (manifold.contactDist(k) < 0.01) scrapes++;
      });
    }
    sim.free();
    expect(travelled).toBeGreaterThanOrEqual(n);
    if (def.jumps) {
      console.log(`${def.name}: ${airborne} airborne ticks per lap`);
      expect(airborne).toBeGreaterThan(60); // the jumps actually launch you (~1.4 s each)
      expect(airborne).toBeLessThan(220);
    } else {
      expect(airborne).toBeLessThan(30);
    }
    // Never sank into the road. (On a channel's steep walls the height lookup is only
    // approximate between track samples, so allow a little more there.)
    expect(maxDrop).toBeLessThan(def.pipe ? 0.5 : 0.3);
    expect(scrapes).toBe(0);
  });

  it('cars sliding sideways into the walls never get past them (including banked corners)', () => {
    const halfRoad = def.width / 2;
    let worst = 0;
    for (let idx = 0; idx < n; idx += 24) {
      for (const side of [1, -1] as const) {
        for (const speed of [15, 35]) {
          const sim = new SimWorld(track);
          const car = sim.addCar('a', 0);
          const s = track.samples[idx];
          const r = rightOf(s.tx, s.tz);
          const q = yawQuat(Math.atan2(s.tx, s.tz));
          const off = side * (halfRoad - 3);
          const x = s.x + r.x * off;
          const z = s.z + r.z * off;
          car.setState({
            // At the road's height right there (banking raises one side), resting on the spring.
            p: [x, roadHeightAt(track, x, z) + CAR_RIDE_HEIGHT, z],
            q: [q.x, q.y, q.z, q.w],
            v: [s.tx * speed + r.x * side * speed * 0.7, 0, s.tz * speed + r.z * side * speed * 0.7],
            w: [0, 0, 0],
            steer: 0,
            upset: 0,
          });
          for (let t = 0; t < 90; t++) {
            sim.step(new Map([['a', { throttle: 1, steer: side, handbrake: true, reset: false }]]));
            const p = car.body.translation();
            const sm = track.samples[nearestSampleIndex(track, p.x, p.z)];
            const rr = rightOf(sm.tx, sm.tz);
            worst = Math.max(worst, Math.abs((p.x - sm.x) * rr.x + (p.z - sm.z) * rr.z));
          }
          sim.free();
        }
      }
    }
    // The car is 2 m wide: its centre should stop ~1 m inside the wall.
    expect(worst).toBeLessThan(halfRoad - 0.7);
  });

  it('is deterministic over the hills', () => {
    const run = () => {
      const sim = new SimWorld(track);
      sim.addCar('a', 0);
      sim.addCar('b', 1);
      for (let t = 0; t < 900; t++) {
        const inputs = new Map([...sim.cars].map(([id, c]) => [id, botInput(c, track, id === 'a' ? 1 : 0.8)] as const));
        sim.step(inputs);
      }
      const states = [...sim.cars.values()].map((c) => c.getState());
      sim.free();
      return states;
    };
    expect(run()).toEqual(run());
  });
});

/** The road collider is created first after the ground, so it has a stable handle per world. */
function roadColliderHandle(sim: SimWorld): number {
  let handle = -1;
  sim.world.forEachCollider((c) => {
    if (handle < 0 && c.shape.type === 6) handle = c.handle;
  });
  return handle;
}
