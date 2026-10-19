// What the host sends and how a crew member's game applies it.
//   fast snapshot (30 Hz): aircraft kinematics and controls, turrets, fighters, crew poses, events
//   slow snapshot (5 Hz):  engines, fuel, damage, bombs, range, stations, scenario
// Floats are rounded to what the eye can see (mm, 1e-4 rad) to keep the packets small.
import * as THREE from "three";
import type { FlightModel } from "../sim/flightmodel.ts";
import type { Autopilot } from "../sim/autopilot.ts";
import type { Turret } from "../weapons/turrets.ts";
import type { Fighters } from "../weapons/fighters.ts";
import type { BombSystem } from "../weapons/bombs.ts";
import type { BombingRange } from "../range.ts";
import type { Kin, V3, Q4 } from "./interp.ts";
import { lerp, lerpAngle, sampleKin } from "./interp.ts";

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const v3 = (v: THREE.Vector3): V3 => [r3(v.x), r3(v.y), r3(v.z)];

/** A crew member's pose, always in the aircraft's model frame (x right, y up, z aft). */
export interface Pose {
  id: number;
  name: string;
  mode: string; // seated | walking | climbing | tunnel
  seat: string; // seat name when seated
  deck: string;
  feet: V3;
  eye: V3;
  yaw: number; // look direction, model frame
  pitch: number;
  speed: number; // walking speed, for the stride
  crouch: boolean;
}

export type Ev = (string | number | number[] | (string | number)[][])[];

export interface FastSnap {
  type: "fs";
  t: number;
  k: Kin;
  c: number[]; // controls, see packControls
  fp: number; gp: number; bd: number;
  rpm: number[];
  ap: [number, number, number];
  tu: Record<string, [number, number, number, number, number]>; // az, el, ext, recoil, extendCmd
  fi: [number, ...number[]][]; // id, pos3, vel3, quat4, state, smoking, burning
  pl: Pose[];
  ev: Ev[];
}

export interface SlowSnap {
  type: "ss";
  t: number;
  epoch: number;
  eng: Record<string, number | boolean>[];
  jets: Record<string, number | boolean | undefined>[];
  fuel: { q: number[]; sel: [number, number]; x: boolean; auto: boolean };
  feAuto: boolean;
  mass: number;
  dmg: {
    hp: Record<string, number>; lost: string[]; ef: number[]; tf: number[]; jf: number[]; lk: [number, number][]; ol: [number, number][];
    oil: number[]; ext: number; des: boolean; cr: boolean; why: string; sep: unknown[];
  };
  bombs: { m: string; armed: boolean; mode: string } | null;
  range: { d: boolean[]; hp: (number | null)[]; log: string } | null;
  chart: { wp: { name: string; x: number; z: number }; coupled: boolean };
  scope: { r: number; g: number };
  raid: { waves: number; next: number };
  kills: number;
  fkills: number;
  hours: number;
  ammo: Record<string, [number, number, number, number, number]>;
  seats: Record<string, number>; // seat name -> player id
}

const STATES = ["inbound", "setup", "attack", "break", "extend", "down", "gone"];

export function packControls(fm: FlightModel): number[] {
  const c = fm.controls;
  return [c.elevator, c.aileron, c.rudder, c.trim, ...c.throttle, ...c.jetThrottle, c.flaps, c.gearDown ? 1 : 0, c.brakes,
    c.parkingBrake ? 1 : 0, c.tiller, c.bombDoors].map(r4);
}

export function unpackControls(fm: FlightModel, a: number[]) {
  const c = fm.controls;
  c.elevator = a[0]; c.aileron = a[1]; c.rudder = a[2]; c.trim = a[3];
  for (let i = 0; i < 6; i++) c.throttle[i] = a[4 + i];
  for (let i = 0; i < 4; i++) c.jetThrottle[i] = a[10 + i];
  c.flaps = a[14]; c.gearDown = a[15] > 0.5; c.brakes = a[16]; c.parkingBrake = a[17] > 0.5; c.tiller = a[18]; c.bombDoors = a[19];
}

export const kinOf = (fm: FlightModel): Kin => ({
  p: [r3(fm.pos.x), r3(fm.pos.y), r3(fm.pos.z)], v: [r3(fm.vel.x), r3(fm.vel.y), r3(fm.vel.z)],
  q: [r4(fm.quat.x), r4(fm.quat.y), r4(fm.quat.z), r4(fm.quat.w)], w: [r4(fm.omega.x), r4(fm.omega.y), r4(fm.omega.z)],
});

export interface GameRefs {
  fm: FlightModel;
  ap: Autopilot;
  turrets: Map<string, Turret>;
  fighters: Fighters | null;
  bombs: BombSystem | null;
  range: BombingRange | null;
}

export function buildFast(t: number, g: GameRefs, poses: Pose[], ev: Ev[]): FastSnap {
  const fm = g.fm;
  const tu: FastSnap["tu"] = {};
  for (const [n, x] of g.turrets) tu[n] = [r4(x.az), r4(x.el), r3(x.ext), r3(x.recoil), x.extendCmd ? 1 : 0];
  const fi: FastSnap["fi"] = (g.fighters?.list ?? []).map((f) => [f.id, ...v3(f.pos), ...v3(f.vel),
    r4(f.obj.quaternion.x), r4(f.obj.quaternion.y), r4(f.obj.quaternion.z), r4(f.obj.quaternion.w),
    STATES.indexOf(f.state), f.smoking ? 1 : 0, f.burning ? 1 : 0]);
  return {
    type: "fs", t, k: kinOf(fm), c: packControls(fm), fp: r3(fm.flapPos), gp: r3(fm.gearPos), bd: r3(fm.bombDoorPos),
    rpm: fm.pistons.map((e) => Math.round(e.rpm)), ap: [g.ap.engaged ? 1 : 0, Math.round(g.ap.altitudeFt), r3(g.ap.headingDeg)],
    tu, fi, pl: poses, ev,
  };
}

/**
 * Apply the fast snapshots bracketing the render time: the aircraft is interpolated (Hermite /
 * slerp), turrets and fighters too; discrete things come from the newer snapshot.
 */
export function applyFast(g: GameRefs, a: FastSnap, b: FastSnap, f: number, dt: number) {
  const fm = g.fm;
  const k = sampleKin(a.k, b.k, f, dt);
  fm.pos.set(...k.p);
  fm.vel.set(...k.v);
  fm.quat.set(...(k.q as Q4));
  fm.omega.set(...k.w);
  unpackControls(fm, b.c);
  const ff = Math.max(0, Math.min(1, f));
  fm.flapPos = lerp(a.fp, b.fp, ff);
  fm.gearPos = lerp(a.gp, b.gp, ff);
  fm.bombDoorPos = lerp(a.bd, b.bd, ff);
  fm.pistons.forEach((e, i) => { e.rpm = lerp(a.rpm[i], b.rpm[i], ff); });
  g.ap.engaged = b.ap[0] === 1;
  g.ap.altitudeFt = b.ap[1];
  g.ap.headingDeg = b.ap[2];
  for (const [n, t] of g.turrets) {
    const ta = a.tu[n], tb = b.tu[n];
    if (!tb) continue;
    const s = ta ?? tb;
    t.setPose(lerpAngle(s[0], tb[0], ff), lerp(s[1], tb[1], ff), lerp(s[2], tb[2], ff), tb[3], tb[4] === 1);
  }
  if (g.fighters) {
    const byId = new Map(a.fi.map((x) => [x[0], x]));
    g.fighters.syncFrom(b.fi.map((x) => {
      const y = byId.get(x[0]) ?? x;
      const pos = new THREE.Vector3(lerp(y[1], x[1], ff), lerp(y[2], x[2], ff), lerp(y[3], x[3], ff));
      const qa = new THREE.Quaternion(y[7], y[8], y[9], y[10]), qb = new THREE.Quaternion(x[7], x[8], x[9], x[10]);
      return {
        id: x[0], pos, vel: new THREE.Vector3(x[4], x[5], x[6]), quat: qa.slerp(qb, ff),
        state: STATES[x[11]] ?? "inbound", smoking: x[12] === 1, burning: x[13] === 1,
      };
    }));
  }
}

/** Crew poses between two snapshots (model frame), keyed by player id. */
export function interpPoses(a: FastSnap, b: FastSnap, f: number): Pose[] {
  const ff = Math.max(0, Math.min(1, f));
  const prev = new Map(a.pl.map((p) => [p.id, p]));
  return b.pl.map((p) => {
    const q = prev.get(p.id);
    if (!q || q.mode !== p.mode || q.seat !== p.seat) return p;
    const l3 = (x: V3, y: V3): V3 => [lerp(x[0], y[0], ff), lerp(x[1], y[1], ff), lerp(x[2], y[2], ff)];
    return { ...p, feet: l3(q.feet, p.feet), eye: l3(q.eye, p.eye), yaw: lerpAngle(q.yaw, p.yaw, ff), pitch: lerp(q.pitch, p.pitch, ff) };
  });
}

export function buildSlow(t: number, epoch: number, g: GameRefs, extra: Pick<SlowSnap, "chart" | "scope" | "raid" | "kills" | "fkills" | "hours" | "seats">): SlowSnap {
  const fm = g.fm, d = fm.damage;
  const eng = fm.pistons.map((e) => {
    const o: Record<string, number | boolean> = {};
    for (const [key, v] of Object.entries(e)) if (typeof v === "number") o[key] = r3(v); else if (typeof v === "boolean") o[key] = v;
    return o;
  });
  const jets = fm.jets.map((j) => ({ n: r3(j.n), rpmPct: r3(j.rpmPct), egt: Math.round(j.egt), fuelPress: Math.round(j.fuelPress), oilPress: r3(j.oilPress), failed: j.failed }));
  const hp: Record<string, number> = {};
  for (const c of d.comps) if (c.hp < c.hpMax) hp[c.id] = r3(c.hp);
  const ammo: SlowSnap["ammo"] = {};
  for (const [n, x] of g.turrets) ammo[n] = [x.ammoGun[0], x.ammoGun[1], r3(x.heat), r3(x.jam[0]), r3(x.jam[1])];
  return {
    type: "ss", t, epoch, eng, jets,
    fuel: { q: fm.fuel.tanks.map((x) => Math.round(x.qty)), sel: [fm.fuel.selected.L, fm.fuel.selected.R], x: fm.fuel.crossfeed, auto: fm.fuel.auto },
    feAuto: fm.feAuto, mass: Math.round(fm.mass),
    dmg: {
      hp, lost: d.comps.filter((c) => c.lost).map((c) => c.id), ef: [...d.engineFire], tf: [...d.tankFire], jf: [...d.jetFire],
      lk: [...d.leaks.entries()].map(([i, r]) => [i, r3(r)]), ol: [...d.oilLeak.entries()].map(([i, r]) => [i, r3(r)]),
      oil: d.oil.map(r3), ext: d.extinguishers, des: d.destroyed, cr: d.crashed, why: d.destroyReason, sep: d.separations,
    },
    bombs: g.bombs ? { m: g.bombs.loadedMask, armed: g.bombs.armed, mode: g.bombs.mode } : null,
    range: g.range ? { d: g.range.targets.map((x) => x.destroyed), hp: g.range.targets.map((x) => x.hp ?? null), log: g.range.log[0] ?? "" } : null,
    ammo, ...extra,
  };
}

export function applySlow(g: GameRefs, s: SlowSnap) {
  const fm = g.fm, d = fm.damage;
  s.eng.forEach((o, i) => Object.assign(fm.pistons[i], o));
  s.jets.forEach((o, i) => Object.assign(fm.jets[i], o));
  s.fuel.q.forEach((q, i) => { if (fm.fuel.tanks[i]) fm.fuel.tanks[i].qty = q; });
  fm.fuel.selected.L = s.fuel.sel[0];
  fm.fuel.selected.R = s.fuel.sel[1];
  fm.fuel.crossfeed = s.fuel.x;
  fm.fuel.auto = s.fuel.auto;
  fm.feAuto = s.feAuto;
  fm.mass = s.mass;
  const lost = new Set(s.dmg.lost);
  for (const c of d.comps) { c.hp = s.dmg.hp[c.id] ?? c.hpMax; c.lost = lost.has(c.id); }
  d.engineFire = new Set(s.dmg.ef);
  d.tankFire = new Set(s.dmg.tf);
  d.jetFire = new Set(s.dmg.jf);
  d.leaks = new Map(s.dmg.lk);
  d.oilLeak = new Map(s.dmg.ol);
  d.oil = s.dmg.oil;
  d.extinguishers = s.dmg.ext;
  d.destroyed = s.dmg.des;
  d.crashed = s.dmg.cr;
  d.destroyReason = s.dmg.why;
  if (s.dmg.sep.length !== d.separations.length) d.separations = s.dmg.sep as typeof d.separations;
  if (g.bombs && s.bombs) {
    if (g.bombs.loadedMask !== s.bombs.m) g.bombs.loadedMask = s.bombs.m;
    g.bombs.armed = s.bombs.armed;
    g.bombs.mode = s.bombs.mode as typeof g.bombs.mode;
  }
  if (g.range && s.range) {
    g.range.targets.forEach((x, i) => {
      if (s.range!.d[i] && !x.destroyed) x.destroyed = true;
      x.hp = s.range!.hp[i] ?? undefined;
    });
    if (s.range.log && g.range.log[0] !== s.range.log) g.range.log.unshift(s.range.log);
  }
  for (const [n, a] of Object.entries(s.ammo)) {
    const t = g.turrets.get(n);
    if (!t) continue;
    t.ammoGun = [a[0], a[1]];
    t.heat = a[2];
    t.jam = [a[3], a[4]];
  }
}
