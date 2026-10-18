// Bomb runs through the flak at several altitudes: how much damage, how often lost.
// Run: node --experimental-strip-types src/flak_test.ts
import { Flak, FLAK } from "./flak.ts";
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
if (env.SIGMA) FLAK.sigmaPerM = Number(env.SIGMA);
if (env.ALTS) console.log("sigma", FLAK.sigmaPerM);
import { RANGE_CENTER } from "./range.ts";
import { Autopilot } from "./sim/autopilot.ts";
import { FlightModel } from "./sim/flightmodel.ts";

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const results: Record<number, { lost: number; engines: number; worst: number[] }> = {};
for (const altFt of (env.ALTS ? env.ALTS.split(",").map(Number) : [12_000, 25_000, 40_000])) {
  const r = { lost: 0, engines: 0, worst: [] as number[] };
  const runs = 12;
  for (let seed = 1; seed <= runs; seed++) {
    const fm = new FlightModel();
    fm.damage.randomFailures = false;
    fm.damage.rng = seeded(seed);
    const alt = altFt * 0.3048;
    fm.placeInFlight(alt, altFt > 30_000 ? 150 : altFt > 20_000 ? 125 : 105, 0);
    fm.pos.set(RANGE_CENTER.x + 40, alt, RANGE_CENTER.z + 18_000);
    fm.controls.throttle.fill(altFt > 30_000 ? 1 : 0.8);
    fm.controls.jetThrottle.fill(altFt > 30_000 ? 1 : 0);
    const ap = new Autopilot();
    ap.engage(fm);
    const flak = new Flak();
    flak.rng = seeded(seed * 31);
    // fly straight over the target and 18 km beyond
    for (let t = 0; t < 400 && fm.pos.z > RANGE_CENTER.z - 18_000 && !fm.damage.destroyed; t += 1 / 60) {
      ap.update(fm, 1 / 60);
      fm.step(1 / 60, 2);
      flak.update(fm, 1 / 60);
    }
    if (fm.damage.destroyed) r.lost++;
    r.engines += fm.pistons.filter((e) => e.failed).length;
    const worst = Math.min(...fm.damage.comps.map((c) => (c.lost ? 0 : c.hp / c.hpMax)));
    r.worst.push(worst);
    if (seed === 1) console.log(`     ${altFt} ft seed 1: ${flak.bursts} bursts, closest ${flak.closest.toFixed(0)} m; ${fm.damage.report(5).join(", ") || "no damage"}`);
  }
  r.worst.sort((a, b) => a - b);
  results[altFt] = r;
  console.log(`${altFt} ft: lost ${r.lost}/${runs}, engines failed ${(r.engines / runs).toFixed(2)} per run, median worst component ${(100 * r.worst[runs / 2]).toFixed(0)}%`);
}
check(results[12_000].lost <= 3, "12,000 ft: lost in at most 3 of 12 runs");
check(results[12_000].worst[6] < 0.9, "12,000 ft: typically takes real damage");
check(results[40_000].lost === 0 && results[40_000].worst[6] === 1, "40,000 ft: above the flak");
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
