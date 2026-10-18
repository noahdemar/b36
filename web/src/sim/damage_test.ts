// Damage model checks. Run: node --experimental-strip-types src/sim/damage_test.ts
import { Vector3 } from "three";
import { Autopilot } from "./autopilot.ts";
import { FlightModel } from "./flightmodel.ts";

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function cruise(seed = 1) {
  const fm = new FlightModel();
  fm.placeInFlight(12_000 * 0.3048, 105, 0);
  fm.controls.throttle.fill(0.7);
  fm.damage.randomFailures = false;
  fm.damage.rng = seeded(seed);
  return fm;
}
const run = (fm: FlightModel, s: number, each?: (t: number) => void) => {
  for (let t = 0; t < s; t += 1 / 60) { each?.(t); fm.step(1 / 60, 2); }
};

// --- undamaged aircraft takes no damage in normal cruise
{
  const fm = cruise();
  const ap = new Autopilot();
  ap.engage(fm);
  run(fm, 120, () => ap.update(fm, 1 / 60));
  check(fm.damage.report().length === 0, `2 min cruise on autopilot: no damage (load factor ${fm.damage.loadFactor.toFixed(2)} g)`);
}

// --- flak: bursts at a fixed distance from random directions until the aircraft is lost
{
  for (const dist of [15, 30, 50]) {
    const counts: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const fm = cruise(seed);
      const rng = seeded(seed * 77);
      let n = 0;
      while (!fm.damage.destroyed && n < 2000) {
        const dir = new Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize();
        const at = new Vector3(rng() * 50 - 25, 0, rng() * 40 - 20).addScaledVector(dir, dist); // around the airframe
        fm.damage.burst(fm, at, 900, 90);
        fm.step(1 / 60, 1);
        n++;
      }
      counts.push(n);
    }
    counts.sort((a, b) => a - b);
    console.log(`     bursts at ${dist} m to lose the aircraft: median ${counts[10]}, min ${counts[0]}, max ${counts[19]}`);
    if (dist === 30) check(counts[10] >= 15, "survives a beating: median 15+ bursts at 30 m before it is lost");
  }
}

// --- engine hit: oil leak, seizure; fire spreads to the wing; extinguisher
{
  const fm = cruise(3);
  const d = fm.damage;
  d.oilLeak.set(2, 1.0);
  run(fm, 120);
  check(fm.pistons[2].failed, `oil leak: engine 3 seizes (oil ${d.oil[2].toFixed(0)} gal)`);
  const fm2 = cruise(4);
  const d2 = fm2.damage;
  d2.engineFire.add(0);
  const w0 = d2.health("wingOutL") + d2.health("wingInL");
  run(fm2, 60);
  check(d2.health("wingOutL") + d2.health("wingInL") < w0, `engine fire burns the wing (${(100 * d2.health("wingInL")).toFixed(0)}% inner)`);
  fm2.pistons[0].mixture = 0;
  fm2.pistons[0].feather = true;
  run(fm2, 2);
  let msg = "";
  for (let k = 0; k < 4 && d2.engineFire.has(0); k++) msg = d2.extinguish(fm2, [0]);
  check(!d2.engineFire.has(0), `extinguisher puts out a shut-down engine: ${msg}`);
}

// --- tank leak
{
  const fm = cruise(5);
  const ti = fm.fuel.selected.L;
  fm.damage.leaks.set(ti, 8);
  const q0 = fm.fuel.tanks[ti].qty;
  fm.fuel.auto = false;
  run(fm, 60);
  const lost = q0 - fm.fuel.tanks[ti].qty;
  check(lost > 480 && lost < 700, `8 lb/s leak plus burn drains the tank (${lost.toFixed(0)} lb in 60 s)`);
}

// --- overstress: hard pull at high speed breaks the wing
{
  const fm = new FlightModel();
  fm.placeInFlight(12_000 * 0.3048, 150, 0);
  fm.damage.randomFailures = false;
  fm.controls.throttle.fill(1);
  let maxG = 0;
  run(fm, 8, () => { fm.controls.elevator = 1; fm.controls.trim = 1; maxG = Math.max(maxG, fm.damage.loadFactor); });
  check(maxG > 2.0, `full back stick at 335 mph pulls ${maxG.toFixed(1)} g`);
  check(fm.damage.health("wingInL") < 1 || fm.damage.destroyed, `overstress damages the wing (${fm.damage.report(3).join(", ")}${fm.damage.destroyed ? ", LOST: " + fm.damage.destroyReason : ""})`);
}

// --- outer wing shot away: still flyable with aileron and rudder?
{
  const fm = cruise(6);
  const ap = new Autopilot();
  ap.engage(fm);
  const c = fm.damage.get("wingOutL");
  fm.damage.hit(fm, c, 1000);
  check(!!c.lost && !fm.jets[0].failed && fm.damage.separations.length === 1, "left wing tip separates (engines and jet pod stay)");
  let maxRoll = 0;
  run(fm, 60, (t) => { ap.update(fm, 1 / 60); if (t > 20) maxRoll = Math.max(maxRoll, Math.abs(fm.readout.roll_deg)); });
  console.log(`     after 60 s: roll ${fm.readout.roll_deg.toFixed(0)}, alt ${fm.readout.alt_ft.toFixed(0)} ft, aileron ${fm.controls.aileron.toFixed(2)}`);
  check(!fm.damage.destroyed && fm.readout.alt_ft > 9_000, "losing a wing tip is survivable: under control and above 9,000 ft after 60 s");
}

// --- landings
function approach(sinkFps: number, gear = true) {
  const fm = new FlightModel();
  fm.damage.randomFailures = false;
  fm.placeInFlight(30 * 0.3048 + 4.5, 70, 0);
  fm.controls.gearDown = gear;
  fm.gearPos = gear ? 1 : 0;
  fm.controls.flaps = fm.flapPos = 1;
  fm.vel.y = -sinkFps * 0.3048;
  for (let t = 0; t < 20 && !fm.damage.crashed; t += 1 / 120) {
    fm.vel.y = fm.readout.onGround ? fm.vel.y : -sinkFps * 0.3048; // hold the sink rate to touchdown
    fm.controls.throttle.fill(0);
    fm.step(1 / 120, 2);
  }
  return fm;
}
{
  const ok = approach(6);
  check(ok.damage.report().length === 0, `6 ft/s touchdown: no damage (${ok.damage.events[0]?.msg ?? ""})`);
  const hard = approach(13);
  check(hard.damage.health("gearL") < 1 && !hard.damage.destroyed, `13 ft/s: gear damaged (${hard.damage.report(3).join(", ")})`);
  const smash = approach(30);
  check(smash.damage.crashed, `30 ft/s: crash (${smash.damage.destroyReason})`);
  const belly = approach(4, false);
  check(belly.damage.health("fusMid") < 1 && belly.damage.health("eng3") < 1, `gear-up landing damages the belly and props (${belly.damage.report(4).join(", ")})`);
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
