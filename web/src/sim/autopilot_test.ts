// Run: node --experimental-strip-types src/sim/autopilot_test.ts
import { Autopilot } from "./autopilot.ts";
import { FlightModel } from "./flightmodel.ts";

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
const fm = new FlightModel();
fm.placeInFlight(4000, 100, 90);
fm.controls.throttle.fill(0.62);
const ap = new Autopilot();
ap.engage(fm);
const alt0 = fm.readout.alt_ft;
let maxDev = 0;
for (let t = 0; t < 120; t += 1 / 60) {
  ap.update(fm, 1 / 60);
  fm.step(1 / 60, 2);
  if (t > 5) maxDev = Math.max(maxDev, Math.abs(fm.readout.alt_ft - alt0));
}
check(maxDev < 120, `holds altitude over 120 s (max deviation ${maxDev.toFixed(0)} ft)`);
check(Math.abs(fm.readout.heading_deg - 90) < 2, `holds heading (${fm.readout.heading_deg.toFixed(1)} deg)`);
ap.turn(90);
let maxBank = 0;
for (let t = 0; t < 120; t += 1 / 60) {
  ap.update(fm, 1 / 60);
  fm.step(1 / 60, 2);
  maxBank = Math.max(maxBank, Math.abs(fm.readout.roll_deg));
  if (t > 5) maxDev = Math.max(maxDev, Math.abs(fm.readout.alt_ft - alt0));
}
const hdgErr = Math.abs(((fm.readout.heading_deg - 180 + 540) % 360) - 180);
check(hdgErr < 3, `turns to the new heading 180 (now ${fm.readout.heading_deg.toFixed(1)})`);
check(maxBank <= 22, `bank stays within limits (${maxBank.toFixed(1)} deg)`);
check(maxDev < 200, `altitude within 200 ft through the turn (${maxDev.toFixed(0)} ft)`);
ap.altitudeFt += 2000;
fm.controls.throttle.fill(0.9); // climb power (no autothrottle)
const startAlt = fm.readout.alt_ft;
let minIas = 999;
for (let t = 0; t < 180; t += 1 / 60) { ap.update(fm, 1 / 60); fm.step(1 / 60, 2); if (t > 10) minIas = Math.min(minIas, fm.readout.ias_mph); }
const gained = fm.readout.alt_ft - startAlt;
check(gained > 500, `climbs toward the new altitude (+${gained.toFixed(0)} ft in 180 s, ${(gained / 3).toFixed(0)} ft/min)`);
check(minIas > 148, `speed protection keeps IAS above 148 mph (min ${minIas.toFixed(0)})`);
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
