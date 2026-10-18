// Headless performance checks of the flight model against published B-36 figures.
// Run: node --experimental-strip-types src/sim/perf_test.ts
import { Vector3 } from "three";
import { atmosphere, G0 } from "./atmosphere.ts";
import { FlightModel } from "./flightmodel.ts";
import { AIRCRAFT } from "./params.ts";

const FT = 0.3048;
const MPH = 0.44704;
const p = AIRCRAFT;

// Published targets (SOURCED: NMUSAF B-36J-III via Wikipedia). Weight/altitude conditions for the
// max speed and climb figures are not stated in the source.
const TARGETS = {
  maxSpeedMph: 435,
  cruiseMph: 230,
  serviceCeilingFt: 43_600,
  climbFpm: 1_995,
};

function thrustAvailable(fm: FlightModel, altM: number, V: number, jets: boolean) {
  fm.pos.y = altM;
  fm.resetSystems(true); // fresh fuel and engines for each sample (the sweep would otherwise burn it all)
  fm.controls.throttle.fill(1);
  fm.controls.jetThrottle.fill(jets ? 1 : 0);
  fm.vel.set(0, 0, -V);
  // settle engine spools at this condition
  const air = atmosphere(altM);
  for (let i = 0; i < 400; i++) (fm as unknown as { updateSystems: (dt: number, a: typeof air, v: number) => void }).updateSystems(0.1, air, V);
  return fm.pistons.reduce((a, e) => a + e.thrust, 0) + fm.jets.reduce((a, j) => a + j.thrust, 0);
}

function dragLevel(mass: number, altM: number, V: number, gear = 0, flaps = 0) {
  const air = atmosphere(altM);
  const q = 0.5 * air.density * V * V;
  const CL = (mass * G0) / (q * p.wingArea);
  const k = 1 / (Math.PI * p.oswald * p.aspectRatio);
  const CD = p.cd0 + p.cdGear * gear + p.cdFlaps * flaps + k * CL * CL;
  return { D: q * p.wingArea * CD, CL };
}

function maxSpeed(mass: number, altM: number, jets: boolean) {
  const fm = new FlightModel(AIRCRAFT, mass);
  let best = 0;
  for (let V = 60; V < 260; V += 0.5) {
    const { D, CL } = dragLevel(mass, altM, V);
    if (CL > p.clMaxClean) continue;
    if (thrustAvailable(fm, altM, V, jets) >= D) best = V;
  }
  return best;
}

function bestClimb(mass: number, altM: number, jets: boolean) {
  const fm = new FlightModel(AIRCRAFT, mass);
  let best = { roc: -1e9, V: 0 };
  for (let V = 70; V < 200; V += 1) {
    const { D, CL } = dragLevel(mass, altM, V);
    if (CL > p.clMaxClean * 0.85) continue;
    const roc = ((thrustAvailable(fm, altM, V, jets) - D) * V) / (mass * G0);
    if (roc > best.roc) best = { roc, V };
  }
  return best;
}

function ceiling(mass: number, jets: boolean, minRocFpm = 100) {
  for (let h = 0; h < 20_000; h += 100) {
    if (bestClimb(mass, h, jets).roc * 196.85 < minRocFpm) return h;
  }
  return 20_000;
}

function stallSpeed(mass: number, flaps: number) {
  const clMax = p.clMaxClean + (p.clMaxFlaps - p.clMaxClean) * flaps;
  return Math.sqrt((2 * mass * G0) / (1.225 * p.wingArea * clMax));
}

function takeoffRoll(mass: number, jets: boolean, flaps = 0.4) {
  const fm = new FlightModel(AIRCRAFT, mass);
  fm.placeOnGround(new Vector3(0, 0, 0), 0);
  for (let i = 0; i < 240; i++) fm.step(1 / 60); // settle on gear
  const c = fm.controls;
  c.parkingBrake = false;
  c.flaps = flaps;
  fm.flapPos = flaps;
  c.throttle.fill(1);
  c.jetThrottle.fill(jets ? 1 : 0);
  const start = fm.pos.clone();
  const vr = stallSpeed(mass, flaps) * 1.1;
  for (let t = 0; t < 180; t += 1 / 60) {
    const V = fm.readout.tas_mps;
    if (V > vr) c.elevator = Math.min(1, Math.max(-1, (8 - fm.readout.pitch_deg) * 0.15));
    fm.step(1 / 60);
    if (!fm.readout.onGround && fm.readout.agl_ft > 3) {
      return { dist: start.distanceTo(fm.pos), t, V: fm.readout.ias_mph };
    }
  }
  return { dist: NaN, t: NaN, V: NaN };
}

function row(name: string, value: string, target: string) {
  console.log(`${name.padEnd(44)} ${value.padStart(12)}   ${target}`);
}

const m = p.massDefault;
console.log(`Mass ${(m / 0.45359).toFixed(0)} lb, CD0 ${p.cd0}, e ${p.oswald}`);
let vmax = 0;
let vmaxAlt = 0;
for (let h = 0; h <= 14_000; h += 1000) {
  const v = maxSpeed(m, h, true);
  if (v > vmax) {
    vmax = v;
    vmaxAlt = h;
  }
}
row("Max level speed, 10 engines (mph @ ft)", `${(vmax / MPH).toFixed(0)} @ ${(vmaxAlt / FT).toFixed(0)}`, `pub ${TARGETS.maxSpeedMph} mph (alt n/a)`);
row("Max level speed, pistons only, 25,000 ft (mph)", (maxSpeed(m, 25_000 * FT, false) / MPH).toFixed(0), "");
const sl = bestClimb(m, 0, true);
row("SL climb, 10 engines (ft/min)", `${(sl.roc * 196.85).toFixed(0)} @ ${(sl.V / MPH).toFixed(0)} mph`, `pub ${TARGETS.climbFpm} (cond. n/a)`);
const slp = bestClimb(m, 0, false);
row("SL climb, pistons only (ft/min)", `${(slp.roc * 196.85).toFixed(0)} @ ${(slp.V / MPH).toFixed(0)} mph`, "");
row("Service ceiling (100 ft/min), 10 engines (ft)", (ceiling(m, true) / FT).toFixed(0), `pub ${TARGETS.serviceCeilingFt}`);
row("Stall speed clean / full flap (mph)", `${(stallSpeed(m, 0) / MPH).toFixed(0)} / ${(stallSpeed(m, 1) / MPH).toFixed(0)}`, "");
const cr = dragLevel(m, 25_000 * FT, TARGETS.cruiseMph * MPH / Math.sqrt(atmosphere(25_000 * FT).sigma) );
void cr;
const to = takeoffRoll(m, true);
row("Takeoff ground roll, 10 engines (ft)", `${(to.dist / FT).toFixed(0)} in ${to.t.toFixed(0)} s @ ${to.V.toFixed(0)} mph`, "");
const toMax = takeoffRoll(p.massMaxTakeoff, true);
row("Takeoff ground roll at 410,000 lb (ft)", `${(toMax.dist / FT).toFixed(0)} in ${toMax.t.toFixed(0)} s`, "");
