// Flight engineer's systems: six R-4360 engines (start, ignition, mixture, rpm lever, turbo boost,
// cowl flaps, feathering, cylinder head and oil temperature) and the fuel system.
// Figures marked ESTIMATED are game tuning, not from a B-36 source; see SPEC.md "Engine management".
import { atmosphere } from "./atmosphere.ts";
import type { AircraftParams } from "./params.ts";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const HP = 745.7;

export type Mixture = 0 | 1 | 2; // cutoff, auto-lean, auto-rich
export const MIXTURE_NAMES = ["CUTOFF", "AUTO LEAN", "AUTO RICH"];

/** Engineer's per-engine controls. The pilots' throttles stay in Controls.throttle. */
export interface EngineControls {
  rpmLever: number; // 0..1 -> RPM_LEVER range
  boost: number; // 0..1 turbo boost selector
  mixture: Mixture;
  cowl: number; // 0..1 cowl flap opening
  ignition: boolean;
  starter: boolean; // held
  feather: boolean;
}

export interface Engine extends EngineControls {
  rpm: number;
  map: number; // inHg
  thrust: number; // N
  power: number; // W
  running: boolean;
  failed: boolean;
  cht: number; // C
  oilT: number; // C
  oilP: number; // psi
  ff: number; // lb/hr
  damage: number; // 0..1, failure at 1
  crank: number; // s of firing while cranking
  starve: number; // s without fuel
}

export const RPM_LEVER = [1200, 2700]; // ESTIMATED governor range
export const CHT_LIMIT = 260; // C, ESTIMATED (red line)
const CHT_TAU = 60; // s, ESTIMATED
const OIL_TAU = 180; // s, ESTIMATED
const BSFC = { rich: 0.55, lean: 0.45 }; // lb/hp/hr, ESTIMATED
const JET_TSFC = 1.0; // lb/lbf/hr, ESTIMATED for the J47
const LB = 0.45359237;

export interface Tank { name: string; side: "L" | "R" | "C"; cap: number; qty: number } // lb

// B-36H capacity DERIVED: B-36J total 36,396 gal minus the J's 2,770 gal outer-panel tanks = 33,626 gal
// (warhistory.org). 6.0 lb/gal from 30,600 gal = 183,600 lb (featherweight B-36J figure).
// The split over the 9 tanks (bomb bay + 2 x outboard, center, inboard, auxiliary; aeroantique.com
// gauge listing) is ESTIMATED. The bomb bay tank is not fitted when all four bays carry bombs.
export const FUEL_LB_PER_GAL = 6.0;
export const FUEL_CAPACITY_GAL = 36_396 - 2_770;
const WING_SPLIT: [string, number][] = [["OUTBOARD", 0.18], ["CENTER", 0.30], ["INBOARD", 0.33], ["AUX", 0.19]];

// Fuel aboard at the default (combat) weight, DERIVED: 262,500 lb combat weight - 165,887 lb empty
// (armedconflicts.com) - 48,000 lb bombs - 3,000 lb crew (ESTIMATED, 15 x 200 lb)
// - 6,000 lb ammunition and stores (ESTIMATED).
export const FUEL_AT_COMBAT_WEIGHT = 262_500 - 165_887 - 48_000 - 3_000 - 6_000;

export class FuelSystem {
  tanks: Tank[] = [];
  selected: Record<"L" | "R", number> = { L: 0, R: 0 }; // tank index per manifold
  crossfeed = false;
  auto = true; // automatic tank sequencing (the AI engineer)

  constructor(totalLb = FUEL_AT_COMBAT_WEIGHT) {
    const sideCap = (FUEL_CAPACITY_GAL * FUEL_LB_PER_GAL) / 2;
    for (const side of ["L", "R"] as const) {
      for (const [n, f] of WING_SPLIT) this.tanks.push({ name: `${side} ${n}`, side, cap: sideCap * f, qty: 0 });
    }
    this.tanks.push({ name: "BOMB BAY", side: "C", cap: 0, qty: 0 });
    this.fill(totalLb);
  }

  get total() {
    return this.tanks.reduce((a, t) => a + t.qty, 0);
  }

  side(s: "L" | "R") {
    return this.tanks.filter((t) => t.side === s).reduce((a, t) => a + t.qty, 0);
  }

  /** Distribute a total proportionally to capacity. */
  fill(totalLb: number) {
    const cap = this.tanks.reduce((a, t) => a + t.cap, 0);
    for (const t of this.tanks) t.qty = (t.cap * Math.min(totalLb, cap)) / cap;
    this.selected = { L: this.indexOf("L INBOARD"), R: this.indexOf("R INBOARD") };
  }

  indexOf(name: string) {
    return this.tanks.findIndex((t) => t.name === name);
  }

  /** Cycle the manifold's tank selector through that side's tanks. */
  cycle(side: "L" | "R") {
    const own = this.tanks.map((t, i) => [t, i] as const).filter(([t]) => t.side === side).map(([, i]) => i);
    const k = own.indexOf(this.selected[side]);
    this.selected[side] = own[(k + 1) % own.length];
  }

  /** Burns fuel for one manifold; returns false if no fuel reached the engines. */
  draw(side: "L" | "R", lb: number): boolean {
    if (lb <= 0) return true;
    if (this.auto) {
      const cur = this.tanks[this.selected[side]];
      if (cur.qty <= 1) {
        let best = this.selected[side];
        this.tanks.forEach((t, i) => { if (t.side === side && t.qty > this.tanks[best].qty) best = i; });
        this.selected[side] = best;
      }
    }
    const order = [this.tanks[this.selected[side]]];
    if (this.crossfeed) order.push(this.tanks[this.selected[side === "L" ? "R" : "L"]]);
    let need = lb;
    for (const t of order) {
      const take = Math.min(need, t.qty);
      t.qty -= take;
      need -= take;
    }
    return need < lb * 0.5;
  }
}

export function makeEngine(running: boolean): Engine {
  return {
    rpmLever: 1, boost: 1, mixture: running ? 2 : 0, cowl: 1, ignition: running, starter: false, feather: false,
    rpm: running ? 700 : 0, map: 29.9, thrust: 0, power: 0, running, failed: false,
    cht: running ? 150 : 15, oilT: running ? 60 : 15, oilP: 0, ff: 0, damage: 0, crank: 0, starve: 0,
  };
}

/** Automatic cowl flaps (the AI engineer): hold CHT near 215 C. */
export function autoCowl(e: Engine, dt: number) {
  e.cowl = clamp(e.cowl + (e.cht - 215) * 0.004 * dt, 0, 1);
}

/** One engine step. side manifold fuel availability is resolved by the caller. */
export function stepEngine(e: Engine, p: AircraftParams, thrIn: number, air: ReturnType<typeof atmosphere>,
  V: number, dt: number, fuelOk: boolean) {
  const pp = p.piston;
  const oat = air.temperature - 273.15;
  const ambientInHg = air.pressure / 3386.39;
  const thr = clamp(thrIn, 0, 1);
  if (!fuelOk) e.starve += dt;
  else e.starve = 0;

  // running / stopping
  if (e.running && (!e.ignition || e.mixture === 0 || e.starve > 4 || e.failed || e.feather)) e.running = false;
  const cranking = e.starter && !e.running && !e.failed;
  if (cranking && e.ignition && e.mixture > 0 && fuelOk && e.rpm > 200) {
    e.crank += dt;
    if (e.crank > 3) e.running = true; // ESTIMATED time to catch
  } else if (!cranking) e.crank = 0;

  // rpm
  const lever = RPM_LEVER[0] + (RPM_LEVER[1] - RPM_LEVER[0]) * e.rpmLever;
  let rpmTarget: number;
  if (e.running) rpmTarget = pp.rpmIdle + (lever - pp.rpmIdle) * Math.sqrt(thr);
  else if (cranking) rpmTarget = 280; // ESTIMATED starter speed
  else if (e.feather) rpmTarget = 0;
  else rpmTarget = Math.min(lever, V * 10); // windmilling, ESTIMATED
  const tau = e.running || cranking ? pp.spoolTau : 4;
  e.rpm += (rpmTarget - e.rpm) * (1 - Math.exp(-dt / tau));

  // power: the original fitted law, times boost-dependent critical altitude and mixture
  const critAlt = 1500 + e.boost * (pp.criticalAltitude - 1500); // ESTIMATED: internal blower only at 0
  const crit = atmosphere(critAlt).density;
  const altFactor = air.density >= crit ? 1 : air.density / crit;
  const lean = e.mixture === 1;
  if (e.running) {
    const rpmF = clamp((e.rpm - 300) / (pp.rpmMax - 300), 0, 1);
    e.power = pp.powerTakeoff * (0.04 + 0.96 * thr) * altFactor * rpmF * (lean ? 0.97 : 1);
    e.map = Math.min(52, 15 + 37 * thr * Math.min(1, altFactor * 1.05));
  } else {
    e.power = 0;
    e.map = ambientInHg;
  }
  const area = Math.PI * (pp.propDiameter / 2) ** 2;
  if (e.running) {
    const tDyn = (pp.propEtaMax * e.power) / Math.max(V, 1);
    const tStatic = pp.staticFigureOfMerit * Math.cbrt(2 * air.density * area * e.power * e.power);
    e.thrust = Math.min(tDyn, tStatic);
  } else {
    e.thrust = -0.5 * air.density * V * V * area * (e.feather ? 0.004 : 0.08); // windmill drag, ESTIMATED
  }

  // temperatures
  const pf = e.power / pp.powerTakeoff;
  const heat = e.running ? 150 * pf * (lean ? 1 + 0.6 * Math.max(0, pf - 0.6) : 1) : 0;
  const cooling = (0.45 + 0.55 * e.cowl) * (0.7 + 0.3 * Math.min(V / 110, 1));
  const chtEq = oat + heat / cooling + (e.running ? 40 : 0) * (1 - pf); // idle cylinders stay warm
  e.cht += (chtEq - e.cht) * (1 - Math.exp(-dt / CHT_TAU));
  const oilEq = e.running ? Math.max(oat, 0) * 0.3 + 55 + 30 * pf : oat;
  e.oilT += (oilEq - e.oilT) * (1 - Math.exp(-dt / OIL_TAU));
  e.oilP = e.rpm > 150 ? clamp(25 + 60 * (e.rpm / 2700), 0, 90) * (e.oilT < 20 ? 1.2 : 1) : 0;
  if (e.cht > CHT_LIMIT + 20 && e.running) e.damage += ((e.cht - CHT_LIMIT) / 400) * dt;
  if (e.damage >= 1) e.failed = true;

  // fuel
  e.ff = e.running ? (e.power / HP) * (lean ? BSFC.lean : BSFC.rich) + 60 : 0; // +idle flow, ESTIMATED
  return e.ff / 3600 * dt; // lb this step
}

export function jetFuelFlow(thrustN: number) {
  return (thrustN / 4.44822) * JET_TSFC; // lb/hr
}

export const FUEL_KG_PER_LB = LB;
