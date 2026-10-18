// Headless bomb run: autopilot approach, release when the predicted impact reaches the target,
// check fall time and miss distance. Run: node --experimental-strip-types src/weapons/bomb_test.ts
import * as THREE from "three";
import { BombingRange, RANGE_CENTER } from "../range.ts";
import { Autopilot } from "../sim/autopilot.ts";
import { FlightModel } from "../sim/flightmodel.ts";
import { BombSystem } from "./bombs.ts";

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };

const scene = new THREE.Group();
const world = new THREE.Group();
const root = new THREE.Group();
scene.add(world, root);
const fm = new FlightModel();
const bombs = new BombSystem(root, world);
const range = new BombingRange(world);
const impacts: THREE.Vector3[] = [];
bombs.onImpact = (i) => { impacts.push(i.pos); range.impact(i.pos); };
check(bombs.remaining === 48, `48 bombs loaded (${bombs.remaining})`);

const alt = 12_000 * 0.3048;
fm.placeInFlight(alt, 105, 0);
const target = range.targets[0];
fm.pos.set(target.pos.x + 30, alt, target.pos.z + 15_000);
fm.controls.throttle.fill(0.7);
const ap = new Autopilot();
ap.engage(fm);

const place = () => {
  const off = fm.modelOffset.applyQuaternion(fm.quat);
  root.position.set(off.x, fm.pos.y + off.y, off.z);
  root.quaternion.copy(fm.quat);
  world.position.set(-fm.pos.x, 0, -fm.pos.z);
  scene.updateMatrixWorld(true);
};

// bomb run: steer laterally via the autopilot, open doors, release when predicted impact reaches the target
fm.controls.bombDoors = 1;
bombs.armed = true;
let released = false;
let predicted = new THREE.Vector3();
let fall = 0;
const mass0 = fm.mass;
const fuel0 = fm.fuel.total;
for (let t = 0; t < 400 && (impacts.length === 0); t += 1 / 60) {
  ap.update(fm, 1 / 60);
  fm.step(1 / 60, 2);
  place();
  const sight = new THREE.Vector3(0, -1.0, 1.4 - 24.7).applyMatrix4(root.matrixWorld);
  sight.x += fm.pos.x;
  sight.z += fm.pos.z;
  const pred = BombSystem.predict(fm, bombs.nextReleasePoint(fm, root.matrixWorld) ?? sight);
  if (!released) {
    // lateral steering: aim the track at the target (2 deg/s max correction)
    // steer the track toward the target: bearing from the aircraft, corrected by the impact's lateral error
    const brg = (Math.atan2(target.pos.x - fm.pos.x, -(target.pos.z - fm.pos.z)) * 180) / Math.PI;
    const cross = pred.point.x - target.pos.x;
    ap.headingDeg = (brg - Math.max(-5, Math.min(5, cross * 0.02)) + 360) % 360;
    if (pred.point.z <= target.pos.z) {
      predicted = pred.point.clone();
      fall = pred.time;
      console.log(`release at t=${t.toFixed(1)} s, alt ${fm.readout.alt_ft.toFixed(0)} ft, IAS ${fm.readout.ias_mph.toFixed(0)} mph, predicted miss ${Math.hypot(pred.point.x - target.pos.x, pred.point.z - target.pos.z).toFixed(1)} m`);
      console.log(bombs.release(fm, root.matrixWorld));
      released = true;
    }
  }
  bombs.update(fm, root.matrixWorld, 1 / 60);
}
check(released, "released on the run");
check(impacts.length === 1, `one bomb impacted (${impacts.length})`);
const hit = impacts[0];
const vacuum = Math.sqrt((2 * alt) / 9.80665);
check(fall > vacuum && fall < vacuum * 1.15, `time of fall ${fall.toFixed(1)} s (vacuum ${vacuum.toFixed(1)} s)`);
const err = Math.hypot(hit.x - predicted.x, hit.z - predicted.z);
check(err < 3, `impact matches the sight prediction (${err.toFixed(1)} m apart)`);
const miss = Math.hypot(hit.x - target.pos.x, hit.z - target.pos.z);
check(miss < target.radius, `${target.name} hit (miss ${miss.toFixed(1)} m, lethal radius ${target.radius} m)`);
check(target.destroyed, "target marked destroyed");
const fuelKg = (fuel0 - fm.fuel.total) * 0.45359237;
check(Math.abs(mass0 - fm.mass - fuelKg - 454) < 1, `aircraft 454 kg lighter apart from fuel burned (${(mass0 - fm.mass - fuelKg).toFixed(0)} kg)`);
console.log(range.log[0]);
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
void RANGE_CENTER;
