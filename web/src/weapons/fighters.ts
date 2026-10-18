// Enemy jet fighters (MiG-15bis) attacking the bomber: setup at a chosen clock position, curve-of-pursuit
// firing pass with lead, break away, extend, repeat. Their cannon rounds are simulated and hit the
// bomber's damage components. World (sim) frame: x east, y up, z south.
//
// MiG-15bis figures SOURCED (DCS product page, aerocorner, War Thunder wiki; agree with each other):
// span 10.08 m, length 10.1 m, 1,076 km/h at sea level, 990 km/h at 10,000 m, one N-37D 37 mm with
// 40 rounds (400 rounds/min), two NR-23 23 mm with 80 rounds each. Everything else ESTIMATED.
import * as THREE from "three";
import { G0 } from "../sim/atmosphere.ts";
import { type Component, gauss } from "../sim/damage.ts";
import type { FlightModel } from "../sim/flightmodel.ts";
import { segPointDist2 } from "./ballistics.ts";
import { insideAirframe, Rounds } from "./turrets.ts";

export const MIG = {
  span: 10.08, // m, SOURCED
  length: 10.1, // m, SOURCED
  vmaxSL: 1076 / 3.6, // m/s, SOURCED
  vmax10k: 990 / 3.6, // m/s, SOURCED
  nAttack: 4.5, // g in the firing pass, ESTIMATED
  nBreak: 6.0, // g breaking away, ESTIMATED
  accel: 7, // m/s^2 available for speed changes, ESTIMATED
  hp: 9, // 20 mm hits to bring one down on average (ESTIMATED; ignores critical hits)
  hitRadius: 2.4, // m, effective presented radius for a 20 mm round (about 18 m^2), ESTIMATED
  pilotAim: 0.02, // rad, pilot tracking error (wanders over about 1 s), ESTIMATED
  leadErr: 0.3, // fraction, error in the lead the pilot pulls, ESTIMATED
  guns: [
    // N-37D: SOURCED rate and load; muzzle velocity, dispersion and damage ESTIMATED
    { name: "37 mm", rpm: 400, rounds: 40, muzzle: 690, sigma: 0.005, dmg: 7, range: 700, mass: 0.735, cd: 0.32, cal: 0.037 },
    // 2 x NR-23: SOURCED load; rate 850/min, muzzle velocity, dispersion and damage ESTIMATED
    { name: "23 mm", rpm: 850 * 2, rounds: 160, muzzle: 690, sigma: 0.004, dmg: 2.2, range: 900, mass: 0.2, cd: 0.32, cal: 0.023 },
  ],
};

export type FighterState = "inbound" | "setup" | "attack" | "break" | "extend" | "down" | "gone";

/** Attack geometries: clock (o'clock, 12 = ahead), elevation (deg above the bomber), setup range (m). */
const PASSES: { clock: number; elev: number; range: number }[] = [
  { clock: 1.5, elev: 25, range: 2600 }, { clock: 10.5, elev: 25, range: 2600 },
  { clock: 3, elev: 10, range: 2200 }, { clock: 9, elev: 10, range: 2200 },
  { clock: 5, elev: 15, range: 2200 }, { clock: 7, elev: 15, range: 2200 },
  { clock: 6, elev: 5, range: 2000 }, { clock: 6, elev: -10, range: 2000 },
  { clock: 12, elev: 5, range: 3500 }, { clock: 4, elev: -15, range: 2200 },
];

export class Fighter {
  readonly id: number;
  readonly obj: THREE.Group;
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  prevPos = new THREE.Vector3();
  hp = MIG.hp;
  state: FighterState = "inbound";
  t = 0;
  pass = PASSES[0];
  aimOffset = new THREE.Vector3();
  aimErr = new THREE.Vector3();
  leadK = 1;
  ammo = MIG.guns.map((g) => g.rounds);
  cooldown = MIG.guns.map(() => 0);
  burning = false;
  smoking = false;
  firing = false;
  bank = 0;
  breakDir = new THREE.Vector3();
  /** Seconds until a burning fighter comes apart. */
  fuse = 0;
  spin = 0;
  killedBy = -1;

  constructor(id: number, obj: THREE.Group) {
    this.id = id;
    this.obj = obj;
  }

  get alive() {
    return this.state !== "down" && this.state !== "gone";
  }
}

export interface EnemyHit { comp: Component; dmg: number; pointModel: THREE.Vector3; fromModel: THREE.Vector3; big: boolean }

export class Fighters {
  list: Fighter[] = [];
  rounds: Rounds;
  rng: () => number = Math.random;
  private group: THREE.Object3D;
  private nextId = 1;
  private template: THREE.Group;
  /** Hits on the bomber (damage already applied). */
  onHit: ((h: EnemyHit) => void) | null = null;
  /** A fighter starts a firing pass (for crew call-outs). */
  onAttack: ((f: Fighter) => void) | null = null;
  /** A fighter is hit by a 20 mm round (tag: who fired), or goes down. */
  onStruck: ((f: Fighter, tag: number, killed: boolean) => void) | null = null;
  onExplode: ((f: Fighter) => void) | null = null;
  /** Gun fire from a fighter this frame (world muzzle position), for flashes and sound. */
  onFire: ((f: Fighter, muzzle: THREE.Vector3, gun: number) => void) | null = null;
  waves = 0;
  kills = 0;

  constructor(group: THREE.Object3D) {
    this.group = group;
    this.template = buildMig();
    this.rounds = new Rounds(group, 0xd8ffd0, 0x40ff60); // greenish-white enemy tracers (ESTIMATED colour)
    const g23 = MIG.guns[1]; // one ballistic law for both calibres (they differ little inside 1 km)
    this.rounds.round = { mass: g23.mass, cd: g23.cd, area: Math.PI * (g23.cal / 2) ** 2, muzzle: g23.muzzle };
  }

  get active() {
    return this.list.filter((f) => f.alive).length;
  }

  clear() {
    for (const f of this.list) this.group.remove(f.obj);
    this.list = [];
    this.rounds.clear();
  }

  /** A wave of `n` fighters appears 9-12 km out, in pairs, from random bearings. */
  spawnWave(fm: FlightModel, n = 4) {
    this.waves++;
    const fwd = horizFwd(fm);
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const base = this.rng() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const bearing = base + (Math.floor(i / 2) * Math.PI * 0.7) + (i % 2) * 0.06;
      const dist = 9000 + this.rng() * 3000;
      const f = new Fighter(this.nextId++, this.template.clone());
      f.pos.copy(fm.pos).addScaledVector(fwd, Math.cos(bearing) * dist).addScaledVector(right, Math.sin(bearing) * dist);
      f.pos.y = fm.pos.y + 600 + this.rng() * 900;
      f.vel.copy(fm.pos).sub(f.pos).normalize().multiplyScalar(vmax(f.pos.y) * 0.85);
      f.prevPos.copy(f.pos);
      f.state = "inbound";
      f.pass = PASSES[Math.floor(this.rng() * PASSES.length)];
      f.t = -i * 4; // stagger the first passes
      this.group.add(f.obj);
      this.list.push(f);
    }
  }

  update(fm: FlightModel, dt: number) {
    for (const f of this.list) {
      f.prevPos.copy(f.pos);
      f.t += dt;
      if (f.state === "gone") continue;
      if (f.state === "down") this.fall(f, dt);
      else this.fly(f, fm, dt);
      f.pos.addScaledVector(f.vel, dt);
      this.pose(f, dt);
    }
    // enemy rounds: hits on the bomber, checked in model coordinates against the airframe volumes
    const inv = fm.quat.clone().invert();
    const off = fm.modelOffset;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3();
    this.rounds.onSegment = (wa, wb, tag) => {
      if (segPointDist2(wa, wb, fm.pos) > 60 * 60) return false;
      a.copy(wa).sub(fm.pos).applyQuaternion(inv).sub(off);
      b.copy(wb).sub(fm.pos).applyQuaternion(inv).sub(off);
      const len = a.distanceTo(b);
      const n = Math.max(1, Math.ceil(len / 0.4));
      for (let k = 1; k <= n; k++) {
        p.copy(a).lerp(b, k / n);
        if (!insideAirframe(p, 0, true)) continue;
        this.hitBomber(fm, p.clone(), a.clone(), tag);
        return true;
      }
      return false;
    };
    this.rounds.update(dt);
    // remove fighters that are finished
    for (let i = this.list.length - 1; i >= 0; i--) {
      const f = this.list[i];
      if (f.state === "gone" || (f.state === "extend" && f.pos.distanceTo(fm.pos) > 20_000)) {
        this.group.remove(f.obj);
        this.list.splice(i, 1);
      }
    }
  }

  private hitBomber(fm: FlightModel, pt: THREE.Vector3, from: THREE.Vector3, gun: number) {
    const g = MIG.guns[gun];
    const d = fm.damage;
    // the component nearest the hit point, relative to its size
    let best: Component | null = null, bs = Infinity;
    for (const c of d.comps) {
      if (c.lost) continue;
      const s = c.pos.distanceTo(pt) / Math.sqrt(c.area);
      if (s < bs) { bs = s; best = c; }
    }
    if (!best) return;
    const dmg = g.dmg * (0.7 + 0.6 * this.rng());
    d.hit(fm, best, dmg, 1);
    this.onHit?.({ comp: best, dmg, pointModel: pt, fromModel: from, big: gun === 0 });
  }

  /** A 20 mm round's path this frame (world) against the fighters; returns true on a hit. */
  struck(a: THREE.Vector3, b: THREE.Vector3, tag: number, dt: number): boolean {
    const r2 = MIG.hitRadius * MIG.hitRadius;
    const ra = new THREE.Vector3(), rb = new THREE.Vector3();
    for (const f of this.list) {
      if (f.state === "gone") continue;
      if (Math.abs(a.x - f.pos.x) > 400 || Math.abs(a.z - f.pos.z) > 400) continue;
      // relative motion: the fighter moved during the frame too
      ra.copy(a).sub(f.pos).addScaledVector(f.vel, dt);
      rb.copy(b).sub(f.pos);
      if (segPointDist2(ra, rb, ZERO) > r2) continue;
      if (f.state === "down") return true; // wreck: absorbs the round, no more credit
      f.hp -= 1;
      if (this.rng() < 0.06 && !f.burning) { f.burning = true; f.fuse = 3 + this.rng() * 5; } // fuel or engine fire
      if (f.hp < MIG.hp * 0.5) f.smoking = true;
      const killed = f.hp <= 0 || this.rng() < 0.025; // pilot or critical structure (ESTIMATED)
      if (killed) this.kill(f, tag);
      this.onStruck?.(f, tag, killed);
      return true;
    }
    return false;
  }

  private kill(f: Fighter, tag: number) {
    if (!f.alive) return;
    f.state = "down";
    f.killedBy = tag;
    f.smoking = true;
    f.burning = f.burning || this.rng() < 0.6;
    f.spin = (this.rng() < 0.5 ? -1 : 1) * (1.5 + this.rng() * 2.5);
    f.t = 0;
    this.kills++;
    if (this.rng() < 0.35) { this.onExplode?.(f); f.state = "gone"; } // came apart in the air
  }

  private fly(f: Fighter, fm: FlightModel, dt: number) {
    const fwdB = horizFwd(fm);
    const rightB = new THREE.Vector3(-fwdB.z, 0, fwdB.x);
    const toB = fm.pos.clone().sub(f.pos);
    const range = toB.length();
    let want = new THREE.Vector3();
    let speed = vmax(f.pos.y) * 0.9;
    let nmax = MIG.nAttack;
    f.firing = false;
    if (f.burning && f.alive) {
      f.fuse -= dt;
      if (f.fuse <= 0) { this.kill(f, f.killedBy); return; }
    }
    const setupPoint = () => {
      const ang = (f.pass.clock / 12) * Math.PI * 2;
      const el = (f.pass.elev * Math.PI) / 180;
      const dir = fwdB.clone().multiplyScalar(Math.cos(ang)).addScaledVector(rightB, Math.sin(ang)).multiplyScalar(Math.cos(el));
      dir.y = Math.sin(el);
      return fm.pos.clone().addScaledVector(dir, f.pass.range).addScaledVector(fm.vel, 6);
    };
    switch (f.state) {
      case "inbound":
      case "setup": {
        const sp = setupPoint();
        want = sp.clone().sub(f.pos);
        if (f.t > 0 && (want.length() < 650 || f.t > 30)) {
          f.state = "attack";
          f.t = 0;
          // aim at the wing roots and inboard engines more than the nose (ESTIMATED)
          f.aimOffset.set(gauss(this.rng) * 8, gauss(this.rng) * 1.0, gauss(this.rng) * 6);
          f.leadK = 1 + gauss(this.rng) * MIG.leadErr;
          this.onAttack?.(f);
        }
        break;
      }
      case "attack": {
        // lead pursuit: aim where the bomber will be after the shells' time of flight
        const g = MIG.guns[1];
        const aimB = fm.pos.clone().add(f.aimOffset.clone().applyQuaternion(fm.quat));
        const closing = Math.max(0, f.vel.clone().sub(fm.vel).dot(toB.clone().normalize()));
        const tof = range / (g.muzzle + closing);
        const lead = aimB.clone().addScaledVector(fm.vel, tof * f.leadK);
        lead.y += 0.5 * G0 * tof * tof; // shell drop
        // the pilot's tracking error wanders
        f.aimErr.multiplyScalar(1 - dt).addScaledVector(new THREE.Vector3(gauss(this.rng), gauss(this.rng), gauss(this.rng)), MIG.pilotAim * Math.sqrt(2 * dt));
        want = lead.clone().sub(f.pos).normalize().add(f.aimErr);
        speed = vmax(f.pos.y) * 0.95;
        const off = f.vel.clone().normalize().angleTo(want.clone().normalize());
        if (range < 950 && off < 0.04) this.fireGuns(f, fm, dt, range);
        // break off before collision: about 1.6 s of closure, never inside 180 m
        if (range < Math.max(180, closing * 1.6) || f.t > 25 || (range < 1200 && off > 1.2)) {
          f.state = "break";
          f.t = 0;
          const side = this.rng() < 0.5 ? -1 : 1;
          f.breakDir.copy(f.vel).normalize().cross(new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(side);
          f.breakDir.y = this.rng() < 0.6 ? -0.8 : 0.5;
          f.breakDir.add(f.vel.clone().normalize()).normalize();
        }
        break;
      }
      case "break":
        want.copy(f.breakDir);
        nmax = MIG.nBreak;
        if (f.t > 2.5) { f.state = "extend"; f.t = 0; }
        break;
      case "extend": {
        want = f.pos.clone().sub(fm.pos);
        want.y = 0.1 * want.length();
        speed = vmax(f.pos.y);
        // damaged fighters go home; the rest come round again
        if (f.hp < MIG.hp * 0.35 && this.rng() < 0.5 * dt) { f.state = "gone"; break; }
        if (range > 2000 || f.t > 9) {
          f.state = "setup";
          f.t = 0;
          f.pass = PASSES[Math.floor(this.rng() * PASSES.length)];
          if (f.ammo.every((a) => a <= 0)) { f.pass = { clock: 0, elev: 30, range: 20_000 }; f.state = "extend"; }
        }
        break;
      }
    }
    // turn toward `want` at the load factor limit, change speed at a fixed rate
    const v = f.vel.length();
    const cur = f.vel.clone().divideScalar(v);
    const tgt = want.lengthSq() > 1e-6 ? want.normalize() : cur.clone();
    const ang = cur.angleTo(tgt);
    const maxTurn = ((G0 * nmax) / Math.max(v, 50)) * dt;
    let dir = cur;
    if (ang > 1e-5) {
      const axis = cur.clone().cross(tgt).normalize();
      if (axis.lengthSq() < 0.5) axis.set(0, 1, 0);
      dir = cur.clone().applyAxisAngle(axis, Math.min(ang, maxTurn));
      // bank into the turn (visual)
      const turnRight = axis.y < 0 ? 1 : -1;
      f.bank += (turnRight * Math.min(1.35, (ang / maxTurn) * 0.9) - f.bank) * Math.min(1, dt * 3);
    } else f.bank *= 1 - Math.min(1, dt * 2);
    const climb = dir.y;
    const nv = Math.max(140, Math.min(vmax(f.pos.y) * 1.05, v + Math.max(-MIG.accel, Math.min(MIG.accel, speed - v)) * dt - G0 * climb * dt * 0.6));
    f.vel.copy(dir).multiplyScalar(nv);
  }

  private fireGuns(f: Fighter, fm: FlightModel, dt: number, range: number) {
    const fwd = f.vel.clone().normalize();
    for (let gi = 0; gi < MIG.guns.length; gi++) {
      const g = MIG.guns[gi];
      f.cooldown[gi] -= dt;
      if (range > g.range || f.ammo[gi] <= 0) { f.cooldown[gi] = Math.max(0, f.cooldown[gi]); continue; }
      while (f.cooldown[gi] <= 0 && f.ammo[gi] > 0) {
        f.cooldown[gi] += 60 / g.rpm;
        f.ammo[gi]--;
        f.firing = true;
        const dir = fwd.clone().add(new THREE.Vector3(gauss(this.rng), gauss(this.rng), gauss(this.rng)).multiplyScalar(g.sigma)).normalize();
        const muzzle = f.pos.clone().addScaledVector(fwd, 3.5);
        this.rounds.spawn(muzzle, f.vel.clone().addScaledVector(dir, g.muzzle), gi === 0 || f.ammo[gi] % 2 === 0, 3.5, gi);
        this.onFire?.(f, muzzle, gi);
      }
    }
    void fm;
  }

  private fall(f: Fighter, dt: number) {
    // out of control: spiral down, fire and smoke, impact
    const v = f.vel.length();
    f.vel.y -= G0 * dt * 0.8;
    f.vel.applyAxisAngle(new THREE.Vector3(0, 1, 0), f.spin * 0.25 * dt);
    if (v > 260) f.vel.multiplyScalar(260 / v);
    f.bank += f.spin * dt;
    if (f.pos.y <= 5) { this.onExplode?.(f); f.state = "gone"; }
  }

  private pose(f: Fighter, dt: number) {
    void dt;
    const fwd = f.vel.clone().normalize();
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), fwd, new THREE.Vector3(0, 1, 0)); // -z along fwd
    f.obj.quaternion.setFromRotationMatrix(m).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -f.bank));
    f.obj.position.copy(f.pos);
  }
}

const ZERO = new THREE.Vector3();

function vmax(alt: number) {
  const k = Math.max(0, Math.min(1, alt / 10_000));
  return MIG.vmaxSL + (MIG.vmax10k - MIG.vmaxSL) * k;
}

function horizFwd(fm: FlightModel) {
  const v = fm.vel.clone().setY(0);
  if (v.lengthSq() < 1) v.set(0, 0, -1).applyQuaternion(fm.quat).setY(0);
  return v.normalize();
}

/** Clock position and high/low of a world point as seen from the bomber, for crew calls. */
export function clockCall(fm: FlightModel, p: THREE.Vector3): string {
  const fwd = horizFwd(fm);
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const d = p.clone().sub(fm.pos);
  let clock = Math.round((Math.atan2(d.dot(right), d.dot(fwd)) / (Math.PI * 2)) * 12);
  if (clock <= 0) clock += 12;
  const el = Math.atan2(d.y, Math.hypot(d.x, d.z)) * 180 / Math.PI;
  return `${clock} o'clock ${el > 10 ? "high" : el < -10 ? "low" : "level"}`;
}

/** Low-poly MiG-15 in natural metal, nose along -z, about 10 m long. */
function buildMig(): THREE.Group {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0xb9bec4, metalness: 0.75, roughness: 0.38, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1d20, metalness: 0.2, roughness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x223040, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.7 });
  const red = new THREE.MeshStandardMaterial({ color: 0xb01818, roughness: 0.6 });
  // fuselage: lathe profile along the y axis, then laid along z
  const prof: [number, number][] = [[0.0, 0.52], [0.25, 0.6], [1.2, 0.72], [3.2, 0.78], [5.5, 0.72], [7.6, 0.55], [9.6, 0.42], [10.1, 0.40]];
  const lathe = new THREE.LatheGeometry(prof.map(([z, r]) => new THREE.Vector2(r, z)), 20);
  lathe.rotateX(Math.PI / 2);
  lathe.translate(0, 0, -5.0);
  const fus = new THREE.Mesh(lathe, metal);
  fus.scale.set(1, 1.12, 1);
  g.add(fus);
  const intake = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20), dark);
  intake.position.set(0, 0, -5.0);
  intake.rotation.y = Math.PI;
  g.add(intake);
  const nozzle = new THREE.Mesh(new THREE.CircleGeometry(0.36, 16), new THREE.MeshBasicMaterial({ color: 0x401808 }));
  nozzle.position.set(0, 0, 5.11);
  g.add(nozzle);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), glass);
  canopy.scale.set(1, 0.9, 2.2);
  canopy.position.set(0, 0.7, -2.6);
  g.add(canopy);
  // swept wing (35 deg), slight anhedral
  const wingShape = (span: number, root: number, tip: number, sweep: number) => {
    const s = new THREE.Shape();
    const tipLe = span * Math.tan(sweep);
    s.moveTo(0, 0);
    s.lineTo(span, tipLe);
    s.lineTo(span, tipLe + tip);
    s.lineTo(0, root);
    s.closePath();
    return s;
  };
  for (const side of [-1, 1]) {
    const geo = new THREE.ExtrudeGeometry(wingShape(MIG.span / 2 - 0.6, 3.0, 1.5, (35 * Math.PI) / 180), { depth: 0.14, bevelEnabled: false });
    geo.rotateX(Math.PI / 2); // shape x = span, shape y = chord along +z
    const w = new THREE.Mesh(geo, metal);
    w.position.set(side * 0.6, -0.1, -1.4);
    w.scale.x = side;
    w.rotation.z = side * -0.035;
    g.add(w);
    const star = new THREE.Mesh(starGeometry(0.42), red);
    star.rotation.x = -Math.PI / 2;
    star.position.set(side * 3.2, -0.09, 1.4);
    g.add(star);
    // horizontal tail, high on the fin
    const tgeo = new THREE.ExtrudeGeometry(wingShape(1.6, 1.4, 0.8, (40 * Math.PI) / 180), { depth: 0.08, bevelEnabled: false });
    tgeo.rotateX(Math.PI / 2);
    const t = new THREE.Mesh(tgeo, metal);
    t.position.set(side * 0.05, 1.75, 3.6);
    t.scale.x = side;
    g.add(t);
  }
  const fgeo = new THREE.ExtrudeGeometry(wingShape(2.1, 2.8, 1.3, (55 * Math.PI) / 180), { depth: 0.1, bevelEnabled: false });
  // shape x (span) -> up, shape y (chord) -> aft, extrusion -> thickness across
  fgeo.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
  const fin = new THREE.Mesh(fgeo, metal);
  fin.position.set(-0.05, 0.4, 2.0);
  g.add(fin);
  const finStar = new THREE.Mesh(starGeometry(0.32), red);
  finStar.position.set(0.06, 1.2, 3.7);
  finStar.rotation.y = Math.PI / 2;
  g.add(finStar);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return g;
}

function starGeometry(r: number) {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? r * 0.4 : r;
    if (i === 0) s.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else s.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  return new THREE.ShapeGeometry(s);
}
