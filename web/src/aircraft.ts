import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/** Visual state of the exterior model. Angles in radians, ratios 0..1. */
export interface AircraftState {
  aileron: number; // -1..1, + = roll right
  elevator: number; // -1..1, + = nose up
  rudder: number; // -1..1, + = nose right
  flaps: number; // 0..1
  gear: number; // 0 = up, 1 = down
  bombDoors: number[]; // per bay 0..1
  propRpm: number[]; // 6 entries, engine 1 (left outboard) .. 6 (right outboard)
  turretYaw: Record<string, number>;
  turretPitch: Record<string, number>;
}

export function defaultAircraftState(): AircraftState {
  return {
    aileron: 0, elevator: 0, rudder: 0, flaps: 0, gear: 1,
    bombDoors: [0, 0, 0, 0], propRpm: [0, 0, 0, 0, 0, 0], turretYaw: {}, turretPitch: {},
  };
}

export interface Part {
  node: THREE.Object3D;
  axis: THREE.Vector3;
  base: THREE.Quaternion;
  data: Record<string, unknown>;
}

/** Collect nodes carrying glTF extras with an `axis` (animated parts). */
export function collectParts(root: THREE.Object3D, key: string): Map<string, Part> {
  const parts = new Map<string, Part>();
  root.traverse((o) => {
    const d = o.userData as Record<string, unknown>;
    if (d[key] !== undefined && Array.isArray(d.axis)) {
      const [x, y, z] = d.axis as number[];
      parts.set(o.name, { node: o, axis: new THREE.Vector3(x, y, z).normalize(), base: o.quaternion.clone(), data: d });
    }
  });
  return parts;
}

const tmpQ = new THREE.Quaternion();
export function rotatePart(p: Part | undefined, angle: number) {
  if (!p) return;
  tmpQ.setFromAxisAngle(p.axis, angle);
  p.node.quaternion.copy(p.base).multiply(tmpQ);
}

const MAX_SURFACE = THREE.MathUtils.degToRad(25);
const MAX_FLAP = THREE.MathUtils.degToRad(40);

export async function loadGltf(url: string) {
  return (await new GLTFLoader().loadAsync(url)).scene;
}

export class Aircraft {
  readonly root: THREE.Object3D;
  private parts: Map<string, Part>;
  private propAngle = new Map<string, number>();
  private gearNodes: THREE.Object3D[] = [];

  constructor(root: THREE.Object3D) {
    this.root = root;
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.parts = collectParts(root, "part");
    root.traverse((o) => {
      if ((o.userData as Record<string, unknown>).part === "gear") this.gearNodes.push(o);
    });
  }

  static async load(url: string): Promise<Aircraft> {
    return new Aircraft(await loadGltf(url));
  }

  partNames(kind: string): string[] {
    return [...this.parts.values()].filter((p) => p.data.part === kind).map((p) => p.node.name);
  }

  apply(s: AircraftState, dt: number) {
    // Hinge local X points toward +X world on both sides; positive rotation = trailing edge down.
    const ail = s.aileron * MAX_SURFACE;
    rotatePart(this.parts.get("Aileron_R"), -ail); // right aileron up for right roll
    rotatePart(this.parts.get("Aileron_L"), ail);
    rotatePart(this.parts.get("Elevator_R"), -s.elevator * MAX_SURFACE);
    rotatePart(this.parts.get("Elevator_L"), -s.elevator * MAX_SURFACE);
    rotatePart(this.parts.get("Rudder"), s.rudder * MAX_SURFACE); // hinge X up: + = trailing edge right
    for (const name of this.partNames("flap")) rotatePart(this.parts.get(name), s.flaps * MAX_FLAP);

    for (const name of this.partNames("bombdoor")) {
      const p = this.parts.get(name)!;
      rotatePart(p, (s.bombDoors[(p.data.bay as number) - 1] ?? 0) * (p.data.open_angle as number));
    }

    for (const name of this.partNames("prop")) {
      const p = this.parts.get(name)!;
      const k = p.data.engine as number; // 1 = inboard
      const i = p.data.side === "L" ? 3 - k : 2 + k;
      const rpm = s.propRpm[i] ?? 0;
      const a = (this.propAngle.get(name) ?? 0) + (rpm / 60) * 2 * Math.PI * dt * 0.375; // 0.375 = R-4360 prop reduction gear (ESTIMATED)
      this.propAngle.set(name, a % (2 * Math.PI));
      rotatePart(p, a);
    }

    // Gear: simple retraction (fold up into the wing/fuselage), hidden when fully up.
    for (const g of this.gearNodes) {
      const p = this.parts.get(g.name);
      rotatePart(p, (1 - s.gear) * (g.name === "Gear_Nose" ? -1.6 : 1.6));
      g.visible = s.gear > 0.02;
    }

    for (const name of this.partNames("turret_yaw")) {
      rotatePart(this.parts.get(name), s.turretYaw[name] ?? 0);
      rotatePart(this.parts.get(name + "_Guns"), s.turretPitch[name] ?? 0);
    }
  }
}
