// Fire-control checks: the lead solution puts a 20 mm round on a moving target when range and target
// motion are known. Run: node --experimental-strip-types src/weapons/gunnery_test.ts
import { Vector3 } from "three";
import { leadSolution, segPointDist2, stepRound } from "./ballistics.ts";

const ROUND = { mass: 0.13, cd: 0.30, area: Math.PI * 0.01 * 0.01, muzzle: 840 };
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

/** Fly the round at the frame rate the game uses and return the miss distance at closest approach. */
function miss(muzzle: Vector3, shooterVel: Vector3, dir: Vector3, target: Vector3, targetVel: Vector3) {
  const p = muzzle.clone(), v = shooterVel.clone().addScaledVector(dir, ROUND.muzzle);
  const tp = target.clone();
  let best = Infinity;
  const dt = 1 / 120;
  for (let t = 0; t < 4; t += dt) {
    const p0 = p.clone();
    stepRound(ROUND, p, v, dt);
    tp.addScaledVector(targetVel, dt);
    best = Math.min(best, Math.sqrt(segPointDist2(p0, p, tp)));
  }
  return best;
}

const alt = 7600; // 25,000 ft
const bomberVel = new Vector3(0, 0, -105); // 235 mph true, heading north
const muzzle = new Vector3(0, alt, 0);
const cases: [string, Vector3, Vector3][] = [
  ["beam crossing 600 m, 250 m/s", new Vector3(600, alt + 100, 0), new Vector3(0, 0, -250)],
  ["high front quarter 900 m, closing", new Vector3(500, alt + 400, -650), new Vector3(-150, -90, 180)],
  ["astern 800 m, closing 80 m/s", new Vector3(30, alt + 60, 800), new Vector3(0, -5, -185)],
  ["low beam 1,200 m", new Vector3(-1100, alt - 450, 100), new Vector3(60, 40, -230)],
];
for (const [name, tgt, tv] of cases) {
  const sol = leadSolution(ROUND, muzzle, bomberVel, tgt, tv);
  const m = sol ? miss(muzzle, bomberVel, sol.dir, tgt, tv) : Infinity;
  const lead = sol ? (Math.acos(Math.min(1, sol.dir.dot(tgt.clone().sub(muzzle).normalize()))) * 1000).toFixed(0) : "-";
  check(m < 1.0, `${name}: miss ${m.toFixed(2)} m, lead ${lead} mil, time of flight ${sol?.tof.toFixed(2)} s`);
}
// Without lead (aim straight at the target) the same shots miss by many metres
{
  const [, tgt, tv] = cases[0];
  const m = miss(muzzle, bomberVel, tgt.clone().sub(muzzle).normalize(), tgt, tv);
  check(m > 50, `no lead on the beam crossing misses by ${m.toFixed(0)} m`);
}
// Beyond reach
check(leadSolution(ROUND, muzzle, bomberVel, new Vector3(0, alt, -6000), new Vector3()) === null, "no solution at 6 km");
{
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) leadSolution(ROUND, muzzle, bomberVel, cases[1][1], cases[1][2]);
  console.log(`     solver cost ${((performance.now() - t0) / 200).toFixed(3)} ms per solution (measured)`);
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
