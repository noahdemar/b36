// B-36H defensive system: 8 remotely controlled turrets, 16 x 20 mm M24A1.
// Turret nodes come from the exterior glTF: "Turret_X" (yaw about local +y) with child
// "Turret_X_Guns" (pitch about local +x); guns point along local -z.
// Figures marked ESTIMATED are typical values, not from a B-36 source.
import * as THREE from "three";
import { stepRound } from "./ballistics.ts";
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
// Barrel heat and stoppages (ESTIMATED game tuning): heat 1.0 after about 7 s of continuous fire,
// cooling time constant 25 s; stoppage chance per round rises steeply above 0.6; the gun is
// recharged (cleared) after 2.5 s.
const HEAT_PER_ROUND = 1 / 90;
const COOL_TAU = 25;
const STOP_BASE = 0.0008;
const STOP_HOT = 0.03;
const CLEAR_TIME = 2.5;
const EXTEND_TIME = 4; // s, ESTIMATED
const CLIP_BELOW_PIVOT = 0.09; // m: well clip plane below the extended ring (inside the outer skin, outside the cabin lining)

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
  /** Rounds left per gun (left, right). */
  ammoGun = [GUN.roundsPerGun, GUN.roundsPerGun];
  /** Barrel heat (0 cold, 1 hot), and seconds until each gun is cleared after a stoppage (0 = firing). */
  heat = 0;
  jam = [0, 0];
  /** Guns lagging the commanded direction, or held at a mechanical limit. */
  slewing = false;
  atLimit = false;
  recoil = 0;
  rng: () => number = Math.random;
  private cooldown = [0, 0];
  private pitchRest: THREE.Vector3;
  /** Well clipping plane (world space, updated every frame) and its point in the parent frame. */
  readonly clip = new THREE.Plane();
  private clipPoint: THREE.Vector3 | null = null;

  constructor(yawNode: THREE.Object3D) {
    this.name = yawNode.name;
    this.yawNode = yawNode;
    this.pitchNode = yawNode.getObjectByName(yawNode.name + "_Guns")!;
    this.kind = this.name.includes("Nose") ? "nose" : this.name.includes("Tail") ? "tail"
      : this.name.includes("Lower") ? "lower" : "upper";
    this.baseYawQ = yawNode.quaternion.clone();
    this.basePitchQ = this.pitchNode.quaternion.clone();
    this.pitchRest = this.pitchNode.position.clone();
    this.stowPos = yawNode.position.clone();
    this.extendDir = new THREE.Vector3(0, 1, 0).applyQuaternion(this.baseYawQ);
    this.retract = Number((yawNode.userData as { retract?: number }).retract ?? 0);
    this.ext = this.retract > 0 ? 0 : 1;
    if (this.retract > 0) {
      // Retractable turrets rise out of a well: everything below the skin line is clipped away, so a
      // moving or extended turret never shows inside the crew compartments or the tunnel.
      this.clipPoint = this.stowPos.clone().addScaledVector(this.extendDir, this.retract - CLIP_BELOW_PIVOT);
      yawNode.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((x) => {
          const c = x.clone();
          c.clippingPlanes = [this.clip];
          c.clipShadows = true;
          return c;
        });
        m.material = Array.isArray(m.material) ? mats : mats[0];
      });
    }
    this.barrel = this.kind === "nose" ? 1.4 : this.kind === "tail" ? 1.8 : 2.0;
  }

  get ammo() {
    return this.ammoGun[0] + this.ammoGun[1];
  }

  rearm() {
    this.ammoGun = [GUN.roundsPerGun, GUN.roundsPerGun];
    this.heat = 0;
    this.jam = [0, 0];
  }

  /** A direction (base-frame az/el) inside the mechanical limits. */
  within(az: number, el: number) {
    const lim = LIMITS[this.kind];
    if (lim.az && (az < lim.az[0] || az > lim.az[1])) return false;
    return el >= lim.el[0] && el <= lim.el[1];
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
    if (this.clipPoint) {
      const pm = this.yawNode.parent!.matrixWorld;
      const n = this.extendDir.clone().transformDirection(pm);
      this.clip.setFromNormalAndCoplanarPoint(n, this.clipPoint.clone().applyMatrix4(pm));
    }
    const lim = LIMITS[this.kind];
    let { az, el } = cmd ?? { az: 0, el: 0 };
    if (!this.ready) { az = 0; el = 0; }
    const az0 = az, el0 = el;
    if (lim.az) az = Math.max(lim.az[0], Math.min(lim.az[1], az));
    el = Math.max(lim.el[0], Math.min(lim.el[1], el));
    this.atLimit = !!cmd && (az !== az0 || el !== el0);
    let daz = az - this.az;
    if (!lim.az) daz = Math.atan2(Math.sin(daz), Math.cos(daz));
    const step = SLEW * dt;
    this.slewing = !!cmd && Math.hypot(daz, el - this.el) > 1.5 * DEG;
    this.az += Math.max(-step, Math.min(step, daz));
    this.el += Math.max(-step, Math.min(step, el - this.el));
    this.heat *= Math.exp(-dt / COOL_TAU);
    for (let g = 0; g < 2; g++) this.jam[g] = Math.max(0, this.jam[g] - dt);
    this.recoil = Math.max(0, this.recoil - dt * 12);
    this.pitchNode.position.copy(this.pitchRest).add(new THREE.Vector3(0, 0, 0.05 * this.recoil).applyQuaternion(this.pitchNode.quaternion));
    this.yawNode.quaternion.copy(this.baseYawQ).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.az));
    this.pitchNode.quaternion.copy(this.basePitchQ).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.el));
  }

  /** Fire if ready. Returns muzzle (scene coords) and direction for each round fired this frame, and
   * whether the interrupter stopped a gun (`blocked` says when the line of fire crosses the airframe). */
  fire(dt: number, blocked?: (pos: THREE.Vector3, dir: THREE.Vector3) => boolean) {
    const shots: { pos: THREE.Vector3; dir: THREE.Vector3; gun: number }[] = [];
    let interrupted = false;
    if (!this.ready) return { shots, interrupted };
    const interval = 60 / GUN.rpm;
    const q = this.pitchNode.getWorldQuaternion(new THREE.Quaternion());
    for (let g = 0; g < 2; g++) {
      this.cooldown[g] -= dt;
      if (this.jam[g] > 0 || this.ammoGun[g] <= 0) { this.cooldown[g] = Math.max(this.cooldown[g], 0); continue; }
      while (this.cooldown[g] <= 0 && this.ammoGun[g] > 0) {
        this.cooldown[g] += interval;
        const pos = this.pitchNode.localToWorld(new THREE.Vector3(g ? 0.2 : -0.2, 0.12, -this.barrel));
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
        if (blocked?.(pos, dir)) { interrupted = true; continue; }
        shots.push({ pos, dir, gun: g });
        this.ammoGun[g]--;
        this.heat += HEAT_PER_ROUND;
        this.recoil = 1;
        if (this.rng() < STOP_BASE + STOP_HOT * Math.max(0, this.heat - 0.6)) { this.jam[g] = CLEAR_TIME; break; }
      }
    }
    return { shots, interrupted };
  }

  resetCooldown() {
    // second gun half a cycle behind the first, so a pair fires alternately
    const interval = 60 / GUN.rpm;
    this.cooldown = [Math.max(this.cooldown[0], 0), Math.max(this.cooldown[1], interval / 2)];
  }
}

/** Simple solid volumes of the airframe in model coordinates (x right, y up, z aft): used by the fire
 * interrupter and for enemy hits. */
export function insideAirframe(p: THREE.Vector3, pad = 0.15, tight = false): boolean {
  const d = p.z + 24.7; // station aft of nose
  // fuselage: capsule along z, radius ~1.95, centre rising aft
  const zc = d > 34 ? 0.0 + (d - 34) * 0.07 : 0;
  const rf = d < 4 ? 1.9 * Math.min(1, d / 3.5) : d > 34 ? Math.max(0.5, 1.9 - (d - 34) * 0.095) : 1.95;
  if (d > -0.5 && d < 49.5 && Math.hypot(p.x, p.y - zc) < rf + pad) return true;
  // wing (with dihedral) and nacelles/props
  const ax = Math.abs(p.x);
  if (ax < 35.2) {
    const le = 16.55 + ax * 0.2605, te = 26.29 + ax * 0.0507 + 3.4;
    const wz = 0.55 + ax * 0.035;
    // generous slab for the interrupter (nacelles and props); the real wing section for hits
    const half = tight ? Math.max(0.3, 1.15 - ax * 0.025) : 1.3;
    if (d > le - 0.5 && d < te && Math.abs(p.y - wz) < half) return true;
  }
  // jet pods
  if (Math.abs(ax - 25.8) < 1.4 && p.y < -0.6 && p.y > -3.4 && d > 19.5 && d < 26.5) return true;
  // vertical fin and horizontal tail
  if (Math.abs(p.x) < 0.7 && p.y > 1.0 && p.y < 10.3 && d > 33.5 && d < 48.6) return true;
  if (ax < 11.5 && Math.abs(p.y - 1.0) < 0.6 && d > 40.5 && d < 48.0) return true;
  return false;
}

/** Fire interrupter: the line of fire crosses the airframe within 70 m. */
export function lineHitsAirframe(originModel: THREE.Vector3, dirModel: THREE.Vector3): boolean {
  const p = new THREE.Vector3();
  for (let s = 1.0; s < 70; s += 0.5) {
    p.copy(originModel).addScaledVector(dirModel, s);
    if (insideAirframe(p)) return true;
  }
  return false;
}

/** Gun rounds in the absolute world (sim) frame inside the World group. Every round is simulated (for
 * hits); tracer rounds are drawn as glowing streaks. */
export class Rounds {
  private pos: THREE.Vector3[] = [];
  private vel: THREE.Vector3[] = [];
  private life: number[] = [];
  private tracer: boolean[] = [];
  private tag: number[] = [];
  private fresh: boolean[] = []; // fired this frame: already at the muzzle at the current time
  private mesh: THREE.InstancedMesh;
  private glow: THREE.InstancedMesh;
  private tmp = new THREE.Object3D();
  private prev = new THREE.Vector3();
  onGround: ((p: THREE.Vector3) => void) | null = null;
  /** Called for each round's path this frame; return true when it hit something (the round is removed). */
  onSegment: ((a: THREE.Vector3, b: THREE.Vector3, tag: number) => boolean) | null = null;
  static MAX = 2500;
  round = { mass: GUN.mass, cd: GUN.cd, area: GUN.area, muzzle: GUN.muzzle };

  constructor(group: THREE.Object3D, color = 0xffa040, glowColor = 0xff5a10) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mk = (c: number, opacity: number) => new THREE.MeshBasicMaterial({
      color: c, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mk(color, 1), Rounds.MAX);
    this.glow = new THREE.InstancedMesh(geo, mk(glowColor, 0.35), Rounds.MAX);
    for (const m of [this.mesh, this.glow]) {
      m.count = 0;
      m.frustumCulled = false;
      group.add(m);
    }
  }

  /** tag: who fired (passed back to onSegment). */
  spawn(pos: THREE.Vector3, vel: THREE.Vector3, tracer = true, life = 5, tag = 0) {
    if (this.pos.length >= Rounds.MAX) {
      this.pos.shift();
      this.vel.shift();
      this.life.shift();
      this.tracer.shift();
      this.tag.shift();
      this.fresh.shift();
    }
    this.pos.push(pos);
    this.vel.push(vel);
    this.life.push(life);
    this.tracer.push(tracer);
    this.tag.push(tag);
    this.fresh.push(true);
  }

  get count() {
    return this.pos.length;
  }

  clear() {
    this.pos.length = this.vel.length = this.life.length = this.tracer.length = this.tag.length = this.fresh.length = 0;
  }

  update(dt: number) {
    for (let i = this.pos.length - 1; i >= 0; i--) {
      if (this.fresh[i]) { this.fresh[i] = false; continue; }
      const p = this.pos[i], v = this.vel[i];
      this.prev.copy(p);
      stepRound(this.round, p, v, dt);
      this.life[i] -= dt;
      const hit = this.onSegment?.(this.prev, p, this.tag[i]) ?? false;
      if (hit || p.y <= 0 || this.life[i] <= 0) {
        if (p.y <= 0 && !hit) this.onGround?.(p.clone());
        this.pos.splice(i, 1);
        this.vel.splice(i, 1);
        this.life.splice(i, 1);
        this.tracer.splice(i, 1);
        this.tag.splice(i, 1);
        this.fresh.splice(i, 1);
      }
    }
    let n = 0;
    for (let i = 0; i < this.pos.length; i++) {
      if (!this.tracer[i]) continue;
      const v = this.vel[i];
      const len = Math.min(14, v.length() * 0.012); // streak: about 12 ms of travel (persistence of vision)
      this.tmp.position.copy(this.pos[i]).addScaledVector(v, -0.006);
      this.tmp.lookAt(this.pos[i].clone().add(v));
      this.tmp.scale.set(0.07, 0.07, len);
      this.tmp.updateMatrix();
      this.mesh.setMatrixAt(n, this.tmp.matrix);
      this.tmp.scale.set(0.35, 0.35, len * 1.1);
      this.tmp.updateMatrix();
      this.glow.setMatrixAt(n, this.tmp.matrix);
      n++;
    }
    for (const m of [this.mesh, this.glow]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    }
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
