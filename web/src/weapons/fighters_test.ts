// Fighter attacks and defensive fire, measured headless. Run:
//   node --experimental-strip-types src/weapons/fighters_test.ts
// Turret nodes are built here at the pivots of the exported model (measured in the browser).
import * as THREE from "three";
import { Autopilot } from "../sim/autopilot.ts";
import { FlightModel } from "../sim/flightmodel.ts";
import { Fighters } from "./fighters.ts";
import { DefensiveFire } from "./gunnery.ts";
import { SightComputer } from "./sightcomputer.ts";
import { Rounds, Turret } from "./turrets.ts";

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const S28 = Math.sin((28 * Math.PI) / 180), C28 = Math.cos((28 * Math.PI) / 180);
// name, stowed pivot (model coords), up, gun direction at rest, retract
const DEFS: [string, [number, number, number], [number, number, number], [number, number, number], number][] = [
  ["Turret_UpperFwd_L", [-0.41, 0.78, -14.1], [-S28, C28, 0], [0, 0, -1], 0.95],
  ["Turret_UpperFwd_R", [0.41, 0.78, -14.1], [S28, C28, 0], [0, 0, -1], 0.95],
  ["Turret_UpperAft_L", [-0.23, 0.83, 15.7], [-S28, C28, 0], [0, 0, -1], 0.95],
  ["Turret_UpperAft_R", [0.23, 0.83, 15.7], [S28, C28, 0], [0, 0, -1], 0.95],
  ["Turret_LowerAft_L", [-0.21, 0.05, 16.1], [-S28, -C28, 0], [0, 0, 1], 0.95],
  ["Turret_LowerAft_R", [0.21, 0.05, 16.1], [S28, -C28, 0], [0, 0, 1], 0.95],
  ["Turret_Nose", [0, -0.48, -23.8], [0, -0.857, -0.514], [0, 0, -1], 0],
  ["Turret_Tail", [0, 0.87, 23.9], [0, 1, 0], [0, 0, 1], 0],
];

function setup(seed: number, ai: boolean) {
  const fm = new FlightModel();
  fm.placeInFlight(25_000 * 0.3048, 105, 0);
  fm.controls.throttle.fill(0.8);
  fm.damage.randomFailures = false;
  fm.damage.rng = seeded(seed);
  const ap = new Autopilot();
  ap.engage(fm);
  const root = new THREE.Group();
  const turrets = new Map<string, Turret>();
  for (const [name, p, up, gun, retract] of DEFS) {
    const y = new THREE.Vector3(...up).normalize();
    const g = new THREE.Vector3(...gun);
    const z = g.clone().addScaledVector(y, -g.dot(y)).normalize().negate(); // guns along local -z
    const x = y.clone().cross(z).normalize();
    const node = new THREE.Object3D();
    node.name = name;
    node.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    node.position.set(...p);
    node.userData = { retract };
    const guns = new THREE.Object3D();
    guns.name = name + "_Guns";
    node.add(guns);
    root.add(node);
    const t = new Turret(node);
    t.rng = seeded(seed * 31 + name.length);
    turrets.set(name, t);
  }
  const scene = new THREE.Group();
  const fighters = new Fighters(scene);
  fighters.rng = seeded(seed * 7);
  const rounds = new Rounds(scene);
  const def = new DefensiveFire(turrets, root, rounds, fighters);
  def.ai = ai;
  def.rng = seeded(seed * 13);
  const stats = { hitsOnBomber: 0, roundsFired: 0, enemyRounds: 0, passes: 0, struck: 0, kills: 0 };
  fighters.onHit = () => stats.hitsOnBomber++;
  fighters.onAttack = () => stats.passes++;
  fighters.onFire = () => stats.enemyRounds++;
  fighters.onStruck = (_f, _t, killed) => { stats.struck++; if (killed) stats.kills++; };
  rounds.onSegment = (a, b, tag) => fighters.struck(a, b, tag, 1 / 60);
  const step = () => {
    const dt = 1 / 60;
    ap.update(fm, dt);
    fm.step(dt, 2);
    const off = fm.modelOffset.applyQuaternion(fm.quat);
    root.position.set(off.x, fm.pos.y + off.y, off.z);
    root.quaternion.copy(fm.quat);
    root.updateMatrixWorld(true);
    fighters.update(fm, dt);
    def.update(fm, dt, null);
    stats.roundsFired += def.shots.length;
    rounds.update(dt);
  };
  return { fm, fighters, def, stats, step, turrets };
}

// One wave, 3 minutes, without and with defensive fire, 6 seeds each
for (const ai of [false, true]) {
  const rows: string[] = [];
  let lost = 0, kills = 0, hits = 0, passes = 0, fired = 0, enemy = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const s = setup(seed, ai);
    s.fighters.spawnWave(s.fm, 4);
    for (let t = 0; t < 180 && !s.fm.damage.destroyed; t += 1 / 60) s.step();
    if (s.fm.damage.destroyed) lost++;
    kills += s.stats.kills;
    hits += s.stats.hitsOnBomber;
    passes += s.stats.passes;
    fired += s.stats.roundsFired;
    enemy += s.stats.enemyRounds;
    const worst = s.fm.damage.comps.filter((c) => c.hp < c.hpMax).sort((a, b) => a.hp / a.hpMax - b.hp / b.hpMax)[0];
    rows.push(`seed ${seed}: passes ${s.stats.passes}, enemy rounds ${s.stats.enemyRounds}, hits on bomber ${s.stats.hitsOnBomber}, ` +
      `20 mm fired ${s.stats.roundsFired}, fighters hit ${s.stats.struck} downed ${s.stats.kills}, worst ${worst ? `${worst.label} ${(100 * worst.hp / worst.hpMax).toFixed(0)}%` : "-"}` +
      `${s.fm.damage.destroyed ? ", BOMBER LOST: " + s.fm.damage.destroyReason : ""}`);
  }
  console.log(`--- ${ai ? "with AI gunners" : "no defensive fire"} (4 MiG-15s, 3 min)`);
  for (const r of rows) console.log("     " + r);
  console.log(`     total: passes ${passes}, enemy rounds ${enemy}, hits ${hits}, lost ${lost}/6, fighters downed ${kills}/24, 20 mm fired ${fired}`);
  if (!ai) check(passes >= 6 * 6, `fighters make repeated firing passes (${passes} in 6 runs)`);
  check(hits > 0, `enemy fire hits the bomber (${hits} hits)`);
  if (ai) {
    check(kills > 0 && kills < 24, `AI gunners shoot some fighters down, not all (${kills}/24)`);
    check(fired > 0, "the turrets fire");
  }
}

// Player at the upper aft left station: perfect tracking of a fighter crossing at 500 m abeam, closing
// speed 250 m/s along the fuselage. Computing sight (exact range, or a fixed 600 m setting) against
// aiming straight at the target.
function crossing(mode: "assist" | "lead" | "fixed600" | "nolead") {
  const s = setup(9, false);
  const sc = new SightComputer();
  const names = ["Turret_UpperAft_L", "Turret_UpperAft_R"];
  for (const n of names) { const t = s.turrets.get(n)!; t.extendCmd = true; t.ext = 1; }
  s.fighters.spawnWave(s.fm, 1);
  const f = s.fighters.list[0];
  f.state = "extend";
  let hits = 0, fired = 0;
  s.fighters.onStruck = () => { hits++; f.hp = 1e9; f.state = "extend"; f.burning = false; };
  s.fighters.rng = () => 0.5; // no critical hits: count every strike
  const root = s.def.root;
  const eyeM = new THREE.Vector3(-1.38, 1.0, 12.1);
  const dt = 1 / 60;
  // one step to settle the pose
  s.step();
  f.pos.copy(s.fm.pos).add(new THREE.Vector3(-500, 120, -900));
  for (let t = 0; t < 7.2; t += dt) {
    s.fm.step(dt, 2);
    const off = s.fm.modelOffset.applyQuaternion(s.fm.quat);
    root.position.set(off.x, s.fm.pos.y + off.y, off.z);
    root.quaternion.copy(s.fm.quat);
    root.updateMatrixWorld(true);
    f.vel.copy(s.fm.vel).add(new THREE.Vector3(0, 0, 250));
    f.prevPos.copy(f.pos);
    f.pos.addScaledVector(f.vel, dt);
    const eyeW = eyeM.clone().applyMatrix4(root.matrixWorld).add(new THREE.Vector3(s.fm.pos.x, 0, s.fm.pos.z));
    const dirW = f.pos.clone().sub(eyeW).normalize();
    const range = f.pos.distanceTo(eyeW);
    if (mode !== "assist") sc.range = mode === "fixed600" ? 600 : range;
    sc.assist = mode === "assist";
    const aim = sc.compute(dt, s.fm, root.quaternion, eyeW, dirW, s.fighters, false);
    const aimFor = mode === "nolead" ? () => f.pos.clone() : aim;
    s.def.update(s.fm, dt, { turrets: names, aimFor, fire: range < 900 });
    fired += s.def.shots.length;
    s.def.rounds.update(dt);
  }
  return { hits, fired };
}
for (const mode of ["assist", "lead", "fixed600", "nolead"] as const) {
  const r = crossing(mode);
  console.log(`     crossing pass, ${mode}: ${r.hits} hits from ${r.fired} rounds (${(100 * r.hits / Math.max(1, r.fired)).toFixed(1)}%)`);
  if (mode === "assist") check(r.hits >= 10, `computing sight with range lock scores on a crossing fighter (${r.hits} hits)`);
  if (mode === "nolead") check(r.hits <= 2, `aiming straight at a crossing fighter misses (${r.hits} hits)`);
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
