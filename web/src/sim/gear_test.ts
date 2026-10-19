// Landing gear contact state used by the exterior animation (oleo travel, wheel spin, tire smoke), and
// the animated nodes the exterior model must provide for it.
// Run: node --experimental-strip-types src/sim/gear_test.ts
import { readFileSync } from "node:fs";
import { Vector3 } from "three";
import { FlightModel } from "./flightmodel.ts";

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
const leg = (fm: FlightModel, n: string) => fm.legContacts().find((l) => l.name === n)!;

{
  const fm = new FlightModel();
  fm.placeOnGround(new Vector3(0, 0, 0), 0);
  for (let i = 0; i < 120 * 10; i++) fm.step(1 / 120);
  const m = leg(fm, "mainL").comp, n = leg(fm, "nose").comp;
  console.log(`static compression: mains ${m.toFixed(3)} m, nose ${n.toFixed(3)} m`);
  check(m > 0.1 && m < 0.4 && Math.abs(m - leg(fm, "mainR").comp) < 1e-6, "parked: both mains compressed equally, within the oleo stroke");
  check(n > 0.02 && n < m, "parked: nose leg carries less than a main leg");
  check(Math.abs(leg(fm, "mainL").roll) < 0.1, "parked: wheels not rolling");
  fm.controls.parkingBrake = false;
  fm.controls.throttle = fm.controls.throttle.map(() => 1);
  for (let i = 0; i < 120 * 20; i++) fm.step(1 / 120);
  const v = new Vector3(0, 0, -1).applyQuaternion(fm.quat).setY(0).normalize().dot(fm.vel);
  check(Math.abs(leg(fm, "mainR").roll - v) < 0.5 && v > 20, `take-off roll: wheel rolling speed follows ground speed (${v.toFixed(1)} m/s)`);
}
{
  const fm = new FlightModel();
  fm.placeInFlight(1500, 110, 0);
  check(fm.legContacts().every((l) => l.comp === 0), "airborne: no compression");
}
{
  const g = JSON.parse(readFileSync(new URL("../../public/models/b36.gltf", import.meta.url), "utf8"));
  const named = (re: RegExp) => g.nodes.filter((n: { name: string }) => re.test(n.name));
  const cowls = named(/^Cowl_[LR]\d$/);
  check(cowls.length === 6 && cowls.every((c: { mesh: number }) => g.meshes[c.mesh].primitives.every((p: { targets?: unknown[] }) => p.targets?.length === 1)),
    "model: 6 cowl flap meshes, each with an open morph target");
  check(named(/^Blade_[LR]\d_\d$/).every((b: { extras?: { part?: string; beta75?: number } }) => b.extras?.part === "blade" && typeof b.extras.beta75 === "number")
    && named(/^Blade_/).length === 18, "model: 18 blades with a pitch axis and build angle");
  check(named(/^Wheel_/).length === 10 && named(/^Oleo_/).length === 3, "model: 10 wheels on 3 oleos");
  check(named(/^Exhaust_/).length === 12 && named(/^JetExhaust_/).length === 4, "model: 12 exhaust and 4 jet nozzle markers");
}

console.log(failures ? `${failures} FAILED` : "all passed");
if (failures) process.exit(1);
