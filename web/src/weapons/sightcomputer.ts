// Gun sight computer (no DOM): the gunner holds the line of sight on the target and sets the range;
// a gyro measures the tracking rate (filtered, time constant below) and the computer turns rate and
// range into the gun direction for each turret (lead, drop, trail). The tail station ranges by radar
// lock-on (APG-41 style); the blister stations range by hand, or with the range assist (game aid).
// Constants ESTIMATED.
import * as THREE from "three";
import type { FlightModel } from "../sim/flightmodel.ts";
import { leadSolution } from "./ballistics.ts";
import type { Fighter, Fighters } from "./fighters.ts";
import { GUN, type Turret } from "./turrets.ts";

const TRACK_TAU = 0.2; // s, filter on the target's relative velocity (from tracking rate and range rate)
export const RANGE_MIN = 150, RANGE_MAX = 1800; // m, ranging ring limits
const LOCK_CONE = 0.09; // rad, radar / range-assist acquisition cone
const LOCK_RANGE = 2300; // m
const ROUND = { mass: GUN.mass, cd: GUN.cd, area: GUN.area, muzzle: GUN.muzzle };

export class SightComputer {
  range = 600;
  assist = false;
  lock: Fighter | null = null;
  private relPrev: THREE.Vector3 | null = null; // target relative to the eye, model frame
  private vRel = new THREE.Vector3(); // model frame, m/s

  wheel(deltaY: number) {
    if (this.lock) return; // ranging comes from the radar / assist
    this.range = Math.max(RANGE_MIN, Math.min(RANGE_MAX, this.range * (deltaY > 0 ? 1 / 1.08 : 1.08)));
  }

  reset() {
    this.relPrev = null;
    this.vRel.set(0, 0, 0);
    this.lock = null;
  }

  /**
   * Sight computer. eyeW / dirW: sight eye (world) and line of sight (unit, world); q: aircraft attitude.
   * Returns the per-turret aim function for DefensiveFire.
   */
  compute(dt: number, fm: FlightModel, q: THREE.Quaternion, eyeW: THREE.Vector3, dirW: THREE.Vector3, fighters: Fighters | null,
    radar: boolean) {
    const qInv = q.clone().invert();
    const dirM = dirW.clone().applyQuaternion(qInv);
    // radar lock (tail) or range assist: nearest fighter inside the cone
    if (radar || this.assist) {
      let best: Fighter | null = null, bd = LOCK_RANGE;
      for (const f of fighters?.list ?? []) {
        if (!f.alive) continue;
        const v = f.pos.clone().sub(eyeW);
        const d = v.length();
        if (d < bd && v.normalize().angleTo(dirW) < (f === this.lock ? LOCK_CONE * 1.6 : LOCK_CONE)) { bd = d; best = f; }
      }
      this.lock = best;
      if (best) this.range = best.pos.distanceTo(eyeW);
    } else this.lock = null;
    // relative velocity: rate of the line of sight (gyro) times range, plus the range rate (from the
    // gunner's framing or the radar); filtered
    const R = this.range;
    const rel = dirM.clone().multiplyScalar(R);
    if (this.relPrev && dt > 0) this.vRel.lerp(rel.clone().sub(this.relPrev).divideScalar(dt), Math.min(1, dt / TRACK_TAU));
    this.relPrev = rel;
    const vRelM = this.vRel.clone();
    const targetW = eyeW.clone().addScaledVector(dirW, R);
    const targetVel = fm.vel.clone().add(vRelM.applyQuaternion(q));
    return (t: Turret, pivotW: THREE.Vector3) => {
      void t;
      const sol = leadSolution(ROUND, pivotW, fm.vel, targetW, targetVel, 3.5);
      return sol ? pivotW.clone().addScaledVector(sol.dir, 1000) : targetW;
    };
  }

}
