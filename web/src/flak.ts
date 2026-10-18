// Heavy flak around the bombing range: predicted fire at the aircraft, shells burst after their time of
// flight with range-dependent error. All figures are ESTIMATED game tuning, measured in flak_test.ts.
import { Vector3 } from "three";
import { RANGE_CENTER } from "./range.ts";
import { type Component, gauss } from "./sim/damage.ts";
import type { FlightModel } from "./sim/flightmodel.ts";

export const FLAK = {
  ceiling: 11_500, // m, highest burst altitude
  maxSlant: 14_000, // m, engagement range
  reload: 6.0, // s per gun
  avgShellSpeed: 650, // m/s over the trajectory
  sigma0: 30, // m, burst error at zero range
  sigmaPerM: 0.015, // m of error per m of slant range (tuned in flak_test: real damage at 12,000 ft, rarely lost in one pass)
  fragments: 900, // effective fragments per burst (tuned in damage_test)
  fragmentRange: 90, // m
};

interface Shell { t: number; pos: Vector3 }

export class FlakBattery {
  pos: Vector3;
  guns: number;
  cooldown: number[];
  constructor(pos: Vector3, guns: number) {
    this.pos = pos;
    this.guns = guns;
    this.cooldown = Array.from({ length: guns }, (_, i) => (i * FLAK.reload) / guns);
  }
}

export class Flak {
  batteries: FlakBattery[] = [];
  shells: Shell[] = [];
  enabled = true;
  rng: () => number = Math.random;
  /** Burst (world, sim frame) and the components hit; visuals and messages hook in here. */
  onBurst: ((pos: Vector3, local: Vector3, distance: number, hits: { comp: Component; hits: number }[]) => void) | null = null;
  bursts = 0;
  closest = Infinity;

  constructor() {
    const c = RANGE_CENTER;
    for (const [dx, dz] of [[2500, -1500], [-2800, 600], [600, 3000]]) {
      this.batteries.push(new FlakBattery(new Vector3(c.x + dx, 0, c.z + dz), 4));
    }
  }

  update(fm: FlightModel, dt: number) {
    if (!this.enabled || fm.damage.crashed) { this.shells.length = 0; return; }
    for (const b of this.batteries) {
      const slant = b.pos.distanceTo(fm.pos);
      const inEnvelope = slant < FLAK.maxSlant && fm.pos.y < FLAK.ceiling && fm.pos.y > 300;
      for (let g = 0; g < b.guns; g++) {
        b.cooldown[g] -= dt;
        if (!inEnvelope || b.cooldown[g] > 0) continue;
        b.cooldown[g] += FLAK.reload * (0.85 + 0.3 * this.rng());
        const tof = slant / FLAK.avgShellSpeed;
        const aim = fm.pos.clone().addScaledVector(fm.vel, tof); // straight-line prediction
        const s = FLAK.sigma0 + FLAK.sigmaPerM * slant;
        aim.x += gauss(this.rng) * s;
        aim.y += gauss(this.rng) * s;
        aim.z += gauss(this.rng) * s;
        aim.y = Math.min(aim.y, FLAK.ceiling);
        this.shells.push({ t: tof, pos: aim });
      }
      for (let g = 0; g < b.guns; g++) if (b.cooldown[g] < 0) b.cooldown[g] = 0;
    }
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const sh = this.shells[i];
      sh.t -= dt;
      if (sh.t > 0) continue;
      this.shells.splice(i, 1);
      this.detonate(fm, sh.pos);
    }
  }

  private detonate(fm: FlightModel, w: Vector3) {
    this.bursts++;
    // burst in model coordinates: q^-1 (w - cg position) + cg
    const local = w.clone().sub(fm.pos).applyQuaternion(fm.quat.clone().invert()).sub(fm.modelOffset);
    const d = local.length();
    this.closest = Math.min(this.closest, d);
    const hits = d < FLAK.fragmentRange + 40 ? fm.damage.burst(fm, local, FLAK.fragments, FLAK.fragmentRange) : [];
    this.onBurst?.(w, local, d, hits);
  }
}
