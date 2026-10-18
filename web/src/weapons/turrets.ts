// B-36H defensive system: 8 remotely controlled turrets, 16 x 20 mm M24A1.
// Turret nodes come from the exterior glTF: "Turret_X" (yaw about local +y) with child
// "Turret_X_Guns" (pitch about local +x); guns point along local -z.
// Figures marked ESTIMATED are typical values, not from a B-36 source.
import * as THREE from "three";
import { atmosphere, G0 } from "../sim/atmosphere.ts";
import type { FlightModel } from "../sim/flightmodel.ts";

const DEG = Math.PI / 180;
export const GUN = {
  rpm: 750, // per gun, ESTIMATED for the M24A1
  muzzle: 840, // m/s, ESTIMATED (about 2,750 ft/s)
  roundsPerGun: 600, // ESTIMATED
  mass: 0.13, // kg projectile
  cd: 0.30,
  area: Math.PI * 0.01 * 0.01,
};
const SLEW = 45 * DEG; // rad/s, ESTIMATED
const EXTEND_TIME = 4; // s, ESTIMATED

interface Limits { az: [number, number] | null; el: [number, number] }
const LIMITS: Record<string, Limits> = {
  upper: { az: null, el: [-6 * DEG, 85 * DEG] },
  lower: { az: null, el: [-6 * DEG, 85 * DEG] },
  nose: { az: [-30 * DEG, 30 * DEG], el: [-25 * DEG, 45 * DEG] },
  tail: { az: [-40 * DEG, 40 * DEG], el: [-35 * DEG, 40 * DEG] },
};

export class Turret {
  readonly name: string;
  readonly yawNode: THREE.Object3D;
  readonly pitchNode: THREE.Object3D;
  readonly kind: keyof typeof LIMITS;
  private baseYawQ: THREE.Quaternion;
  private basePitchQ: THREE.Quaternion;
  private stowPos: THREE.Vector3;
  private extendDir: THREE.Vector3;
  readonly retract: number;
  readonly barrel: number;
  ext: number;
  extendCmd = false;
  az = 0;
  el = 0;
  ammo = GUN.roundsPerGun * 2;
  private cooldown = 0;
  private gun = 0;

  constructor(yawNode: THREE.Object3D) {
    this.name = yawNode.name;
    this.yawNode = yawNode;
    this.pitchNode = yawNode.getObjectByName(yawNode.name + "_Guns")!;
    this.kind = this.name.includes("Nose") ? "nose" : this.name.includes("Tail") ? "tail"
      : this.name.includes("Lower") ? "lower" : "upper";
    this.baseYawQ = yawNode.quaternion.clone();
    this.basePitchQ = this.pitchNode.quaternion.clone();
    this.stowPos = yawNode.position.clone();
    this.extendDir = new THREE.Vector3(0, 1, 0).applyQuaternion(this.baseYawQ);
    this.retract = Number((yawNode.userData as { retract?: number }).retract ?? 0);
    this.ext = this.retract > 0 ? 0 : 1;
    this.barrel = this.kind === "nose" ? 1.4 : this.kind === "tail" ? 1.8 : 2.0;
  }

  get ready() {
    return this.ext >= 0.999;
  }

  /** Direction (world) -> turret az/el in its base frame. */
  solve(targetWorld: THREE.Vector3): { az: number; el: number } {
    const parent = this.yawNode.parent!;
    const pivot = this.yawNode.getWorldPosition(new THREE.Vector3());
    const dirW = targetWorld.clone().sub(pivot).normalize();
    const baseW = parent.getWorldQuaternion(new THREE.Quaternion()).multiply(this.baseYawQ);
    const d = dirW.applyQuaternion(baseW.invert());
    return { az: Math.atan2(-d.x, -d.z), el: Math.atan2(d.y, Math.hypot(d.x, d.z)) };
  }

  update(dt: number, cmd: { az: number; el: number } | null) {
    const target = this.extendCmd || this.retract === 0 ? 1 : 0;
    this.ext += Math.max(-dt / EXTEND_TIME, Math.min(dt / EXTEND_TIME, target - this.ext));
    this.yawNode.position.copy(this.stowPos).addScaledVector(this.extendDir, this.retract * this.ext);
    this.yawNode.visible = this.ext > 0.01;
    const lim = LIMITS[this.kind];
    let { az, el } = cmd ?? { az: 0, el: 0 };
    if (!this.ready) { az = 0; el = 0; }
    if (lim.az) az = Math.max(lim.az[0], Math.min(lim.az[1], az));
    el = Math.max(lim.el[0], Math.min(lim.el[1], el));
    let daz = az - this.az;
    if (!lim.az) daz = Math.atan2(Math.sin(daz), Math.cos(daz));
    const step = SLEW * dt;
    this.az += Math.max(-step, Math.min(step, daz));
    this.el += Math.max(-step, Math.min(step, el - this.el));
    this.yawNode.quaternion.copy(this.baseYawQ).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.az));
    this.pitchNode.quaternion.copy(this.basePitchQ).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.el));
    this.cooldown -= dt;
  }

  /** Fire if ready; returns muzzle (scene coords) and direction for each round fired this frame. */
  fire(dt: number): { pos: THREE.Vector3; dir: THREE.Vector3 }[] {
    const out: { pos: THREE.Vector3; dir: THREE.Vector3 }[] = [];
    if (!this.ready || this.ammo <= 0) return out;
    const interval = 60 / (GUN.rpm * 2);
    while (this.cooldown <= 0 && this.ammo > 0) {
      this.gun ^= 1;
      const local = new THREE.Vector3(this.gun ? 0.2 : -0.2, 0.12, -this.barrel);
      const pos = this.pitchNode.localToWorld(local);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.pitchNode.getWorldQuaternion(new THREE.Quaternion()));
      out.push({ pos, dir });
      this.ammo--;
      this.cooldown += interval;
    }
    void dt;
    return out;
  }

  resetCooldown() {
    this.cooldown = Math.max(this.cooldown, 0);
  }
}

/** Fire interrupter: simple keep-out volumes of the airframe in model coordinates. */
export function lineHitsAirframe(originModel: THREE.Vector3, dirModel: THREE.Vector3): boolean {
  const p = new THREE.Vector3();
  for (let s = 1.0; s < 70; s += 0.5) {
    p.copy(originModel).addScaledVector(dirModel, s);
    const zf = p.z; // aft-positive
    const d = zf + 24.7; // station aft of nose
    // fuselage: capsule along z, radius ~1.95, centre rising aft
    const zc = d > 34 ? 0.0 + (d - 34) * 0.07 : 0;
    const rf = d < 4 ? 1.9 * Math.min(1, d / 3.5) : d > 34 ? Math.max(0.5, 1.9 - (d - 34) * 0.095) : 1.95;
    if (d > -0.5 && d < 49.5 && Math.hypot(p.x, p.y - zc) < rf + 0.15) return true;
    // wing (with dihedral) and nacelles/props
    const ax = Math.abs(p.x);
    if (ax < 35.2) {
      const le = 16.55 + ax * 0.2605, te = 26.29 + ax * 0.0507 + 3.4;
      const wz = 0.55 + ax * 0.035;
      if (d > le - 0.5 && d < te && Math.abs(p.y - wz) < 1.3) return true;
    }
    // jet pods
    if (Math.abs(ax - 25.8) < 1.4 && p.y < -0.6 && p.y > -3.4 && d > 19.5 && d < 26.5) return true;
    // vertical fin and horizontal tail
    if (Math.abs(p.x) < 0.7 && p.y > 1.0 && p.y < 10.3 && d > 33.5 && d < 48.6) return true;
    if (ax < 11.5 && Math.abs(p.y - 1.0) < 0.6 && d > 40.5 && d < 48.0) return true;
  }
  return false;
}

/** 20 mm rounds with tracers, in the absolute world (sim) frame inside the World group. */
export class Rounds {
  private pos: THREE.Vector3[] = [];
  private vel: THREE.Vector3[] = [];
  private life: number[] = [];
  private mesh: THREE.InstancedMesh;
  private tmp = new THREE.Object3D();
  onGround: ((p: THREE.Vector3) => void) | null = null;
  static MAX = 1500;

  constructor(group: THREE.Object3D) {
    const geo = new THREE.BoxGeometry(0.06, 0.06, 7);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffb35a });
    this.mesh = new THREE.InstancedMesh(geo, mat, Rounds.MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    group.add(this.mesh);
  }

  spawn(pos: THREE.Vector3, vel: THREE.Vector3) {
    if (this.pos.length >= Rounds.MAX) {
      this.pos.shift();
      this.vel.shift();
      this.life.shift();
    }
    this.pos.push(pos);
    this.vel.push(vel);
    this.life.push(5);
  }

  get count() {
    return this.pos.length;
  }

  update(dt: number) {
    for (let i = this.pos.length - 1; i >= 0; i--) {
      const p = this.pos[i], v = this.vel[i];
      const rho = atmosphere(p.y).density;
      const k = (0.5 * rho * v.length() * GUN.cd * GUN.area) / GUN.mass;
      v.addScaledVector(v, -k * dt);
      v.y -= G0 * dt;
      p.addScaledVector(v, dt);
      this.life[i] -= dt;
      if (p.y <= 0 || this.life[i] <= 0) {
        if (p.y <= 0) this.onGround?.(p.clone());
        this.pos.splice(i, 1);
        this.vel.splice(i, 1);
        this.life.splice(i, 1);
      }
    }
    const n = this.pos.length;
    for (let i = 0; i < n; i++) {
      this.tmp.position.copy(this.pos[i]);
      this.tmp.lookAt(this.pos[i].clone().add(this.vel[i]));
      this.tmp.updateMatrix();
      this.mesh.setMatrixAt(i, this.tmp.matrix);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Collects the turrets from the exterior model. */
export function findTurrets(root: THREE.Object3D): Map<string, Turret> {
  const m = new Map<string, Turret>();
  root.traverse((o) => {
    if ((o.userData as { part?: string }).part === "turret_yaw") m.set(o.name, new Turret(o));
  });
  return m;
}

export function fmVelocityScene(fm: FlightModel) {
  return fm.vel.clone();
}
