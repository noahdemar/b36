// Mouse-aim "instructor" (War Thunder style): the pilot points the mouse where the aircraft should go
// and this controller flies there with protections suited to a heavy bomber. Writes elevator, aileron
// and rudder. Limits are ESTIMATED; gains tuned and checked in instructor_test.ts.
import type { Vector3 } from "three";
import type { FlightModel } from "./flightmodel.ts";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const R2D = 180 / Math.PI;

export const INSTRUCTOR = {
  maxBank: 30, // deg
  maxClimb: 10, // deg flight path
  maxDive: 12, // deg flight path
  maxG: 1.7, // below the 2.0 g limit of the damage model
  minIas: 160, // mph: no climb commanded below this
};

export class Instructor {
  private pitchI = 0;
  private hdgI = 0;
  private alphaF = NaN;
  private pitchCmd = NaN;

  reset(fm: FlightModel) {
    this.pitchI = fm.controls.elevator;
    this.hdgI = 0;
    this.alphaF = fm.readout.alpha_deg;
    this.pitchCmd = fm.readout.pitch_deg;
  }

  /** aim: unit direction (world) the pilot points at. */
  update(fm: FlightModel, dt: number, aim: Vector3) {
    const r = fm.readout;
    const c = fm.controls;
    const q = fm.omega.x;
    const p = -fm.omega.z;
    const hdgAim = (Math.atan2(aim.x, -aim.z) * R2D + 360) % 360;
    let gamma = clamp(Math.asin(clamp(aim.y, -1, 1)) * R2D, -INSTRUCTOR.maxDive, INSTRUCTOR.maxClimb);
    if (r.ias_mph < INSTRUCTOR.minIas) gamma = Math.min(gamma, (r.ias_mph - INSTRUCTOR.minIas) * 0.3);
    if (Number.isNaN(this.alphaF)) this.alphaF = r.alpha_deg;
    this.alphaF += (r.alpha_deg - this.alphaF) * Math.min(1, dt / 4);
    if (r.onGround || r.tas_mps < 40) {
      // takeoff roll: hold the nose down until the aim is raised and there is flying speed
      c.elevator = r.ias_mph > 120 && gamma > 2 ? 0.45 : 0;
      c.aileron = 0;
      const hdgErr = wrap180(hdgAim - r.heading_deg);
      c.rudder = clamp(hdgErr * 0.05, -1, 1);
      return;
    }
    // flight path angle in a bank: hold altitude-ish lift, pitch toward the aim
    const vsNow = r.vs_fpm;
    const gammaNow = Math.asin(clamp(vsNow / (r.tas_mps * 196.85), -1, 1)) * R2D;
    // pitch target moves at a limited rate (a heavy bomber is flown smoothly)
    const want = clamp(gamma + (gamma - gammaNow) * 0.3, -14, 14) + this.alphaF;
    if (Number.isNaN(this.pitchCmd)) this.pitchCmd = r.pitch_deg;
    this.pitchCmd += clamp(want - this.pitchCmd, -2.5 * dt, 2.5 * dt);
    const err = this.pitchCmd - r.pitch_deg;
    this.pitchI = clamp(this.pitchI + err * 0.02 * dt, -0.6, 0.6);
    let elev = this.pitchI + err * 0.06 - q * 1.5;
    // load factor protection: back off the elevator in proportion to the excess
    const n = fm.damage.loadFactor;
    if (n > INSTRUCTOR.maxG - 0.2) elev -= (n - (INSTRUCTOR.maxG - 0.2)) * 0.8;
    if (n < 0.4) elev += (0.4 - n) * 0.8;
    c.elevator = clamp(elev, -0.9, 0.9);
    const hdgErr = wrap180(hdgAim - r.heading_deg);
    if (Math.abs(hdgErr) < 10) this.hdgI = clamp(this.hdgI + hdgErr * 0.05 * dt, -5, 5);
    else this.hdgI *= 1 - Math.min(1, dt);
    const bankCmd = clamp(hdgErr * 1.5 + this.hdgI, -INSTRUCTOR.maxBank, INSTRUCTOR.maxBank);
    c.aileron = clamp((bankCmd - r.roll_deg) * 0.045 - p * 1.2, -0.8, 0.8);
    c.rudder = clamp(r.beta_deg * 0.15, -0.3, 0.3);
  }
}
