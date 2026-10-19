// Defensive fire control: the station the player mans (aim point from the computing sight) and AI
// gunners on the other turrets. Scene coordinates: the aircraft root sits at the floating origin, so
// world (sim) = scene + (fm.pos.x, 0, fm.pos.z).
import * as THREE from "three";
import type { FlightModel } from "../sim/flightmodel.ts";
import { gauss } from "../sim/damage.ts";
import { leadSolution } from "./ballistics.ts";
import type { Fighter, Fighters } from "./fighters.ts";
import { GUN, lineHitsAirframe, type Rounds, type Turret } from "./turrets.ts";

/** AI gunner skill (ESTIMATED game tuning, measured in fighters_test.ts). */
export const AI_GUNNER = {
  aimSigma: 0.02, // rad, tracking error (wanders slowly)
  rangeErr: 0.2, // fraction, ranging error
  reaction: 2.5, // s from picking a target to opening fire
  maxRange: 1100, // m, opens fire inside this
  burst: [1.2, 2.5], // s
  pause: [0.8, 1.8], // s
  extendRange: 9000, // m: turrets go out when a fighter is this close
};
const DISPERSION = 0.0015; // rad, gun dispersion per round, ESTIMATED
const TRACER_EVERY = 3; // ESTIMATED belt mix

interface Crew { target: Fighter | null; err: THREE.Vector3; rErr: number; t: number; burst: number; burstLen: number; pause: number }

export interface PlayerAim {
  turrets: string[];
  /** World point a turret's guns should cover, given its pivot (world): the sight computer's
   * lead-corrected solution, or null to hold. */
  aimFor: ((t: Turret, pivotWorld: THREE.Vector3) => THREE.Vector3 | null) | null;
  fire: boolean;
  /** Round tag for hit credit (0 = this machine's player, 1 = AI gunners, 100 + id = a remote crew member). */
  tag?: number;
}

export interface Shot { turret: Turret; posWorld: THREE.Vector3; dirWorld: THREE.Vector3; player: boolean; tag: number }

export class DefensiveFire {
  ai = true;
  rng: () => number = Math.random;
  interrupted = false;
  shots: Shot[] = [];
  private crews = new Map<string, Crew>();
  private roundNo = 0;
  private quietT = 0;

  readonly turrets: Map<string, Turret>;
  readonly root: THREE.Object3D;
  readonly rounds: Rounds;
  readonly fighters: Fighters | null;

  constructor(turrets: Map<string, Turret>, root: THREE.Object3D, rounds: Rounds, fighters: Fighters | null) {
    this.turrets = turrets;
    this.root = root;
    this.rounds = rounds;
    this.fighters = fighters;
  }

  private toWorld(fm: FlightModel, scene: THREE.Vector3) {
    return scene.clone().add(new THREE.Vector3(fm.pos.x, 0, fm.pos.z));
  }

  private toScene(fm: FlightModel, world: THREE.Vector3) {
    return world.clone().sub(new THREE.Vector3(fm.pos.x, 0, fm.pos.z));
  }

  /** players: every manned gun station this frame (several crew members in multiplayer). */
  update(fm: FlightModel, dt: number, players: PlayerAim | PlayerAim[] | null) {
    const manned = players === null ? [] : Array.isArray(players) ? players : [players];
    this.interrupted = false;
    this.shots.length = 0;
    const fighters = this.fighters?.list.filter((f) => f.alive) ?? [];
    const near = fighters.some((f) => f.pos.distanceTo(fm.pos) < AI_GUNNER.extendRange);
    this.quietT = near ? 0 : this.quietT + dt;
    const inv = this.root.matrixWorld.clone().invert();
    const qInv = this.root.quaternion.clone().invert();
    const blocked = (pos: THREE.Vector3, dir: THREE.Vector3) =>
      lineHitsAirframe(pos.clone().applyMatrix4(inv), dir.clone().applyQuaternion(qInv));
    for (const t of this.turrets.values()) {
      const comp = fm.damage.byId.get(t.name);
      const dead = !!comp && comp.hp <= 0;
      const player = manned.find((m) => m.turrets.includes(t.name)) ?? null;
      const mine = !!player;
      let cmd: { az: number; el: number } | null = null;
      let fire = false;
      if (dead) {
        t.update(dt, null);
        t.resetCooldown();
        continue;
      }
      if (mine) {
        const pivot = this.toWorld(fm, t.yawNode.getWorldPosition(new THREE.Vector3()));
        const aim = player!.aimFor?.(t, pivot);
        if (aim) cmd = t.solve(this.toScene(fm, aim));
        fire = player!.fire;
      } else if (this.ai && !fm.damage.destroyed) {
        if (t.retract > 0 && near) t.extendCmd = true;
        if (t.retract > 0 && this.quietT > 40) t.extendCmd = false;
        const r = this.aiCrew(t, fm, dt, fighters);
        cmd = r.cmd;
        fire = r.fire;
      }
      t.update(dt, cmd);
      if (!fire || !t.ready) { t.resetCooldown(); continue; }
      const res = t.fire(dt, blocked);
      if (res.interrupted && mine && (player!.tag ?? 0) === 0) this.interrupted = true;
      const tag = mine ? player!.tag ?? 0 : 1;
      for (const s of res.shots) {
        const posW = this.toWorld(fm, s.pos);
        const dir = s.dir.clone().add(new THREE.Vector3(gauss(this.rng), gauss(this.rng), gauss(this.rng)).multiplyScalar(DISPERSION)).normalize();
        const tracer = this.roundNo++ % TRACER_EVERY === 0;
        this.rounds.spawn(posW, fm.vel.clone().addScaledVector(dir, GUN.muzzle), tracer, 5, tag);
        this.shots.push({ turret: t, posWorld: posW, dirWorld: dir, player: mine, tag });
      }
    }
  }

  /** AI gunner: pick the nearest fighter the turret can bear on, track it with error, fire in bursts. */
  private aiCrew(t: Turret, fm: FlightModel, dt: number, fighters: Fighter[]) {
    let c = this.crews.get(t.name);
    if (!c) { c = { target: null, err: new THREE.Vector3(), rErr: 0, t: 0, burst: 0, burstLen: 0, pause: 0 }; this.crews.set(t.name, c); }
    c.t += dt;
    const pivot = this.toWorld(fm, t.yawNode.getWorldPosition(new THREE.Vector3()));
    if (!c.target || !c.target.alive || c.t > 4 || c.target.pos.distanceTo(fm.pos) > AI_GUNNER.maxRange * 1.6) {
      let best: Fighter | null = null, bd = AI_GUNNER.maxRange * 1.6;
      for (const f of fighters) {
        const d = f.pos.distanceTo(pivot);
        if (d < bd && this.bears(t, fm, f.pos)) { bd = d; best = f; }
      }
      if (best !== c.target) {
        c.target = best;
        c.t = 0;
        c.rErr = gauss(this.rng) * AI_GUNNER.rangeErr;
        c.err.set(gauss(this.rng), gauss(this.rng), gauss(this.rng)).multiplyScalar(AI_GUNNER.aimSigma);
      } else c.t = Math.min(c.t, 1); // same target: keep tracking
    }
    const f = c.target;
    if (!f) return { cmd: null, fire: false };
    // tracking error wanders (random walk toward a new error every ~1 s)
    c.err.multiplyScalar(1 - dt).addScaledVector(new THREE.Vector3(gauss(this.rng), gauss(this.rng), gauss(this.rng)), AI_GUNNER.aimSigma * Math.sqrt(2 * dt));
    const range = f.pos.distanceTo(pivot);
    const tgt = f.pos.clone().sub(pivot).multiplyScalar(1 + c.rErr).add(pivot);
    const sol = leadSolution({ mass: GUN.mass, cd: GUN.cd, area: GUN.area, muzzle: GUN.muzzle }, pivot, fm.vel, tgt, f.vel);
    if (!sol) return { cmd: null, fire: false };
    const dir = sol.dir.clone().addScaledVector(c.err, 1).normalize();
    const cmd = t.solve(this.toScene(fm, pivot.clone().addScaledVector(dir, 1000)));
    let fire = false;
    if (range < AI_GUNNER.maxRange && c.t > AI_GUNNER.reaction && !t.slewing && !t.atLimit) {
      if (c.pause > 0) c.pause -= dt;
      else {
        if (c.burst === 0) c.burstLen = AI_GUNNER.burst[0] + this.rng() * (AI_GUNNER.burst[1] - AI_GUNNER.burst[0]);
        c.burst += dt;
        fire = true;
        if (c.burst > c.burstLen) {
          c.burst = 0;
          c.pause = AI_GUNNER.pause[0] + this.rng() * (AI_GUNNER.pause[1] - AI_GUNNER.pause[0]);
        }
      }
    }
    return { cmd, fire };
  }

  /** The turret can point at a world point (inside its limits and clear of the airframe). */
  bears(t: Turret, fm: FlightModel, world: THREE.Vector3) {
    const s = t.solve(this.toScene(fm, world));
    if (!t.within(s.az, s.el)) return false;
    const pivotS = t.yawNode.getWorldPosition(new THREE.Vector3());
    const dir = this.toScene(fm, world).sub(pivotS).normalize();
    const inv = this.root.matrixWorld.clone().invert();
    return !lineHitsAirframe(pivotS.clone().addScaledVector(dir, 2.2).applyMatrix4(inv), dir.applyQuaternion(this.root.quaternion.clone().invert()));
  }
}
