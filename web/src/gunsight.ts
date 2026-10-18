// Computing gun sight for the remote gunnery stations: the gunner holds the pipper on the target and
// frames it with the ranging ring (mouse wheel); the sight measures the tracking rate (gyro, time
// constant below) and the computer offsets the guns for lead, drop and trail. The tail station has radar
// ranging (APG-41 style lock-on). Reticle, ammunition, heat and stoppages are drawn on an overlay canvas.
// All sight constants are ESTIMATED.
import * as THREE from "three";
import { MIG } from "./weapons/fighters";
import { RANGE_MAX, RANGE_MIN, SightComputer } from "./weapons/sightcomputer";
import type { Turret } from "./weapons/turrets";

export class GunSight extends SightComputer {
  readonly canvas = document.createElement("canvas");
  private g: CanvasRenderingContext2D;
  private flash = { text: "", t: 0, color: "#ffd27a" };
  kills = 0;
  shake = 0;

  constructor() {
    super();
    this.canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:0;display:none;";
    document.body.appendChild(this.canvas);
    this.g = this.canvas.getContext("2d")!;
  }

  notify(text: string, color = "#ffd27a") {
    this.flash = { text, t: 1.2, color };
  }

  /** Overlay: reticle with ranging ring, gun line, lock box, ammunition, heat, stoppages. */
  draw(camera: THREE.PerspectiveCamera, turrets: Turret[], gunLines: THREE.Vector3[], station: string, firing: boolean,
    interrupted: boolean, dt: number, radar: boolean, thirdPerson = false) {
    const c = this.canvas;
    const W = window.innerWidth, H = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio, 2);
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const f = H / 2 / Math.tan((camera.fov * Math.PI) / 360);
    // sight vibration while the guns fire
    this.shake = firing ? Math.min(1, this.shake + dt * 8) : Math.max(0, this.shake - dt * 6);
    const jx = (Math.random() - 0.5) * 3 * this.shake, jy = (Math.random() - 0.5) * 3 * this.shake;
    const cx = W / 2 + jx, cy = H / 2 + jy;
    // optic: dark surround beyond the reflector glass
    const rad = Math.min(W, H) * 0.46;
    if (!thirdPerson) {
      const vg = g.createRadialGradient(W / 2, H / 2, rad * 0.75, W / 2, H / 2, rad * 1.25);
      vg.addColorStop(0, "rgba(0,0,0,0)");
      vg.addColorStop(1, "rgba(0,0,0,0.78)");
      g.fillStyle = vg;
      g.fillRect(0, 0, W, H);
    }
    const amber = "rgba(255,176,64,0.95)";
    g.strokeStyle = amber;
    g.fillStyle = amber;
    g.shadowColor = "rgba(255,140,30,0.9)";
    g.shadowBlur = 3;
    g.lineWidth = 1.5;
    // fixed reticle: pipper, 50 mil circle with 10 mil ticks
    g.beginPath();
    g.arc(cx, cy, 1.5, 0, Math.PI * 2);
    g.fill();
    const r50 = f * Math.tan(0.05);
    g.beginPath();
    g.arc(cx, cy, r50, 0, Math.PI * 2);
    g.stroke();
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (r50 + 4), cy + Math.sin(a) * (r50 + 4));
      g.lineTo(cx + Math.cos(a) * (r50 + 14), cy + Math.sin(a) * (r50 + 14));
      g.stroke();
    }
    // ranging ring: diamonds at the angular half-span of a MiG-15 at the set range
    const rr = Math.max(7, f * Math.atan(MIG.span / 2 / this.range));
    const dm = rr < 14 ? 1.6 : 2.6;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4 + Math.PI / 8;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      g.beginPath();
      g.moveTo(x, y - dm); g.lineTo(x + dm, y); g.lineTo(x, y + dm); g.lineTo(x - dm, y);
      g.closePath();
      g.fill();
    }
    // range scale (right of the circle)
    const sx = cx + r50 + 34, top = cy - 90, bot = cy + 90;
    g.beginPath();
    g.moveTo(sx, top); g.lineTo(sx, bot); g.stroke();
    const yOf = (m: number) => bot - ((Math.log(m) - Math.log(RANGE_MIN)) / (Math.log(RANGE_MAX) - Math.log(RANGE_MIN))) * (bot - top);
    g.font = "10px ui-monospace, monospace";
    for (const m of [200, 400, 600, 800, 1000, 1500]) {
      g.beginPath(); g.moveTo(sx, yOf(m)); g.lineTo(sx + 5, yOf(m)); g.stroke();
      g.fillText(String(m), sx + 8, yOf(m) + 3);
    }
    const ym = yOf(this.range);
    g.beginPath(); g.moveTo(sx - 2, ym); g.lineTo(sx - 9, ym - 5); g.lineTo(sx - 9, ym + 5); g.closePath(); g.fill();
    // gun lines: where each controlled turret's guns point now (slew lag and computed lead)
    g.shadowBlur = 0;
    g.strokeStyle = "rgba(140,255,150,0.8)";
    for (const p of gunLines) {
      const v = p.clone().project(camera);
      if (v.z > 1) continue;
      const x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
      g.beginPath();
      g.moveTo(x - 6, y); g.lineTo(x - 2, y); g.moveTo(x + 2, y); g.lineTo(x + 6, y);
      g.moveTo(x, y - 6); g.lineTo(x, y - 2); g.moveTo(x, y + 2); g.lineTo(x, y + 6);
      g.stroke();
    }
    // text block
    g.shadowBlur = 4;
    g.shadowColor = "#000";
    g.fillStyle = "rgba(255,210,140,0.95)";
    g.font = "13px ui-monospace, monospace";
    let y = H - 18 - turrets.length * 18 - 36;
    const mode = radar ? (this.lock ? "RADAR LOCK" : "RADAR SEARCH") : this.assist ? (this.lock ? "RANGE ASSIST LOCK" : "RANGE ASSIST") : "MANUAL RANGE";
    g.fillText(`${station.toUpperCase()}   RANGE ${this.range.toFixed(0)} m   ${mode}   KILLS ${this.kills}`, 16, y);
    y += 18;
    for (const t of turrets) {
      const name = t.name.replace("Turret_", "").replace(/_/g, " ");
      const status = !t.ready ? (t.ext > 0 && t.ext < 1 ? "MOVING" : "STOWED (U)")
        : t.ammo <= 0 ? "OUT OF AMMUNITION"
        : t.jam[0] > 0 || t.jam[1] > 0 ? `STOPPAGE GUN ${t.jam[0] > 0 ? 1 : 2}: CHARGING`
        : interrupted ? "INTERRUPTED" : t.atLimit ? "AT LIMIT" : t.slewing ? "SLEWING" : "READY";
      const bad = status !== "READY" && status !== "SLEWING";
      const heat = "|".repeat(Math.round(Math.min(1, t.heat) * 10)).padEnd(10, ".");
      g.fillStyle = bad ? "rgba(255,110,90,0.95)" : "rgba(255,210,140,0.95)";
      g.fillText(`${name.padEnd(12)} L ${String(t.ammoGun[0]).padStart(3)}  R ${String(t.ammoGun[1]).padStart(3)}  HEAT [${heat}]  ${status}`, 16, y);
      y += 18;
    }
    g.fillStyle = "rgba(220,220,220,0.85)";
    g.font = "12px ui-monospace, monospace";
    g.fillText(`hold the pipper on him, wheel: frame his wings in the diamonds${radar ? "" : ", G: range assist"}   fire: hold left button / Space   U: turrets   Shift+wheel: zoom`, 16, y + 4);
    if (this.flash.t > 0) {
      this.flash.t -= dt;
      g.font = "bold 18px ui-monospace, monospace";
      g.fillStyle = this.flash.color;
      g.globalAlpha = Math.min(1, this.flash.t * 2);
      g.fillText(this.flash.text, cx - g.measureText(this.flash.text).width / 2, cy - r50 - 26);
      g.globalAlpha = 1;
    }
  }

  /** Lock bracket around a target at a screen position (pixels). */
  bracket(x: number, y: number, size: number) {
    const g = this.g;
    const s = Math.max(14, size);
    g.strokeStyle = "rgba(255,90,70,0.95)";
    g.lineWidth = 1.5;
    g.shadowBlur = 0;
    for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      g.beginPath();
      g.moveTo(x + dx * s, y + dy * s * 0.6);
      g.lineTo(x + dx * s, y + dy * s);
      g.lineTo(x + dx * s * 0.6, y + dy * s);
      g.stroke();
    }
  }
}
