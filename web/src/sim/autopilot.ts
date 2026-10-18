// Simple altitude + heading hold (stand-in for the B-36's E-4 autopilot). Writes elevator and
// aileron commands into the flight model controls each step. Gains tuned by autopilot_test.ts.
import type { FlightModel } from "./flightmodel.ts";

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

export class Autopilot {
  engaged = false;
  altitudeFt = 0;
  headingDeg = 0;
  private pitchI = 0;
  private hdgI = 0;
  private alphaF = NaN; // low-passed angle of attack: instantaneous alpha in the pitch command feeds back
  /** Below this indicated airspeed the climb command is reduced (no autothrottle). */
  minIasMph = 150;

  engage(fm: FlightModel) {
    this.engaged = true;
    this.altitudeFt = fm.readout.alt_ft;
    this.headingDeg = fm.readout.heading_deg;
    this.pitchI = fm.controls.elevator;
    this.hdgI = 0;
    this.alphaF = fm.readout.alpha_deg;
  }

  disengage() {
    this.engaged = false;
  }

  /** Bombardier / pilot heading adjustments while engaged. */
  turn(deltaDeg: number) {
    this.headingDeg = (this.headingDeg + deltaDeg + 360) % 360;
  }

  update(fm: FlightModel, dt: number) {
    if (!this.engaged) return;
    const r = fm.readout;
    const c = fm.controls;
    const q = fm.omega.x; // pitch rate, rad/s
    const p = -fm.omega.z; // roll rate right
    // altitude -> vertical speed -> pitch -> elevator
    let vsCmd = clamp((this.altitudeFt - r.alt_ft) * 0.5, -1200, 1200); // ft/min
    vsCmd = Math.min(vsCmd, (r.ias_mph - this.minIasMph) * 60); // speed protection
    if (Number.isNaN(this.alphaF)) this.alphaF = r.alpha_deg;
    this.alphaF += (r.alpha_deg - this.alphaF) * Math.min(1, dt / 4);
    const pitchCmd = clamp((vsCmd - r.vs_fpm) * 0.004, -6, 8) + this.alphaF; // deg
    const err = pitchCmd - r.pitch_deg;
    this.pitchI = clamp(this.pitchI + err * 0.02 * dt, -0.6, 0.6);
    c.elevator = clamp(this.pitchI + err * 0.06 - q * 1.5, -0.8, 0.8);
    // heading -> bank -> aileron
    const hdgErr = wrap180(this.headingDeg - r.heading_deg);
    if (Math.abs(hdgErr) < 15) this.hdgI = clamp(this.hdgI + hdgErr * 0.05 * dt, -5, 5);
    const bankCmd = clamp(hdgErr * 1.2 + this.hdgI, -20, 20);
    c.aileron = clamp((bankCmd - r.roll_deg) * 0.04 - p * 1.2, -0.6, 0.6);
    // light rudder coordination against sideslip
    c.rudder = clamp(r.beta_deg * 0.15, -0.3, 0.3);
    void DEG;
  }
}
