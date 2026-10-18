import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/** Control state the sim (or debug UI) writes each frame. Angles in radians, 0..1 for ratios. */
export interface AircraftState {
  aileron: number; // + = right wing down (roll right)
  elevator: number; // + = nose up
  rudder: number; // + = nose right
  flaps: number; // 0..1
  bombDoors: number[]; // per bay 0..1
  propRpm: number[]; // 6 entries: L3 L2 L1 R1 R2 R3 order by name lookup below
  turretYaw: Record<string, number>;
  turretPitch: Record<string, number>;
}

interface Part {
  node: THREE.Object3D;
  axis: THREE.Vector3;
  base: THREE.Quaternion;
  data: Record<string, unknown>;
}

const MAX_SURFACE = THREE.MathUtils.degToRad(25);
const MAX_FLAP = THREE.MathUtils.degToRad(40);

export class Aircraft {
  readonly root: THREE.Object3D;
  private parts = new Map<string, Part>();
  private propAngle = new Map<string, number>();

  private constructor(root: THREE.Object3D) {
    this.root = root;
    root.traverse((o) => {
      const d = o.userData as Record<string, unknown>;
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
      if (typeof d.part === "string" && Array.isArray(d.axis)) {
        const [x, y, z] = d.axis as number[];
        this.parts.set(o.name, {
          node: o,
          axis: new THREE.Vector3(x, y, z).normalize(),
          base: o.quaternion.clone(),
          data: d,
        });
      }
    });
  }

  static async load(url: string): Promise<Aircraft> {
    const gltf = await new GLTFLoader().loadAsync(url);
    return new Aircraft(gltf.scene);
  }

  partNames(kind: string): string[] {
    return [...this.parts.values()].filter((p) => p.data.part === kind).map((p) => p.node.name);
  }

  private setRotation(name: string, angle: number) {
    const p = this.parts.get(name);
    if (!p) return;
    const q = new THREE.Quaternion().setFromAxisAngle(p.axis, angle);
    p.node.quaternion.copy(p.base).multiply(q);
  }

  apply(s: AircraftState, dt: number) {
    // Hinge local X points toward +X world on both sides; positive rotation = trailing edge down.
    const ail = s.aileron * MAX_SURFACE;
    this.setRotation("Aileron_R", -ail);
    this.setRotation("Aileron_L", ail);
    this.setRotation("Elevator_R", -s.elevator * MAX_SURFACE);
    this.setRotation("Elevator_L", -s.elevator * MAX_SURFACE);
    this.setRotation("Rudder", -s.rudder * MAX_SURFACE);
    for (const name of this.partNames("flap")) this.setRotation(name, s.flaps * MAX_FLAP);

    for (const name of this.partNames("bombdoor")) {
      const p = this.parts.get(name)!;
      const bay = (p.data.bay as number) - 1;
      this.setRotation(name, (s.bombDoors[bay] ?? 0) * (p.data.open_angle as number));
    }

    for (const name of this.partNames("prop")) {
      const p = this.parts.get(name)!;
      const side = p.data.side === "L" ? 0 : 3;
      const i = side + ((p.data.engine as number) - 1);
      const rpm = s.propRpm[i] ?? 0;
      // Opposite rotation sense per side is not historical (all B-36 props turned the same way).
      const a = (this.propAngle.get(name) ?? 0) + (rpm / 60) * 2 * Math.PI * dt;
      this.propAngle.set(name, a % (2 * Math.PI));
      this.setRotation(name, a);
    }

    for (const name of this.partNames("turret_yaw")) {
      this.setRotation(name, s.turretYaw[name] ?? 0);
      this.setRotation(name + "_Guns", s.turretPitch[name] ?? 0);
    }
  }
}
