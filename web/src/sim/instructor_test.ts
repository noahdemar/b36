// Mouse-aim instructor checks. Run: node --experimental-strip-types src/sim/instructor_test.ts
import { Vector3 } from "three";
import { FlightModel } from "./flightmodel.ts";
import { INSTRUCTOR, Instructor } from "./instructor.ts";

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
const aimAt = (hdgDeg: number, gammaDeg: number) => {
  const h = (hdgDeg * Math.PI) / 180, g = (gammaDeg * Math.PI) / 180;
  return new Vector3(Math.sin(h) * Math.cos(g), Math.sin(g), -Math.cos(h) * Math.cos(g));
};
const dh = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

{
  const fm = new FlightModel();
  fm.placeInFlight(4000, 105, 0);
  fm.controls.throttle.fill(0.75);
  fm.damage.randomFailures = false;
  const ins = new Instructor();
  ins.reset(fm);
  let maxBank = 0, maxG = 0, alt0 = fm.readout.alt_ft, maxDev = 0;
  // level turn to 120 deg
  for (let t = 0; t < 120; t += 1 / 60) {
    ins.update(fm, 1 / 60, aimAt(120, 0));
    fm.step(1 / 60, 2);
    maxBank = Math.max(maxBank, Math.abs(fm.readout.roll_deg));
    maxG = Math.max(maxG, fm.damage.loadFactor);
    if (t > 3) maxDev = Math.max(maxDev, Math.abs(fm.readout.alt_ft - alt0));
  }
  check(dh(fm.readout.heading_deg, 120) < 3, `turns to the aim heading (120 -> ${fm.readout.heading_deg.toFixed(1)})`);
  check(maxBank <= INSTRUCTOR.maxBank + 3, `bank within limit (${maxBank.toFixed(1)} deg)`);
  check(maxDev < 300, `level turn holds altitude within 300 ft (${maxDev.toFixed(0)} ft)`);
  check(maxG < 2.0, `load factor below the 2.0 g limit (${maxG.toFixed(2)} g)`);
  // climb aim 8 deg, then dive aim -10 deg
  const a1 = fm.readout.alt_ft;
  for (let t = 0; t < 40; t += 1 / 60) { ins.update(fm, 1 / 60, aimAt(120, 8)); fm.step(1 / 60, 2); maxG = Math.max(maxG, fm.damage.loadFactor); }
  check(fm.readout.alt_ft - a1 > 300, `climbs when aimed up (+${(fm.readout.alt_ft - a1).toFixed(0)} ft in 40 s, IAS ${fm.readout.ias_mph.toFixed(0)} mph)`);
  const a2 = fm.readout.alt_ft;
  for (let t = 0; t < 30; t += 1 / 60) { ins.update(fm, 1 / 60, aimAt(120, -10)); fm.step(1 / 60, 2); maxG = Math.max(maxG, fm.damage.loadFactor); }
  check(a2 - fm.readout.alt_ft > 500, `descends when aimed down (-${(a2 - fm.readout.alt_ft).toFixed(0)} ft in 30 s)`);
  // pull out of the dive to level
  let minG = 9;
  for (let t = 0; t < 30; t += 1 / 60) { ins.update(fm, 1 / 60, aimAt(120, 0)); fm.step(1 / 60, 2); maxG = Math.max(maxG, fm.damage.loadFactor); minG = Math.min(minG, fm.damage.loadFactor); }
  check(Math.abs(fm.readout.vs_fpm) < 600, `levels off (vs ${fm.readout.vs_fpm.toFixed(0)} fpm)`);
  check(maxG < 2.0 && minG > 0, `no overstress through climb, dive and pull-out (${minG.toFixed(2)} to ${maxG.toFixed(2)} g)`);
  check(fm.damage.report().length === 0, "no damage");
  // aim straight behind: reversal turn without exceeding limits
  maxBank = 0;
  for (let t = 0; t < 150; t += 1 / 60) { ins.update(fm, 1 / 60, aimAt(300, 0)); fm.step(1 / 60, 2); maxBank = Math.max(maxBank, Math.abs(fm.readout.roll_deg)); }
  check(dh(fm.readout.heading_deg, 300) < 3 && maxBank < 34, `reverses course (heading ${fm.readout.heading_deg.toFixed(0)}, bank max ${maxBank.toFixed(0)})`);
}

// takeoff with the mouse aimed 6 deg up along the runway
{
  const fm = new FlightModel();
  fm.placeOnGround(new Vector3(0, 0, 0), 0);
  fm.damage.randomFailures = false;
  for (let i = 0; i < 240; i++) fm.step(1 / 60); // settle on the gear
  fm.controls.parkingBrake = false;
  fm.controls.flaps = 0.25;
  fm.flapPos = 0.25;
  fm.controls.throttle.fill(1);
  fm.controls.jetThrottle.fill(1);
  const ins = new Instructor();
  ins.reset(fm);
  let liftoff = -1, maxG = 0;
  for (let t = 0; t < 90; t += 1 / 60) {
    ins.update(fm, 1 / 60, aimAt(0, 6));
    fm.step(1 / 60, 2);
    if (liftoff < 0 && !fm.readout.onGround && fm.readout.agl_ft > 20) liftoff = t;
    maxG = Math.max(maxG, fm.damage.loadFactor);
  }
  check(liftoff > 0 && fm.readout.agl_ft > 500, `takes off and climbs (airborne at ${liftoff.toFixed(0)} s, ${fm.readout.agl_ft.toFixed(0)} ft AGL after 90 s)`);
  check(fm.damage.report().length === 0 && maxG < 2, `clean takeoff (max ${maxG.toFixed(2)} g, no damage)`);
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
