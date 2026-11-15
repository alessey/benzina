import * as THREE from 'three';
import { CAR_RIDE_HEIGHT } from '@benzina/shared';

const WHEEL_RADIUS = 0.38;
/** Car body spans 2.0 m × 4.0 m (the collider); heights are relative to the road. */
const ROAD = -CAR_RIDE_HEIGHT;

export type BodyStyle = 'gt' | 'hatch' | 'muscle';
export const BODY_STYLES: readonly BodyStyle[] = ['gt', 'hatch', 'muscle'];

interface StyleSpec {
  /** Side profile of the lower body, (z, height above road), front to back along the top. */
  body: [number, number][];
  /** Glasshouse profile, (z, height above road). */
  cabin: [number, number][];
  cabinWidth: number;
  spoiler: boolean;
  stripe: boolean;
}

// Profiles run from the front bumper (z = +2) over the top to the rear (z = -2); the bottom
// edge is closed automatically at ground clearance.
const STYLES: Record<BodyStyle, StyleSpec> = {
  gt: {
    body: [[2.0, 0.42], [1.95, 0.62], [1.2, 0.78], [0.45, 0.86], [-1.3, 0.9], [-1.95, 0.84], [-2.0, 0.5]],
    cabin: [[0.5, 0.84], [-0.15, 1.2], [-0.95, 1.22], [-1.55, 0.9]],
    cabinWidth: 1.5,
    spoiler: true,
    stripe: false,
  },
  hatch: {
    body: [[2.0, 0.45], [1.92, 0.72], [1.15, 0.86], [0.7, 0.92], [-1.7, 0.95], [-2.0, 0.9], [-2.0, 0.5]],
    cabin: [[0.75, 0.9], [0.1, 1.42], [-1.55, 1.44], [-1.9, 0.95]],
    cabinWidth: 1.62,
    spoiler: false,
    stripe: false,
  },
  muscle: {
    body: [[2.0, 0.5], [1.97, 0.8], [0.6, 0.9], [0.15, 0.92], [-1.4, 0.92], [-1.98, 0.9], [-2.0, 0.55]],
    cabin: [[0.2, 0.9], [-0.35, 1.28], [-1.05, 1.3], [-1.5, 0.92]],
    cabinWidth: 1.52,
    spoiler: false,
    stripe: true,
  },
};

const GROUND_CLEARANCE = 0.22;

/** Extrude a side profile (z, height above road) across the car's width (x), centred. */
function profileGeometry(points: [number, number][], width: number, bottom: number, bevel: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], bottom);
  for (const [z, y] of points) shape.lineTo(z, y);
  shape.lineTo(points[points.length - 1][0], bottom);
  shape.closePath();
  const depth = width - bevel * 2;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 1,
  });
  // Rotating -90° about Y maps (shapeX, h, extrude) → (-extrude, h, shapeX): the profile's
  // front (+2) lands on car +z and the extrusion spans car x. (A mirror instead of a rotation
  // would turn the mesh inside out.)
  geo.rotateY(-Math.PI / 2);
  geo.translate(depth / 2, ROAD, 0);
  return geo;
}

/**
 * Low-poly car built from extruded side profiles, with wheels, lights and style details.
 * Purely visual: it follows a sim state, it never drives physics. Physics keeps cars level and
 * hovering; the wheels sit on the road and the body rides on top.
 */
export class CarView {
  readonly group = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly wheels: THREE.Mesh[] = [];
  private readonly frontPivots: THREE.Group[] = [];
  private readonly brakeMat: THREE.MeshStandardMaterial;
  private readonly fadeMats: THREE.Material[] = [];
  private wheelSpin = 0;
  private brake = 0;
  private fade = 1;

  constructor(color = 0xd8262e, style: BodyStyle = 'gt') {
    const spec = STYLES[style];
    const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.3, flatShading: true });
    const trim = new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.8, flatShading: true });
    const glass = new THREE.MeshStandardMaterial({ color: 0x18222e, roughness: 0.15, metalness: 0.6, flatShading: true });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.95, flatShading: true });
    const rim = new THREE.MeshStandardMaterial({ color: 0xc9ced3, roughness: 0.35, metalness: 0.8, flatShading: true });
    const head = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff2c0, emissiveIntensity: 0.6 });
    this.brakeMat = new THREE.MeshStandardMaterial({ color: 0x7a0d0d, emissive: 0xff1a1a, emissiveIntensity: 0.25 });
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.4, flatShading: true });
    // Cloned so fading one car never affects another.
    this.fadeMats.push(paint, trim, glass, rubber, rim, head, this.brakeMat, stripeMat);

    const bottom = GROUND_CLEARANCE;
    const add = (mesh: THREE.Mesh, shadow = true) => {
      mesh.castShadow = shadow;
      this.body.add(mesh);
      return mesh;
    };
    add(new THREE.Mesh(profileGeometry(spec.body, 1.96, bottom, 0.06), paint));
    add(new THREE.Mesh(profileGeometry(spec.cabin, spec.cabinWidth, spec.cabin[0][1] - 0.02, 0.04), glass));
    const sill = add(new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.12, 3.6), trim));
    sill.position.set(0, ROAD + bottom + 0.06, 0);

    if (spec.stripe) {
      const top = spec.body.reduce((m, p) => Math.max(m, p[1]), 0);
      const stripe = add(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.02, 4.02), stripeMat), false);
      stripe.position.set(0, ROAD + top + 0.005, 0);
    }
    if (spec.spoiler) {
      const wing = add(new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.06, 0.38), paint));
      wing.position.set(0, ROAD + 1.12, -1.8);
      for (const x of [-0.6, 0.6]) {
        const post = add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.24, 0.12), trim));
        post.position.set(x, ROAD + 0.98, -1.78);
      }
    }

    // Lights: headlights at the front corners, tail/brake lights across the back.
    const frontY = ROAD + spec.body[1][1] - 0.12;
    const rearY = ROAD + spec.body[spec.body.length - 2][1] - 0.14;
    for (const x of [-0.68, 0.68]) {
      add(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.12, 0.05), head), false).position.set(x, frontY, 2.01);
      add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.11, 0.05), this.brakeMat), false).position.set(x, rearY, -2.01);
    }
    add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.14, 0.04), trim), false).position.set(0, frontY - 0.08, 2.01);
    this.group.add(this.body);

    const tyreGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.3, 12);
    tyreGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.32, 6);
    rimGeo.rotateZ(Math.PI / 2);
    // Wheel centres sit one radius above the road.
    const wheelY = ROAD + WHEEL_RADIUS;
    for (const [x, z, front] of [
      [-0.88, 1.3, true],
      [0.88, 1.3, true],
      [-0.88, -1.28, false],
      [0.88, -1.28, false],
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

    // When faded (transparent), the body is drawn first and still writes depth, so it hides
    // the wheels behind it; otherwise a faded car looks like an X-ray with its wheels inside.
    this.body.traverse((o) => (o.renderOrder = 1));
    for (const p of this.frontPivots) p.traverse((o) => (o.renderOrder = 2));
    for (const w of this.wheels) w.traverse((o) => (o.renderOrder = 2));
  }

  /**
   * @param speed forward speed m/s
   * @param steer -1..1, positive right
   * @param braking 0..1, how hard the car is slowing (drives the brake lights)
   */
  update(pos: THREE.Vector3, rot: THREE.Quaternion, speed: number, steer: number, dt: number, braking = 0): void {
    this.group.position.copy(pos);
    this.group.quaternion.copy(rot);
    this.wheelSpin += (speed * dt) / WHEEL_RADIUS;
    for (const w of this.wheels) w.rotation.x = this.wheelSpin;
    for (const p of this.frontPivots) p.rotation.y = -steer * 0.45;
    // A little body roll into corners sells the motion.
    const roll = steer * Math.min(Math.abs(speed) / 30, 1) * 0.05;
    this.body.rotation.z = THREE.MathUtils.lerp(this.body.rotation.z, roll, 1 - Math.exp(-8 * dt));
    this.brake += (braking - this.brake) * (1 - Math.exp(-15 * dt));
    this.brakeMat.emissiveIntensity = 0.25 + this.brake * 2.5;
  }

  /** Fade the car out (e.g. when it's between the camera and your car). 1 = solid. */
  setFade(alpha: number): void {
    if (Math.abs(alpha - this.fade) < 0.01) return;
    this.fade = alpha;
    for (const m of this.fadeMats) {
      m.transparent = alpha < 0.99;
      m.opacity = alpha;
    }
  }
}
