// Projectile flight (drag + gravity) and the fire-control solution shared by the gun sights, the AI
// gunners and the tests. World (sim) frame: x east, y up (altitude), z south, m and m/s.
import { Vector3 } from "three";
import { atmosphere, G0 } from "../sim/atmosphere.ts";

export interface Round { mass: number; cd: number; area: number; muzzle: number }

/** Advance one projectile by dt (semi-implicit Euler, the same law the tracer simulation uses). */
export function stepRound(r: Round, p: Vector3, v: Vector3, dt: number, rho = atmosphere(p.y).density) {
  const k = (0.5 * rho * v.length() * r.cd * r.area) / r.mass;
  v.addScaledVector(v, -k * dt);
  v.y -= G0 * dt;
  p.addScaledVector(v, dt);
}

const tmpP = new Vector3();
const tmpV = new Vector3();

/** Where a round fired from `muzzle` along `dir` (unit) with the shooter moving at `shooterVel` is after
 * time t. */
export function roundAt(r: Round, muzzle: Vector3, shooterVel: Vector3, dir: Vector3, t: number, out: Vector3, h = 0.04) {
  const rho = atmosphere(muzzle.y).density; // the density change over a 2 km flight is negligible here
  tmpP.copy(muzzle);
  tmpV.copy(shooterVel).addScaledVector(dir, r.muzzle);
  let left = t;
  while (left > 1e-6) {
    const s = Math.min(h, left);
    stepRound(r, tmpP, tmpV, s, rho);
    left -= s;
  }
  return out.copy(tmpP);
}

/**
 * Fire-control solution: the gun direction (unit, world) whose round meets a target that is at
 * `target` now and moves at `targetVel` (straight line). Iterates on time of flight and corrects the
 * aim for drop, trail (the shooter's own speed bleeding off through drag) and target motion.
 * Returns the direction and the time of flight, or null if the target is beyond `maxTof`.
 */
export function leadSolution(r: Round, muzzle: Vector3, shooterVel: Vector3, target: Vector3, targetVel: Vector3,
  maxTof = 3.0): { dir: Vector3; tof: number } | null {
  const dir = target.clone().sub(muzzle).normalize();
  let tof = target.distanceTo(muzzle) / r.muzzle;
  const hit = new Vector3();
  const want = new Vector3();
  for (let it = 0; it < 6; it++) {
    want.copy(target).addScaledVector(targetVel, tof);
    // time of flight: when the round has covered the distance to the predicted point along the line of fire
    const dist = want.distanceTo(muzzle);
    let t = dist / r.muzzle;
    for (let k = 0; k < 4; k++) {
      roundAt(r, muzzle, shooterVel, dir, t, hit);
      const along = hit.clone().sub(muzzle).dot(dir);
      const target2 = want.copy(target).addScaledVector(targetVel, t);
      const need = target2.clone().sub(muzzle).dot(dir);
      // local speed along the line, from a short step
      const ahead = roundAt(r, muzzle, shooterVel, dir, t + 0.01, new Vector3()).sub(muzzle).dot(dir);
      const vAlong = Math.max(50, (ahead - along) / 0.01);
      t += (need - along) / vAlong;
      if (t > maxTof) return null;
    }
    tof = t;
    roundAt(r, muzzle, shooterVel, dir, tof, hit);
    want.copy(target).addScaledVector(targetVel, tof);
    // rotate the line of fire by the miss, seen from the muzzle
    const miss = want.clone().sub(hit);
    const d = want.distanceTo(muzzle);
    dir.addScaledVector(miss, 1 / Math.max(d, 1)).normalize();
    if (miss.length() < 0.05) break;
  }
  return { dir, tof };
}

/** Closest approach of segment a-b to point c, squared. */
export function segPointDist2(a: Vector3, b: Vector3, c: Vector3) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((c.x - a.x) * abx + (c.y - a.y) * aby + (c.z - a.z) * abz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + abx * t - c.x, y = a.y + aby * t - c.y, z = a.z + abz * t - c.z;
  return x * x + y * y + z * z;
}
