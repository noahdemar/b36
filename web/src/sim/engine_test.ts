// Flight engineer systems: start, shutdown, temperatures, fuel and feathering.
// Run: node --experimental-strip-types src/sim/engine_test.ts
import { Autopilot } from "./autopilot.ts";
import { FlightModel } from "./flightmodel.ts";
import { CHT_LIMIT, FUEL_AT_COMBAT_WEIGHT } from "./powerplant.ts";

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
const run = (fm: FlightModel, s: number, each?: (t: number) => void) => {
  for (let t = 0; t < s; t += 1 / 60) { each?.(t); fm.step(1 / 60, 2); }
};

// --- cold start on the ground
{
  const fm = new FlightModel();
  fm.resetSystems(false);
  run(fm, 2);
  const e = fm.pistons[0];
  check(!e.running && e.rpm < 1, "cold and dark: engine 1 stopped");
  e.starter = true;
  run(fm, 6);
  check(!e.running, `starter without ignition or mixture does not start it (rpm ${e.rpm.toFixed(0)})`);
  e.ignition = true;
  e.mixture = 2;
  let tStart = -1;
  run(fm, 15, (t) => { if (tStart < 0 && e.running) tStart = t; });
  e.starter = false;
  check(tStart >= 0 && tStart < 6, `engine 1 starts ${tStart.toFixed(1)} s after ignition and mixture`);
  run(fm, 10);
  check(Math.abs(e.rpm - 700) < 30, `settles at idle (${e.rpm.toFixed(0)} rpm)`);
  e.mixture = 0;
  run(fm, 20);
  check(!e.running && e.rpm < 50, `mixture cutoff stops it (${e.rpm.toFixed(0)} rpm)`);
}

// --- cylinder heads: full power on the ground, cowl flaps closed, no auto engineer
{
  const fm = new FlightModel();
  fm.feAuto = false;
  fm.pistons.forEach((e) => { e.cowl = 0; });
  fm.controls.throttle.fill(1);
  let tLimit = -1;
  run(fm, 400, (t) => { if (tLimit < 0 && fm.pistons[0].cht > CHT_LIMIT) tLimit = t; });
  check(tLimit > 0, `cowls closed at full power: CHT passes the ${CHT_LIMIT} C limit after ${tLimit.toFixed(0)} s`);
  check(fm.pistons[0].failed && !fm.pistons[0].running, `sustained overheat fails the engine (CHT ${fm.pistons[0].cht.toFixed(0)} C)`);
}
{
  const fm = new FlightModel();
  fm.controls.throttle.fill(1);
  run(fm, 300);
  const e = fm.pistons[0];
  check(e.cht < CHT_LIMIT && !e.failed, `auto engineer at full power on the ground: CHT ${e.cht.toFixed(0)} C, cowl ${(e.cowl * 100).toFixed(0)}%`);
}

// --- cruise: 12,000 ft, 70% throttle, autopilot, 30 minutes
{
  const fm = new FlightModel();
  fm.placeInFlight(12_000 * 0.3048, 105, 0);
  fm.controls.throttle.fill(0.7);
  const ap = new Autopilot();
  ap.engage(fm);
  const fuel0 = fm.fuel.total, mass0 = fm.mass;
  let chtMax = 0;
  run(fm, 1800, () => { ap.update(fm, 1 / 60); chtMax = Math.max(chtMax, fm.pistons[2].cht); });
  const burned = fuel0 - fm.fuel.total;
  const ff = fm.pistons.reduce((a, e) => a + e.ff, 0);
  console.log(`     cruise: IAS ${fm.readout.ias_mph.toFixed(0)} mph, fuel flow ${ff.toFixed(0)} lb/hr, burned ${burned.toFixed(0)} lb in 30 min, CHT max ${chtMax.toFixed(0)} C`);
  check(Math.abs(burned - ff / 2) / (ff / 2) < 0.05, "fuel burned matches the indicated fuel flow");
  check(Math.abs((mass0 - fm.mass) / 0.45359237 - burned) < 5, `aircraft lighter by the fuel burned (${((mass0 - fm.mass) / 0.45359237).toFixed(0)} lb)`);
  check(chtMax < CHT_LIMIT, "cruise CHT within limits");
  check(Math.abs(fm.readout.alt_ft - 12_000) < 100, `altitude held (${fm.readout.alt_ft.toFixed(0)} ft)`);
  console.log(`     endurance at this flow with the combat-weight load (${FUEL_AT_COMBAT_WEIGHT} lb): ${(FUEL_AT_COMBAT_WEIGHT / ff).toFixed(1)} h`);
}

// --- fuel starvation in manual mode, automatic sequencing, crossfeed
{
  const fm = new FlightModel();
  fm.placeInFlight(12_000 * 0.3048, 105, 0);
  fm.controls.throttle.fill(0.7);
  fm.fuel.auto = false;
  const tk = fm.fuel.tanks[fm.fuel.selected.L];
  tk.qty = 5;
  run(fm, 20);
  check(!fm.pistons[0].running && !fm.pistons[2].running && fm.pistons[4].running, "left selected tank runs dry: engines 1-3 starve, 4-6 run");
  fm.fuel.cycle("L");
  check(fm.fuel.tanks[fm.fuel.selected.L].qty > 100, `selector moved to ${fm.fuel.tanks[fm.fuel.selected.L].name}`);
  for (const e of fm.pistons.slice(0, 3)) e.starter = true;
  run(fm, 10);
  for (const e of fm.pistons.slice(0, 3)) e.starter = false;
  check(fm.pistons.slice(0, 3).every((e) => e.running), "air start on the new tank");

  const fm2 = new FlightModel();
  fm2.placeInFlight(12_000 * 0.3048, 105, 0);
  fm2.controls.throttle.fill(0.7);
  fm2.fuel.tanks[fm2.fuel.selected.R].qty = 5;
  run(fm2, 20);
  check(fm2.pistons.every((e) => e.running), `auto sequencing switches to ${fm2.fuel.tanks[fm2.fuel.selected.R].name} before starving`);
}

// --- feathering a shut-down engine
{
  const fm = new FlightModel();
  fm.placeInFlight(12_000 * 0.3048, 105, 0);
  const e = fm.pistons[0];
  e.mixture = 0;
  run(fm, 20);
  const wm = e.thrust;
  const wmRpm = e.rpm;
  e.feather = true;
  run(fm, 20);
  check(wm < 0 && wmRpm > 500, `windmilling: ${wmRpm.toFixed(0)} rpm, ${(wm / 1000).toFixed(1)} kN drag`);
  check(e.rpm < 20 && e.thrust > wm * 0.2, `feathered: ${e.rpm.toFixed(0)} rpm, ${(e.thrust / 1000).toFixed(1)} kN drag`);
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
