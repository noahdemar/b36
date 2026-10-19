// 6-DOF rigid-body flight model for the B-36.
// Frames: world = three.js world (x east, y up, z south; "north" is -z).
// Body = three.js model axes: +x right wing, +y up, +z aft (nose points -z).
import { Quaternion, Vector3 } from "three";
import { atmosphere, G0 } from "./atmosphere.ts";
import { AIRCRAFT, type AircraftParams } from "./params.ts";
import { DamageModel } from "./damage.ts";
import { autoCowl, type Engine, FUEL_KG_PER_LB, FuelSystem, jetFuelFlow, makeEngine, stepEngine } from "./powerplant.ts";

export interface Controls {
  elevator: number; // -1..1, + = pull (nose up)
  aileron: number; // -1..1, + = roll right
  rudder: number; // -1..1, + = yaw right
  trim: number; // -1..1 elevator trim, + = nose up
  throttle: number[]; // 6 piston throttles 0..1
  jetThrottle: number[]; // 4 jet throttles 0..1 (0 = shut down)
  flaps: number; // commanded 0..1
  gearDown: boolean;
  brakes: number; // 0..1 toe brakes
  parkingBrake: boolean;
  tiller: number; // -1..1 nose wheel steering
  bombDoors: number; // 0..1 commanded
}

export interface JetState {
  n: number; // spool 0..1 (fraction of max thrust)
  rpmPct: number;
  egt: number;
  fuelPress: number;
  oilPress: number;
  thrust: number;
  failed?: boolean;
}

export interface Readout {
  ias_mph: number;
  tas_mps: number;
  alt_ft: number;
  agl_ft: number;
  vs_fpm: number;
  heading_deg: number;
  pitch_deg: number;
  roll_deg: number;
  turn_rate: number; // 1 = 4-minute (1.5 deg/s) turn
  alpha_deg: number;
  beta_deg: number;
  rpm_avg: number;
  map_avg: number;
  onGround: boolean;
  [k: string]: number | boolean;
}

export function defaultControls(): Controls {
  return {
    elevator: 0, aileron: 0, rudder: 0, trim: 0,
    throttle: [0, 0, 0, 0, 0, 0], jetThrottle: [0, 0, 0, 0],
    flaps: 0, gearDown: true, brakes: 0, parkingBrake: true, tiller: 0, bombDoors: 0,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const MPS_TO_MPH = 2.236936;
const M_TO_FT = 3.28084;

export class FlightModel {
  readonly p: AircraftParams;
  mass: number;
  inertia: Vector3;
  pos = new Vector3(); // CG, world
  vel = new Vector3(); // world
  quat = new Quaternion(); // body -> world
  omega = new Vector3(); // body rates (x = pitch up, y = yaw left, z = roll left)
  controls: Controls = defaultControls();
  pistons: Engine[];
  jets: JetState[];
  fuel = new FuelSystem();
  /** AI flight engineer: automatic cowl flaps (fuel sequencing is fuel.auto). Off when a player is at the FE seat. */
  feAuto = true;
  damage: DamageModel;
  private burnedLb = 0;
  flapPos = 0;
  gearPos = 1; // 1 = down and locked
  bombDoorPos = 0;
  time = 0;
  readout: Readout;
  private cg: Vector3;
  private lastHeading = 0;
  private headingRate = 0;

  constructor(params: AircraftParams = AIRCRAFT, mass = params.massDefault) {
    this.p = params;
    this.mass = mass;
    this.cg = new Vector3(...params.cg);
    this.inertia = new Vector3(
      mass * params.rgPitch * params.rgPitch, // about x (pitch)
      mass * params.rgYaw * params.rgYaw, // about y (yaw)
      mass * params.rgRoll * params.rgRoll, // about z (roll)
    );
    this.pistons = Array.from({ length: params.piston.count }, () => makeEngine(true));
    this.jets = Array.from({ length: params.jet.count }, () => ({ n: 0, rpmPct: 0, egt: 20, fuelPress: 0, oilPress: 0, thrust: 0 }));
    this.readout = {} as Readout;
    this.damage = new DamageModel(this);
    this.placeOnGround(new Vector3(0, 0, 0), 0);
    this.updateReadout(0);
  }

  /** Change aircraft mass (stores released, fuel burned); inertia scales with mass. */
  setMass(m: number) {
    this.inertia.multiplyScalar(m / this.mass);
    this.mass = m;
  }

  /** Engines and fuel to a known state: running at idle (or cold and dark) and the default fuel load. */
  resetSystems(running = true) {
    this.pistons = this.pistons.map(() => makeEngine(running));
    this.jets.forEach((j) => { j.n = 0; });
    this.fuel = new FuelSystem();
    this.burnedLb = 0;
    const randomFailures = this.damage?.randomFailures ?? true;
    this.damage = new DamageModel(this);
    this.damage.randomFailures = randomFailures;
    if (!running) this.controls.jetThrottle.fill(0);
  }

  /** Mass lost without burning (leaks, fires, separated structure), kg. */
  addMassLoss(kg: number) {
    this.setMass(Math.max(this.mass - kg, 60_000));
  }

  /** Model-origin offset from CG in body coords (render the model at pos + quat * modelOffset). */
  get modelOffset(): Vector3 {
    return this.cg.clone().negate();
  }

  placeOnGround(at: Vector3, headingDeg: number) {
    const gearBottom = this.p.gear[0].pos[1] - this.cg.y;
    this.pos.set(at.x, -gearBottom - 0.25, at.z);
    this.quat.setFromAxisAngle(new Vector3(0, 1, 0), (-headingDeg * Math.PI) / 180);
    this.vel.set(0, 0, 0);
    this.omega.set(0, 0, 0);
    this.gearPos = 1;
    this.controls.gearDown = true;
    if (this.readout) this.updateReadout(0);
  }

  /** Level-flight trim (clean): angle of attack and elevator trim setting for weight at speed. */
  trimFor(altM: number, speedMps: number) {
    const p = this.p;
    const air = atmosphere(altM);
    const qbar = 0.5 * air.density * speedMps * speedMps;
    const cl = (this.mass * G0) / (qbar * p.wingArea);
    const alpha = (cl - p.cl0) / p.clAlpha;
    const elev = (p.cm0 + p.cmAlpha * alpha) / p.cmElevator; // rad, from Cm = 0
    return { alpha, cl, trim: clamp(elev / p.trimMax, -1, 1), elevRad: elev };
  }

  placeInFlight(altM: number, speedMps: number, headingDeg: number) {
    const t = this.trimFor(altM, speedMps);
    this.pos.set(0, altM, 0);
    const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (-headingDeg * Math.PI) / 180);
    const pitch = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), t.alpha);
    this.quat.copy(yaw).multiply(pitch);
    this.vel.set(0, 0, -speedMps).applyQuaternion(yaw);
    this.omega.set(0, 0, 0);
    this.gearPos = 0;
    this.controls.gearDown = false;
    this.controls.parkingBrake = false;
    this.controls.trim = t.trim;
    this.controls.elevator = (t.elevRad - t.trim * this.p.trimMax) / this.p.elevatorMax;
    const oat = atmosphere(altM).temperature - 273.15;
    for (const e of this.pistons) {
      if (!e.running) continue;
      e.rpm = 2300;
      e.cowl = 0.3;
      e.cht = Math.max(oat + 150, 150);
      e.oilT = 70;
    }
    this.updateReadout(0);
    return t;
  }

  step(dt: number, substeps = 4) {
    const h = dt / substeps;
    if (this.damage.crashed) { this.updateReadout(dt); return; }
    for (let i = 0; i < substeps; i++) {
      this.integrate(h);
      this.damage.update(this, h);
      if (this.damage.crashed) break;
    }
    if (this.burnedLb > 1) {
      this.setMass(this.mass - this.burnedLb * FUEL_KG_PER_LB);
      this.burnedLb = 0;
    }
    this.updateReadout(dt);
  }

  // ---------------------------------------------------------------- systems

  private updateSystems(dt: number, air: ReturnType<typeof atmosphere>, V: number) {
    const p = this.p;
    const c = this.controls;
    const flapRate = 1 / 25; // full travel in ~25 s (ESTIMATED)
    this.flapPos += clamp(c.flaps - this.flapPos, -flapRate * dt, flapRate * dt);
    const gearRate = 1 / 15; // ESTIMATED
    this.gearPos = clamp(this.gearPos + (c.gearDown ? 1 : -1) * gearRate * dt, 0, 1);
    this.bombDoorPos += clamp(c.bombDoors - this.bombDoorPos, -dt / 4, dt / 4);

    const sides = ["L", "L", "L", "R", "R", "R"] as const;
    const fuelOk = { L: this.fuel.side("L") > 0.5 || (this.fuel.crossfeed && this.fuel.total > 0.5), R: this.fuel.side("R") > 0.5 || (this.fuel.crossfeed && this.fuel.total > 0.5) };
    const sel = (s: "L" | "R") => this.fuel.tanks[this.fuel.selected[s]].qty > 0.5
      || (this.fuel.crossfeed && this.fuel.tanks[this.fuel.selected[s === "L" ? "R" : "L"]].qty > 0.5) || this.fuel.auto;
    const burn = { L: 0, R: 0 };
    this.pistons.forEach((e, i) => {
      if (this.feAuto && e.running) autoCowl(e, dt);
      const s = sides[i];
      burn[s] += stepEngine(e, p, c.throttle[i] ?? 0, air, V, dt, fuelOk[s] && sel(s));
    });
    const jp = p.jet;
    this.jets.forEach((j, i) => {
      const thr = clamp(c.jetThrottle[i] ?? 0, 0, 1);
      const side = i < 2 ? "L" : "R";
      const running = thr > 0.01 && this.fuel.side(side) > 0.5 && !j.failed;
      const target = running ? 0.12 + 0.88 * thr : 0;
      const tau = target > j.n ? jp.spoolUpTau : jp.spoolDownTau;
      j.n += (target - j.n) * (1 - Math.exp(-dt / tau));
      j.rpmPct = running ? 45 + 55 * Math.sqrt(j.n) : 100 * j.n;
      j.egt = 20 + (running ? 380 + 300 * j.n : 0);
      j.fuelPress = running ? 150 + 650 * j.n : 0;
      j.oilPress = j.rpmPct > 5 ? 20 + 25 * (j.rpmPct / 100) : 0;
      const mach = V / air.soundSpeed;
      j.thrust = jp.thrustMax * j.n * Math.pow(air.sigma, 0.85) * (1 - 0.12 * mach);
      if (running) burn[side] += (jetFuelFlow(Math.max(j.thrust, 0.12 * jp.thrustMax * air.sigma)) / 3600) * dt;
    });
    for (const s of ["L", "R"] as const) {
      const before = this.fuel.total;
      this.fuel.draw(s, burn[s]);
      this.burnedLb += before - this.fuel.total;
    }
  }

  // ---------------------------------------------------------------- dynamics

  private integrate(dt: number) {
    const p = this.p;
    const c = this.controls;
    const air = atmosphere(this.pos.y);
    const qInv = this.quat.clone().invert();
    const vb = this.vel.clone().applyQuaternion(qInv);
    const V = vb.length();
    this.updateSystems(dt, air, V);

    const F = new Vector3(); // body forces
    const M = new Vector3(); // body moments (x pitch up, y yaw left, z roll left)

    // --- aerodynamics
    if (V > 1) {
      const u = -vb.z;
      const alpha = Math.atan2(-vb.y, Math.max(u, 0.1));
      const beta = Math.asin(clamp(vb.x / V, -1, 1));
      const qbar = 0.5 * air.density * V * V;
      const S = p.wingArea;
      const b = p.span;
      const cbar = p.mac;
      const f = this.flapPos;
      const aStall = ((p.alphaStallDeg - 1.5 * f) * Math.PI) / 180;
      const clMax = p.clMaxClean + (p.clMaxFlaps - p.clMaxClean) * f;
      let CL = p.cl0 + p.clAlpha * alpha + p.clFlaps * f;
      let cdStall = 0;
      if (alpha > aStall) {
        CL = clMax - 2.2 * (alpha - aStall);
        CL = Math.max(CL, 0.55 * clMax);
        cdStall = 1.2 * Math.sin(alpha - aStall) ** 2;
      } else {
        CL = Math.min(CL, clMax);
      }
      if (alpha < -0.25) {
        CL = Math.max(CL, -0.8);
        cdStall = 1.2 * Math.sin(alpha + 0.25) ** 2;
      }
      const k = 1 / (Math.PI * p.oswald * p.aspectRatio);
      const fx = this.damage.effects;
      const liftF = (fx.liftL + fx.liftR) / 2;
      const clAsym = -fx.rollLeftPerCL * CL; // roll from uneven lift (Cl is roll-right positive)
      CL *= liftF;
      const CD = fx.cdAdd + p.cd0 + p.cdFlaps * f + p.cdGear * this.gearPos + p.cdBombDoors * this.bombDoorPos + k * CL * CL + cdStall;
      const CY = p.cyBeta * beta;

      const vhat = vb.clone().divideScalar(V);
      const vPlane = new Vector3(0, vb.y, vb.z).normalize();
      const liftDir = new Vector3(1, 0, 0).cross(vPlane);
      F.addScaledVector(liftDir, qbar * S * CL);
      F.addScaledVector(vhat, -qbar * S * CD);
      F.x += qbar * S * CY;

      const Vr = Math.max(V, 25);
      const qRate = this.omega.x; // pitch up
      const pRate = -this.omega.z; // roll right
      const rRate = -this.omega.y; // yaw right
      const elev = (c.elevator * p.elevatorMax + c.trim * p.trimMax) * fx.elev;
      const ail = c.aileron * p.aileronMax * (fx.ailL + fx.ailR) / 2;
      const rud = c.rudder * p.rudderMax * fx.rud;
      const Cm = p.cm0 + p.cmAlpha * fx.cmAlpha * alpha - p.cmElevator * elev + (p.cmQ * qRate * cbar) / (2 * Vr) + p.cmFlaps * f;
      const Cl = clAsym + p.clBeta * beta + (p.clP * pRate * b) / (2 * Vr) + (p.clR * rRate * b) / (2 * Vr) + p.clAileron * ail;
      const Cn = p.cnBeta * fx.cnBeta * beta + (p.cnR * rRate * b) / (2 * Vr) + (p.cnP * pRate * b) / (2 * Vr)
        + Math.abs(p.cnRudder) * rud + p.cnAileron * ail;
      M.x += qbar * S * cbar * Cm;
      M.z -= qbar * S * b * Cl;
      M.y -= qbar * S * b * Cn;
    }

    // --- engines (thrust along -z body, applied at engine positions relative to the CG)
    const fwd = new Vector3(0, 0, -1);
    const addForceAt = (force: Vector3, at: Vector3) => {
      F.add(force);
      M.add(at.clone().cross(force));
    };
    this.pistons.forEach((e, i) => {
      addForceAt(fwd.clone().multiplyScalar(e.thrust), new Vector3(p.piston.x[i], 0.5 - this.cg.y, 2.0 - this.cg.z));
    });
    this.jets.forEach((j, i) => {
      addForceAt(fwd.clone().multiplyScalar(j.thrust), new Vector3(p.jet.x[i], -1.8 - this.cg.y, 2.0 - this.cg.z));
    });

    // --- fuel lateral imbalance: wing tanks' centroid ~9 m from the centreline (ESTIMATED)
    M.z += (this.fuel.side("L") - this.fuel.side("R")) * FUEL_KG_PER_LB * G0 * 9;

    // --- gravity (world) and ground contact
    const Fw = F.clone().applyQuaternion(this.quat);
    Fw.y -= this.mass * G0;
    const Mw = new Vector3();
    this.groundContact(Fw, Mw, dt);
    M.add(Mw.applyQuaternion(qInv));

    // --- integrate
    this.vel.addScaledVector(Fw, dt / this.mass);
    this.pos.addScaledVector(this.vel, dt);
    const I = this.inertia;
    const w = this.omega;
    const Iw = new Vector3(w.x * I.x, w.y * I.y, w.z * I.z);
    const gyro = w.clone().cross(Iw);
    w.x += ((M.x - gyro.x) / I.x) * dt;
    w.y += ((M.y - gyro.y) / I.y) * dt;
    w.z += ((M.z - gyro.z) / I.z) * dt;
    const dq = new Quaternion(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0);
    const qn = this.quat.clone().multiply(dq);
    this.quat.set(this.quat.x + qn.x, this.quat.y + qn.y, this.quat.z + qn.z, this.quat.w + qn.w).normalize();
    this.time += dt;
  }

  private groundContact(Fw: Vector3, Mw: Vector3, dt: number) {
    const p = this.p;
    const c = this.controls;
    const omegaW = this.omega.clone().applyQuaternion(this.quat);
    const up = new Vector3(0, 1, 0);
    const ok = this.damage.effects.gearOk;
    const belly = (name: string, x: number, y: number, z: number) => ({ name, pos: [x, y, z] as const, steer: false, k: p.gearK * 2, cd: p.gearC * 2, wheel: false });
    const legs = this.gearPos > 0.98
      ? [
        ...p.gear.filter((g) => ok[g.name]).map((g) => ({ ...g, k: p.gearK, cd: p.gearC, wheel: true })),
        // collapsed legs: the nose or the inboard nacelle takes the load
        ...(ok.nose ? [] : [belly("nose_c", 0, -1.85, -18)]),
        ...(ok.mainL ? [] : [belly("nacL", -7.69, -2.45, 3.7)]),
        ...(ok.mainR ? [] : [belly("nacR", 7.69, -2.45, 3.7)]),
      ]
      : [
        // gear not locked: fuselage/belly and nacelle contacts (sliding)
        { name: "belly_f", pos: [0, -1.85, -14] as const, steer: false, k: p.gearK * 2, cd: p.gearC * 2, wheel: false },
        { name: "belly_a", pos: [0, -1.6, 6] as const, steer: false, k: p.gearK * 2, cd: p.gearC * 2, wheel: false },
      ];
    let onGround = false;
    for (const leg of legs) {
      const rb = new Vector3(leg.pos[0], leg.pos[1], leg.pos[2]).sub(this.cg);
      const rw = rb.clone().applyQuaternion(this.quat);
      const pw = this.pos.clone().add(rw);
      const pen = -pw.y;
      if (pen <= 0) continue;
      onGround = true;
      const vp = this.vel.clone().add(omegaW.clone().cross(rw));
      const N = Math.max(0, leg.k * pen - leg.cd * vp.y);
      const force = up.clone().multiplyScalar(N);
      // wheel axes on the ground plane
      let heading = new Vector3(0, 0, -1).applyQuaternion(this.quat).setY(0).normalize();
      if (leg.steer) {
        const steer = c.tiller * p.noseSteerMax + c.rudder * p.pedalSteerMax;
        heading = heading.applyAxisAngle(up, -steer);
      }
      const side = new Vector3().crossVectors(heading, up).normalize();
      const vLong = vp.dot(heading);
      const vLat = vp.dot(side);
      let mu = leg.wheel ? p.rollFriction : 0.5;
      if (leg.wheel && !leg.steer) mu += p.brakeFriction * Math.max(c.brakes, c.parkingBrake ? 1 : 0);
      force.addScaledVector(heading, -mu * N * Math.tanh(vLong / 0.3));
      const muLat = leg.wheel ? p.lateralFriction : 0.5;
      force.addScaledVector(side, -muLat * N * Math.tanh(vLat / 0.3));
      Fw.add(force);
      Mw.add(rw.clone().cross(force));
    }
    this.readout.onGround = onGround;
    void dt;
  }

  /** Landing gear legs as the ground contact sees them, from the current state (also on multiplayer
   * replicas): compression (m, the spring's penetration; 0 off the ground) and rolling speed (m/s along
   * the wheel's heading, + forward). Used by the exterior model for oleo travel, wheel spin, tire smoke. */
  legContacts(): { name: string; comp: number; roll: number }[] {
    const omegaW = this.omega.clone().applyQuaternion(this.quat);
    const fwd = new Vector3(0, 0, -1).applyQuaternion(this.quat).setY(0);
    if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, -1);
    fwd.normalize();
    return this.p.gear.map((g) => {
      const rw = new Vector3(g.pos[0], g.pos[1], g.pos[2]).sub(this.cg).applyQuaternion(this.quat);
      const pen = -(this.pos.y + rw.y);
      const vp = this.vel.clone().add(omegaW.clone().cross(rw));
      return { name: g.name, comp: this.gearPos > 0.98 ? Math.max(0, pen) : 0, roll: vp.dot(fwd) };
    });
  }

  // ---------------------------------------------------------------- readout

  /** Recompute the instrument readout from the current state (multiplayer replicas, which do not integrate). */
  refreshReadout(dt: number) {
    this.updateReadout(dt);
  }

  private updateReadout(dt: number) {
    const r = this.readout;
    const air = atmosphere(this.pos.y);
    const qInv = this.quat.clone().invert();
    const vb = this.vel.clone().applyQuaternion(qInv);
    const V = vb.length();
    const fwd = new Vector3(0, 0, -1).applyQuaternion(this.quat);
    const right = new Vector3(1, 0, 0).applyQuaternion(this.quat);
    const upB = new Vector3(0, 1, 0).applyQuaternion(this.quat);
    const heading = ((Math.atan2(fwd.x, -fwd.z) * 180) / Math.PI + 360) % 360;
    if (dt > 0) {
      let dh = heading - this.lastHeading;
      if (dh > 180) dh -= 360;
      if (dh < -180) dh += 360;
      this.headingRate += (dh / dt - this.headingRate) * Math.min(1, dt * 3);
    }
    this.lastHeading = heading;
    const gearBottom = this.p.gear[0].pos[1] - this.cg.y;
    r.ias_mph = V * Math.sqrt(air.sigma) * MPS_TO_MPH;
    r.tas_mps = V;
    r.alt_ft = this.pos.y * M_TO_FT;
    r.agl_ft = Math.max(0, (this.pos.y + gearBottom) * M_TO_FT);
    r.vs_fpm = this.vel.y * M_TO_FT * 60;
    r.heading_deg = heading;
    r.pitch_deg = (Math.asin(clamp(fwd.y, -1, 1)) * 180) / Math.PI;
    r.roll_deg = (Math.atan2(-right.y, upB.y) * 180) / Math.PI;
    r.turn_rate = clamp(this.headingRate / 1.5, -1.5, 1.5);
    r.alpha_deg = (Math.atan2(-vb.y, Math.max(-vb.z, 0.1)) * 180) / Math.PI;
    r.beta_deg = V > 1 ? (Math.asin(clamp(vb.x / V, -1, 1)) * 180) / Math.PI : 0;
    r.rpm_avg = this.pistons.reduce((a, e) => a + e.rpm, 0) / this.pistons.length;
    r.map_avg = this.pistons.reduce((a, e) => a + e.map, 0) / this.pistons.length;
    this.pistons.forEach((e, i) => {
      const n = `eng${i + 1}_`;
      r[n + "rpm"] = e.rpm;
      r[n + "map"] = e.map;
      r[n + "cht"] = e.cht;
      r[n + "oilt"] = e.oilT;
      r[n + "oilp"] = e.oilP;
      r[n + "ff"] = e.ff;
    });
    r.fuel_L = this.fuel.side("L");
    r.fuel_R = this.fuel.side("R");
    r.fuel_total = this.fuel.total;
    this.jets.forEach((j, i) => {
      r[`jet${i + 1}_rpm`] = j.rpmPct;
      r[`jet${i + 1}_egt`] = j.egt;
      r[`jet${i + 1}_fuel`] = j.fuelPress;
      r[`jet${i + 1}_oil`] = j.oilPress;
    });
    const now = new Date();
    r.clock_h = (now.getHours() % 12) + now.getMinutes() / 60;
    r.clock_m = now.getMinutes() + now.getSeconds() / 60;
    r.flap_pos = this.flapPos;
    r.gear_pos = this.gearPos;
  }
}
