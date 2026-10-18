// Component damage model: hit points per part, effects on the flight model and systems, fires, leaks,
// structural failure, mechanical failures, overstress, hard landings and crashes.
// All hit points, rates and probabilities are ESTIMATED game tuning (see SPEC.md "Damage").
// Positions are model coordinates (x right, y up, z aft; z = d - 24.7).
import { Vector3 } from "three";
import type { FlightModel } from "./flightmodel.ts";

export type Kind = "engine" | "jet" | "tank" | "wing" | "fuselage" | "fin" | "stab" | "cable" | "gear" | "turret";

export interface Component {
  id: string;
  label: string;
  kind: Kind;
  pos: Vector3;
  area: number; // presented area for fragments, m^2
  hpMax: number;
  hp: number;
  index?: number; // engine / jet / tank index
  side?: "L" | "R";
  lost?: boolean; // separated or destroyed
}

/** Multipliers the flight model applies (1 = undamaged). */
export interface Effects {
  liftL: number;
  liftR: number;
  rollLeftPerCL: number; // rolling moment coefficient (roll left +) per unit of undamaged CL
  cdAdd: number;
  ailL: number;
  ailR: number;
  elev: number;
  rud: number;
  cnBeta: number; // directional stability (fin)
  cmAlpha: number; // pitch stability (stabilizers)
  gearOk: Record<string, boolean>;
}

export interface DamageEvent { t: number; msg: string; severe: boolean }

/** Where a separated section is cut (model coordinates) for the renderer. */
export interface Separation { part: "wingL" | "wingR" | "tail"; axis: "x" | "z"; at: number; t: number }

const LIMIT_G = 2.0; // ESTIMATED limit load factor (typical heavy bomber)
const ULTIMATE_G = LIMIT_G * 1.5; // standard 1.5 factor of safety
const VNE_MPH = 330; // ESTIMATED never-exceed IAS
const SINK_LIMIT = 10; // ft/s, ESTIMATED gear design sink rate
const SINK_COLLAPSE = 16; // ft/s, ESTIMATED
const SINK_DESTROY = 25; // ft/s, ESTIMATED
const OIL_GAL = 80; // per engine, ESTIMATED
const OUTER_X = 28; // tip panel break, m: through the aileron (23.7-33.4 m), outboard of the jet pods

function wingMid(x: number) {
  const ax = Math.abs(x);
  const le = 16.55 + 0.2605 * ax, te = 26.29 + 0.0507 * ax;
  return (le + te) / 2 - 24.7;
}

export class DamageModel {
  comps: Component[] = [];
  byId = new Map<string, Component>();
  effects: Effects = DamageModel.fresh();
  events: DamageEvent[] = [];
  separations: Separation[] = [];
  /** Engine fires (index) and tank fires (tank index). */
  engineFire = new Set<number>();
  tankFire = new Set<number>();
  jetFire = new Set<number>();
  leaks = new Map<number, number>(); // tank index -> lb/s
  oilLeak = new Map<number, number>(); // engine -> gal/s
  oil: number[] = [OIL_GAL, OIL_GAL, OIL_GAL, OIL_GAL, OIL_GAL, OIL_GAL];
  seize: number[] = [0, 0, 0, 0, 0, 0]; // s without oil
  extinguishers = 4; // engine fire bottles, ESTIMATED
  destroyed = false;
  crashed = false;
  destroyReason = "";
  randomFailures = true;
  rng: () => number = Math.random;
  loadFactor = 1;
  private prevVel = new Vector3();
  private wasOnGround = true;
  private minVy = 0;
  private t = 0;
  private hasPrev = false;

  static fresh(): Effects {
    return { liftL: 1, liftR: 1, rollLeftPerCL: 0, cdAdd: 0, ailL: 1, ailR: 1, elev: 1, rud: 1, cnBeta: 1, cmAlpha: 1, gearOk: { nose: true, mainL: true, mainR: true } };
  }

  constructor(fm: FlightModel) {
    const add = (c: Omit<Component, "hp">) => {
      const comp = { ...c, hp: c.hpMax };
      this.comps.push(comp);
      this.byId.set(c.id, comp);
    };
    fm.p.piston.x.forEach((x, i) => add({ id: `eng${i + 1}`, label: `Engine ${i + 1}`, kind: "engine", index: i, side: x < 0 ? "L" : "R",
      pos: new Vector3(x, 0.45, 26.29 + 0.0507 * Math.abs(x) - 1.6 - 24.7), area: 4.5, hpMax: 28 }));
    fm.p.jet.x.forEach((x, i) => add({ id: `jet${i + 1}`, label: `Jet ${i + 1}`, kind: "jet", index: i, side: x < 0 ? "L" : "R",
      pos: new Vector3(x, -1.8, 22.6 - 24.7), area: 3, hpMax: 18 }));
    // tank stations: inboard, center, aux, outboard (|x|), matching the FuelSystem tank order
    const tankX: Record<string, number> = { INBOARD: 6, CENTER: 11, AUX: 15.5, OUTBOARD: 25 };
    fm.fuel.tanks.forEach((t, i) => {
      if (t.side === "C") return;
      const ax = tankX[t.name.split(" ")[1]];
      const x = t.side === "L" ? -ax : ax;
      add({ id: `tank${i}`, label: `${t.name} tank`, kind: "tank", index: i, side: t.side, pos: new Vector3(x, 0.55, wingMid(x)), area: 9, hpMax: 30 });
    });
    for (const s of ["L", "R"] as const) {
      const sg = s === "L" ? -1 : 1;
      add({ id: `wingIn${s}`, label: `${s === "L" ? "Left" : "Right"} wing`, kind: "wing", side: s, pos: new Vector3(sg * 13, 0.6, wingMid(13)), area: 100, hpMax: 210 });
      add({ id: `wingOut${s}`, label: `${s === "L" ? "Left" : "Right"} wing tip`, kind: "wing", side: s, pos: new Vector3(sg * 31.5, 1.1, wingMid(31.5)), area: 22, hpMax: 70 });
      add({ id: `stab${s}`, label: `${s === "L" ? "Left" : "Right"} stabilizer`, kind: "stab", side: s, pos: new Vector3(sg * 5.5, 1.0, 20.5), area: 18, hpMax: 60 });
      add({ id: `gear${s}`, label: `${s === "L" ? "Left" : "Right"} main gear`, kind: "gear", side: s, pos: new Vector3(sg * 5.2, -1.6, 0.9), area: 2.5, hpMax: 22 });
      add({ id: `ailCable${s}`, label: `${s === "L" ? "Left" : "Right"} aileron cables`, kind: "cable", side: s, pos: new Vector3(sg * 18, 0.6, 1.5), area: 1.2, hpMax: 6 });
    }
    add({ id: "fusFwd", label: "Forward fuselage", kind: "fuselage", pos: new Vector3(0, 0, -17.5), area: 50, hpMax: 170 });
    add({ id: "fusMid", label: "Center fuselage", kind: "fuselage", pos: new Vector3(0, 0, -1.0), area: 70, hpMax: 200 });
    add({ id: "fusAft", label: "Aft fuselage", kind: "fuselage", pos: new Vector3(0, 0.2, 13.5), area: 45, hpMax: 150 });
    add({ id: "fin", label: "Fin and rudder", kind: "fin", pos: new Vector3(0, 5.0, 21.0), area: 28, hpMax: 75 });
    add({ id: "gearN", label: "Nose gear", kind: "gear", pos: new Vector3(0, -1.6, -19.1), area: 1.5, hpMax: 18 });
    add({ id: "elevCable", label: "Elevator cables", kind: "cable", pos: new Vector3(0, 0.8, 6), area: 1.0, hpMax: 6 });
    add({ id: "rudCable", label: "Rudder cables", kind: "cable", pos: new Vector3(0, 0.9, 7), area: 1.0, hpMax: 6 });
  }

  /** Extra components found on the model at runtime (turrets). */
  addComponent(c: Omit<Component, "hp">) {
    const comp = { ...c, hp: c.hpMax };
    this.comps.push(comp);
    this.byId.set(c.id, comp);
    return comp;
  }

  get(id: string) {
    return this.byId.get(id)!;
  }

  health(id: string) {
    const c = this.byId.get(id);
    return c ? (c.lost ? 0 : Math.max(0, c.hp / c.hpMax)) : 1;
  }

  private log(msg: string, severe = false) {
    this.events.unshift({ t: this.t, msg, severe });
    if (this.events.length > 40) this.events.pop();
  }

  /** Apply damage to a component; side effects (leaks, fires, failures) are rolled per hit. */
  hit(fm: FlightModel, c: Component, dmg: number, hits = 1) {
    if (c.lost || this.destroyed) return;
    const before = c.hp;
    c.hp = Math.max(0, c.hp - dmg);
    const r = this.rng;
    switch (c.kind) {
      case "engine": {
        const e = fm.pistons[c.index!];
        for (let k = 0; k < hits; k++) {
          if (r() < 0.25 && !this.oilLeak.has(c.index!)) { this.oilLeak.set(c.index!, 0.02 + r() * 0.08); this.log(`${c.label}: oil leak`); }
          if (r() < 0.05 && e.running && !this.engineFire.has(c.index!)) { this.engineFire.add(c.index!); this.log(`${c.label} ON FIRE`, true); }
        }
        if (c.hp <= 0 && before > 0) { e.failed = true; this.log(`${c.label} destroyed`, true); }
        break;
      }
      case "jet": {
        if (c.hp <= 0 && before > 0) { fm.jets[c.index!].failed = true; this.log(`${c.label} destroyed`, true); }
        else if (r() < 0.04 * hits && fm.jets[c.index!].n > 0.05) { this.jetFire.add(c.index!); this.log(`${c.label} ON FIRE`, true); }
        break;
      }
      case "tank": {
        for (let k = 0; k < hits; k++) {
          // tanks partly self-sealing: about half of the holes reseal (ESTIMATED)
          if (r() < 0.5) this.leaks.set(c.index!, (this.leaks.get(c.index!) ?? 0) + 2 + r() * 6);
          if (r() < 0.015 && fm.fuel.tanks[c.index!].qty > 200) { this.tankFire.add(c.index!); this.log(`${c.label} ON FIRE`, true); }
        }
        if (this.leaks.has(c.index!)) this.log(`${c.label}: leaking fuel`);
        break;
      }
      case "cable":
        if (c.hp <= 0 && before > 0) this.log(`${c.label} cut`, true);
        break;
      case "gear":
        if (c.hp <= 0 && before > 0) this.log(`${c.label} damaged: will not hold on landing`, true);
        break;
      case "turret":
        if (c.hp <= 0 && before > 0) this.log(`${c.label} out of action`);
        break;
      default:
        if (c.hp <= 0 && before > 0) this.structuralFailure(fm, c);
        else if (before / c.hpMax > 0.5 && c.hp / c.hpMax <= 0.5) this.log(`${c.label} badly damaged`, true);
    }
  }

  /** Fragments from a burst at `burst` (model coordinates). Returns hits per component, for effects. */
  burst(fm: FlightModel, burst: Vector3, fragments: number, maxRange: number): { comp: Component; hits: number }[] {
    const out: { comp: Component; hits: number }[] = [];
    for (const c of this.comps) {
      if (c.lost) continue;
      const r = Math.max(2, c.pos.distanceTo(burst));
      if (r > maxRange) continue;
      const lambda = (fragments * c.area) / (4 * Math.PI * r * r) * (1 - r / maxRange); // fragments slow down
      const n = poisson(lambda, this.rng);
      const blast = r < 10 ? (10 - r) * 3 : 0; // ESTIMATED close-burst blast damage
      if (n > 0 || blast > 0) {
        this.hit(fm, c, n * (0.6 + 0.8 * this.rng()) + blast, n);
        out.push({ comp: c, hits: n });
      }
    }
    return out;
  }

  private structuralFailure(fm: FlightModel, c: Component) {
    c.lost = true;
    if (c.id === "wingOutL" || c.id === "wingOutR") {
      const s = c.side!;
      this.log(`${c.label} has broken off`, true);
      this.separations.push({ part: s === "L" ? "wingL" : "wingR", axis: "x", at: s === "L" ? -OUTER_X : OUTER_X, t: this.t });
      // everything outboard goes with it
      for (const o of this.comps) {
        if (o !== c && !o.lost && Math.abs(o.pos.x) > OUTER_X && Math.sign(o.pos.x) === (s === "L" ? -1 : 1)) {
          o.lost = true;
          o.hp = 0;
          if (o.kind === "engine") { fm.pistons[o.index!].failed = true; fm.pistons[o.index!].feather = true; this.engineFire.delete(o.index!); }
          if (o.kind === "jet") { fm.jets[o.index!].failed = true; this.jetFire.delete(o.index!); }
          if (o.kind === "tank") { fm.fuel.tanks[o.index!].qty = 0; this.leaks.delete(o.index!); this.tankFire.delete(o.index!); }
        }
      }
      fm.addMassLoss(1500); // ESTIMATED tip panel
    } else if (c.id === "wingInL" || c.id === "wingInR") {
      this.log(`${c.label} has failed`, true);
      this.separations.push({ part: c.side === "L" ? "wingL" : "wingR", axis: "x", at: c.side === "L" ? -3 : 3, t: this.t });
      this.destroy("wing structural failure");
    } else if (c.id === "fusAft") {
      this.log("The tail has broken off", true);
      this.separations.push({ part: "tail", axis: "z", at: 15.5, t: this.t });
      for (const id of ["fin", "stabL", "stabR", "rudCable", "elevCable"]) { const o = this.get(id); o.lost = true; o.hp = 0; }
      this.destroy("tail separated");
    } else if (c.id === "fusFwd" || c.id === "fusMid") {
      this.log(`${c.label} structure has failed`, true);
      this.destroy("fuselage structural failure");
    } else {
      this.log(`${c.label} shot away`, true);
    }
  }

  private destroy(reason: string) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyReason = reason;
    this.log(`AIRCRAFT LOST: ${reason}`, true);
  }

  /** FE: discharge a fire bottle into the selected engines. */
  extinguish(fm: FlightModel, engines: number[]): string {
    const burning = engines.filter((i) => this.engineFire.has(i));
    if (!burning.length) return "NO FIRE IN THE SELECTED ENGINE";
    if (this.extinguishers <= 0) return "FIRE BOTTLES EMPTY";
    this.extinguishers--;
    const out: string[] = [];
    for (const i of burning) {
      const e = fm.pistons[i];
      const shut = !e.running && e.mixture === 0;
      if (this.rng() < (shut ? 0.85 : 0.4)) { this.engineFire.delete(i); out.push(`ENGINE ${i + 1} FIRE OUT`); }
      else out.push(`ENGINE ${i + 1} STILL BURNING${shut ? "" : " (shut it down and feather first)"}`);
    }
    return `${out.join(", ")}   (${this.extinguishers} bottles left)`;
  }

  /** Called after each flight model step. */
  update(fm: FlightModel, dt: number) {
    this.t += dt;
    const r = fm.readout;
    if (this.destroyed && this.crashed) return;
    // --- load factor from the CG acceleration along the body up axis
    if (this.hasPrev && fm.vel.distanceTo(this.prevVel) > 20) this.hasPrev = false; // placed / reset, not flown
    if (this.hasPrev && dt > 0) {
      const acc = fm.vel.clone().sub(this.prevVel).divideScalar(dt);
      acc.y += 9.80665;
      const up = new Vector3(0, 1, 0).applyQuaternion(fm.quat);
      const n = acc.dot(up) / 9.80665;
      this.loadFactor += (n - this.loadFactor) * Math.min(1, dt / 0.15);
    }
    this.prevVel.copy(fm.vel);
    this.hasPrev = true;
    if (!r.onGround) {
      const n = this.loadFactor;
      if (n > LIMIT_G || n < -1) {
        const over = n > LIMIT_G ? n - LIMIT_G : -1 - n;
        const rate = over * (n > ULTIMATE_G ? 120 : 30); // hp/s
        for (const id of ["wingInL", "wingInR", "wingOutL", "wingOutR"]) this.hit(fm, this.get(id), rate * dt * (0.8 + 0.4 * this.rng()));
        if (this.rng() < dt * 2) this.log(`OVERSTRESS ${n.toFixed(1)} g`, true);
      }
      if (r.ias_mph > VNE_MPH) {
        const rate = (r.ias_mph - VNE_MPH) * 0.6;
        for (const id of ["stabL", "stabR", "fin", "wingOutL", "wingOutR"]) this.hit(fm, this.get(id), rate * dt * this.rng());
        if (this.rng() < dt) this.log(`OVERSPEED ${r.ias_mph.toFixed(0)} mph: flutter`, true);
      }
      this.minVy = Math.min(0, fm.vel.y);
    }
    // --- touchdown and ground strikes
    if (r.onGround && !this.wasOnGround) this.touchdown(fm, -this.minVy * 3.28084);
    if (r.onGround) this.groundStrikes(fm, dt);
    else this.minVy = fm.vel.y;
    this.wasOnGround = r.onGround as boolean;

    // --- oil and seizure
    fm.pistons.forEach((e, i) => {
      const leak = this.oilLeak.get(i);
      if (leak) this.oil[i] = Math.max(0, this.oil[i] - leak * dt);
      if (this.oil[i] <= 0 && e.running) {
        e.oilP = 0;
        this.seize[i] += dt;
        if (this.seize[i] > 30 && !e.failed) { e.failed = true; this.log(`Engine ${i + 1} seized (no oil)`, true); if (this.rng() < 0.3) this.engineFire.add(i); }
      }
    });
    // --- random mechanical failures, raised by abuse
    if (this.randomFailures) {
      fm.pistons.forEach((e, i) => {
        if (!e.running || e.failed) return;
        let stress = 1;
        if (e.cht > 232) stress += ((e.cht - 232) / 30) * 4;
        if (e.rpm > 2750) stress += (e.rpm - 2750) / 25;
        if (e.oilT > 95) stress += (e.oilT - 95) / 5;
        const perHour = 0.01 * stress; // ESTIMATED
        if (this.rng() < (perHour / 3600) * dt) this.mechanical(fm, i);
      });
      fm.pistons.forEach((e, i) => {
        if (e.rpm > 3000 && this.rng() < dt * 0.2 && !e.failed) { e.failed = true; this.log(`Engine ${i + 1} overspeed: failed`, true); }
      });
    }
    // --- fires
    for (const i of this.engineFire) {
      const comp = this.get(`eng${i + 1}`);
      this.hit(fm, comp, 0.6 * dt, 0);
      const e = fm.pistons[i];
      if (e.running && this.rng() < dt * 0.02) e.failed = true;
      const wing = this.get(Math.abs(comp.pos.x) > OUTER_X ? `wingOut${comp.side}` : `wingIn${comp.side}`);
      this.hit(fm, wing, 0.35 * dt, 0); // fire weakens the wing structure
      if (!e.running && e.mixture === 0 && this.rng() < dt * 0.01) { this.engineFire.delete(i); this.log(`Engine ${i + 1} fire burned out`); }
    }
    for (const i of this.jetFire) {
      this.hit(fm, this.get(`jet${i + 1}`), 0.8 * dt, 0);
      if (fm.controls.jetThrottle[i] < 0.01 && this.rng() < dt * 0.1) { this.jetFire.delete(i); this.log(`Jet ${i + 1} fire out`); }
    }
    for (const ti of this.tankFire) {
      const tk = fm.fuel.tanks[ti];
      const comp = this.get(`tank${ti}`);
      const wing = this.get(Math.abs(comp.pos.x) > OUTER_X ? `wingOut${comp.side}` : `wingIn${comp.side}`);
      this.hit(fm, wing, 1.1 * dt, 0);
      const burn = Math.min(tk.qty, 15 * dt);
      tk.qty -= burn;
      fm.addMassLoss(burn * 0.4536);
      if (tk.qty < 1 || this.rng() < dt * 0.008) { this.tankFire.delete(ti); this.log(`${tk.name} tank fire out`); }
    }
    // --- leaks
    for (const [ti, rate] of this.leaks) {
      const tk = fm.fuel.tanks[ti];
      const l = Math.min(tk.qty, rate * dt);
      tk.qty -= l;
      fm.addMassLoss(l * 0.4536);
    }
    this.computeEffects(fm);
  }

  private mechanical(fm: FlightModel, i: number) {
    const roll = this.rng();
    if (roll < 0.45) { fm.pistons[i].failed = true; this.log(`Engine ${i + 1} failed`, true); }
    else if (roll < 0.75) { this.oilLeak.set(i, 0.03 + this.rng() * 0.1); this.log(`Engine ${i + 1}: oil pressure dropping`); }
    else { this.engineFire.add(i); this.log(`ENGINE ${i + 1} ON FIRE`, true); }
  }

  private touchdown(fm: FlightModel, sinkFps: number) {
    const gearDown = fm.gearPos > 0.98;
    if (sinkFps > SINK_DESTROY) {
      this.crash(fm, `hit the ground at ${sinkFps.toFixed(0)} ft/s`);
      return;
    }
    if (!gearDown) {
      this.log(`Belly landing (${sinkFps.toFixed(0)} ft/s)`, true);
      this.hit(fm, this.get("fusMid"), 20 + sinkFps * 3);
      return;
    }
    if (sinkFps > SINK_LIMIT) {
      const sev = (sinkFps - SINK_LIMIT) / (SINK_COLLAPSE - SINK_LIMIT);
      for (const id of ["gearL", "gearR", "gearN"]) this.hit(fm, this.get(id), this.get(id).hpMax * sev * (0.7 + 0.6 * this.rng()));
      this.hit(fm, this.get("fusMid"), 10 * sev);
      this.log(`HARD LANDING ${sinkFps.toFixed(1)} ft/s`, true);
    } else if (sinkFps > 2) this.log(`Touchdown ${sinkFps.toFixed(1)} ft/s`);
  }

  /** Wingtips, props, nacelles and fuselage touching the ground. */
  private groundStrikes(fm: FlightModel, dt: number) {
    const V = fm.vel.length();
    const off = fm.modelOffset;
    const toWorldY = (p: Vector3) => p.clone().add(off).applyQuaternion(fm.quat).y + fm.pos.y;
    const probes: [string, Vector3, number][] = [
      ["wingOutL", new Vector3(-34.5, 1.6, 4.0), 1], ["wingOutR", new Vector3(34.5, 1.6, 4.0), 1],
      ["eng1", new Vector3(-19.64, -2.45, 4.3), 0.6], ["eng6", new Vector3(19.64, -2.45, 4.3), 0.6],
      ["eng2", new Vector3(-13.57, -2.45, 4.0), 0.6], ["eng5", new Vector3(13.57, -2.45, 4.0), 0.6],
      ["eng3", new Vector3(-7.69, -2.45, 3.7), 0.6], ["eng4", new Vector3(7.69, -2.45, 3.7), 0.6],
      ["fusAft", new Vector3(0, -1.2, 20.0), 1],
    ];
    for (const [id, p, k] of probes) {
      const c = this.get(id);
      if (c.lost) continue;
      if (toWorldY(p) < 0) {
        this.hit(fm, c, (5 + V * 0.6) * k * dt * 10);
        if (this.rng() < dt * 3) this.log(`${c.label} struck the ground`, true);
      }
    }
    // gear collapsed or retracted: fuselage on the runway at speed
    if (V > 60 && (fm.gearPos < 0.5 || !this.effects.gearOk.mainL || !this.effects.gearOk.mainR)) {
      if (Math.abs(fm.readout.roll_deg) > 25 || Math.abs(fm.readout.pitch_deg) > 20) this.crash(fm, "cartwheeled on the ground");
    }
  }

  crash(fm: FlightModel, why: string) {
    this.crashed = true;
    this.destroy(why);
    fm.vel.set(0, 0, 0);
    fm.omega.set(0, 0, 0);
  }

  private computeEffects(fm: FlightModel) {
    const h = (id: string) => this.health(id);
    const e = this.effects;
    // Each wing half: the main panel carries ~88% of its lift with its centroid at ~0.2 b from the
    // centreline, the tip ~12% at ~0.45 b (ESTIMATED from the tapered planform). A damaged panel loses up
    // to 30% of its lift, a lost one all of it. Uneven lift gives a rolling moment per unit CL.
    const loss = (id: string) => (this.get(id).lost ? 1 : 0.3 * (1 - h(id)));
    const side = (s: "L" | "R") => {
      const li = loss(`wingIn${s}`), lo = loss(`wingOut${s}`);
      return { lift: 1 - 0.88 * li - 0.12 * lo, moment: 0.5 * (0.88 * li * 0.2 + 0.12 * lo * 0.45) };
    };
    const L = side("L"), R = side("R");
    e.liftL = L.lift;
    e.liftR = R.lift;
    e.rollLeftPerCL = L.moment - R.moment;
    let cd = 0;
    for (const c of this.comps) {
      if (c.kind === "wing" || c.kind === "fuselage" || c.kind === "fin" || c.kind === "stab") cd += 0.004 * (1 - (c.lost ? 1 : c.hp / c.hpMax)) * (c.area / 50);
    }
    e.cdAdd = cd;
    const ailCable = (s: "L" | "R") => (this.get(`ailCable${s}`).hp > 0 ? 1 : 0);
    e.ailL = (this.get("wingOutL").lost ? 0.44 : 0.6 + 0.4 * h("wingOutL")) * ailCable("L");
    e.ailR = (this.get("wingOutR").lost ? 0.44 : 0.6 + 0.4 * h("wingOutR")) * ailCable("R");
    const stab = (h("stabL") + h("stabR")) / 2;
    e.elev = (this.get("elevCable").hp > 0 ? 1 : 0.1) * (0.3 + 0.7 * stab) * (this.get("fin").lost && this.get("fusAft").lost ? 0 : 1);
    e.rud = (this.get("rudCable").hp > 0 ? 1 : 0.05) * (this.get("fin").lost ? 0 : 0.3 + 0.7 * h("fin"));
    e.cnBeta = this.get("fin").lost ? -0.3 : 0.4 + 0.6 * h("fin");
    e.cmAlpha = this.get("stabL").lost && this.get("stabR").lost ? -0.4 : 0.4 + 0.6 * stab;
    e.gearOk = { nose: this.get("gearN").hp > 0, mainL: this.get("gearL").hp > 0, mainR: this.get("gearR").hp > 0 };
  }

  /** Summary for the FE / pilots: worst components first. */
  report(n = 8): string[] {
    return this.comps.filter((c) => c.hp < c.hpMax || c.lost)
      .sort((a, b) => a.hp / a.hpMax - b.hp / b.hpMax).slice(0, n)
      .map((c) => `${c.label} ${c.lost ? "LOST" : `${Math.round((100 * c.hp) / c.hpMax)}%`}`);
  }
}

function poisson(lambda: number, rng: () => number) {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss(rng)));
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

export function gauss(rng: () => number) {
  return Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-12))) * Math.cos(2 * Math.PI * rng());
}
