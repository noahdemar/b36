// Lower-deck displays: the navigator's chart and the radar observer's AN/APS-23 PPI scope.
// Both draw into canvases shown on the interior surfaces (CanvasTexture) and, on demand, full screen.
// Figures marked ESTIMATED are not from a B-36 / APS-23 source.
import * as THREE from "three";
import type { BombingRange } from "./range";
import { RANGE_CENTER } from "./range";
import type { FlightModel } from "./sim/flightmodel";
import { RUNWAY } from "./world";

const MI = 1609.344;
const KM = 1000;
const wrap360 = (d: number) => ((d % 360) + 360) % 360;
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Bearing (deg true, north = -z) and distance (m) from a to b, world (sim) frame. */
export function bearingTo(ax: number, az: number, bx: number, bz: number) {
  return { brg: wrap360((Math.atan2(bx - ax, -(bz - az)) * 180) / Math.PI), dist: Math.hypot(bx - ax, bz - az) };
}

export interface Waypoint { name: string; x: number; z: number }
export const WAYPOINTS: Waypoint[] = [
  { name: "BASE", x: 0, z: 40 - RUNWAY.length },
  { name: "IP", x: RANGE_CENTER.x, z: RANGE_CENTER.z + 15_000 }, // initial point of the bomb run
  { name: "TARGET", x: RANGE_CENTER.x, z: RANGE_CENTER.z },
];

// ------------------------------------------------------------------------------------------- chart

export class NavChart {
  readonly canvas = document.createElement("canvas");
  readonly texture: THREE.CanvasTexture;
  waypoint: Waypoint = WAYPOINTS[2];
  coupled = false; // navigator steering the autopilot toward the waypoint
  scaleKm = 25; // chart square side
  private ctx: CanvasRenderingContext2D;
  private center = new THREE.Vector2(0, -15_000);
  private track: THREE.Vector2[] = [];
  private trackT = 0;
  private map = { x: 0, y: 0, s: 0 }; // map square on the canvas (px)

  constructor() {
    this.canvas.width = 2048;
    this.canvas.height = 600;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.map = { x: 724, y: 0, s: 600 };
  }

  /** Canvas pixel -> world point (for clicks on the full-screen chart). */
  pick(px: number, py: number): Waypoint | null {
    const m = this.map;
    if (px < m.x || px > m.x + m.s || py < m.y || py > m.y + m.s) return null;
    const k = (this.scaleKm * KM) / m.s;
    return { name: "MARK", x: this.center.x + (px - m.x - m.s / 2) * k, z: this.center.y + (py - m.y - m.s / 2) * k };
  }

  zoom(dir: number) {
    const s = [10, 25, 50, 100];
    this.scaleKm = s[Math.max(0, Math.min(s.length - 1, s.indexOf(this.scaleKm) + dir))];
    this.center.set(1e9, 1e9); // redraw a sheet around the aircraft
  }

  update(fm: FlightModel, range: BombingRange | null, dt: number, draw: boolean) {
    this.trackT -= dt;
    if (this.trackT <= 0) {
      this.trackT = 5;
      this.track.push(new THREE.Vector2(fm.pos.x, fm.pos.z));
      if (this.track.length > 720) this.track.shift();
    }
    const half = (this.scaleKm * KM) / 2;
    if (Math.abs(fm.pos.x - this.center.x) > half * 0.7 || Math.abs(fm.pos.z - this.center.y) > half * 0.7) {
      // new sheet: aircraft a third of the way in from the trailing edge, looking along the track
      const g = this.scaleKm * KM * 0.1;
      const v = Math.hypot(fm.vel.x, fm.vel.z) || 1;
      const ax = fm.pos.x + (fm.vel.x / v) * half * 0.4, az = fm.pos.z + (fm.vel.z / v) * half * 0.4;
      this.center.set(Math.round(ax / g) * g, Math.round(az / g) * g);
    }
    if (draw) this.draw(fm, range);
  }

  info(fm: FlightModel) {
    const gs = Math.hypot(fm.vel.x, fm.vel.z);
    const trk = wrap360((Math.atan2(fm.vel.x, -fm.vel.z) * 180) / Math.PI);
    const w = bearingTo(fm.pos.x, fm.pos.z, this.waypoint.x, this.waypoint.z);
    return { gs, trk, ...w, ete: gs > 5 ? w.dist / gs : Infinity };
  }

  private draw(fm: FlightModel, range: BombingRange | null) {
    const c = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    c.fillStyle = "#e9e2cc";
    c.fillRect(0, 0, W, H);
    const m = this.map;
    const k = m.s / (this.scaleKm * KM);
    const toPx = (x: number, z: number) => [m.x + m.s / 2 + (x - this.center.x) * k, m.y + m.s / 2 + (z - this.center.y) * k];
    c.save();
    c.beginPath();
    c.rect(m.x, m.y, m.s, m.s);
    c.clip();
    c.fillStyle = "#dfe6c8"; // land tint
    c.fillRect(m.x, m.y, m.s, m.s);
    // grid every 5 km (1 km at the 10 km scale)
    const g = this.scaleKm <= 10 ? 1000 : this.scaleKm >= 100 ? 10_000 : 5000;
    c.strokeStyle = "rgba(60,90,120,0.35)";
    c.lineWidth = 1;
    c.font = "13px monospace";
    c.fillStyle = "rgba(60,90,120,0.8)";
    const half = (this.scaleKm * KM) / 2;
    for (let x = Math.ceil((this.center.x - half) / g) * g; x <= this.center.x + half; x += g) {
      const [px] = toPx(x, 0);
      c.beginPath(); c.moveTo(px, m.y); c.lineTo(px, m.y + m.s); c.stroke();
      c.fillText(`${(x / 1000).toFixed(0)}`, px + 2, m.y + m.s - 4);
    }
    for (let z = Math.ceil((this.center.y - half) / g) * g; z <= this.center.y + half; z += g) {
      const [, py] = toPx(0, z);
      c.beginPath(); c.moveTo(m.x, py); c.lineTo(m.x + m.s, py); c.stroke();
      c.fillText(`${(-z / 1000).toFixed(0)}`, m.x + 2, py - 2);
    }
    // runway
    c.fillStyle = "#555";
    const [r0x, r0y] = toPx(-RUNWAY.width / 2, 40 - RUNWAY.length);
    c.fillRect(r0x, r0y, Math.max(2, RUNWAY.width * k), RUNWAY.length * k);
    // range circles and targets
    c.strokeStyle = "#a02020";
    c.lineWidth = 2;
    const [cx, cy] = toPx(RANGE_CENTER.x, RANGE_CENTER.z);
    for (const r of [300, 600, 2000]) { c.beginPath(); c.arc(cx, cy, r * k, 0, Math.PI * 2); c.stroke(); }
    if (range) {
      for (const t of range.targets) {
        const [tx, ty] = toPx(t.pos.x, t.pos.z);
        c.fillStyle = t.destroyed ? "#555" : "#a02020";
        c.fillRect(tx - 2, ty - 2, 4, 4);
      }
    }
    // waypoints
    c.font = "bold 15px monospace";
    for (const wp of [...WAYPOINTS, this.waypoint]) {
      const [wx, wy] = toPx(wp.x, wp.z);
      c.strokeStyle = wp === this.waypoint ? "#1c3fa0" : "#4a5a70";
      c.beginPath(); c.moveTo(wx, wy - 8); c.lineTo(wx + 7, wy + 6); c.lineTo(wx - 7, wy + 6); c.closePath(); c.stroke();
      c.fillStyle = c.strokeStyle;
      c.fillText(wp.name, wx + 9, wy + 5);
    }
    // track history and course line
    c.strokeStyle = "#202020";
    c.setLineDash([4, 4]);
    c.beginPath();
    this.track.forEach((p, i) => { const [x, y] = toPx(p.x, p.y); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
    c.lineTo(...(toPx(fm.pos.x, fm.pos.z) as [number, number]));
    c.stroke();
    c.setLineDash([]);
    const [ax, ay] = toPx(fm.pos.x, fm.pos.z);
    const [wx, wy] = toPx(this.waypoint.x, this.waypoint.z);
    c.strokeStyle = "#1c3fa0";
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(ax, ay); c.lineTo(wx, wy); c.stroke();
    // aircraft symbol
    const hdg = (fm.readout.heading_deg * Math.PI) / 180;
    c.save();
    c.translate(ax, ay);
    c.rotate(hdg);
    c.fillStyle = "#000";
    c.beginPath(); c.moveTo(0, -11); c.lineTo(9, 7); c.lineTo(0, 3); c.lineTo(-9, 7); c.closePath(); c.fill();
    c.restore();
    c.restore();
    c.strokeStyle = "#333";
    c.lineWidth = 3;
    c.strokeRect(m.x, m.y, m.s, m.s);

    // log (left) and leg data (right)
    const i = this.info(fm);
    const r = fm.readout;
    c.fillStyle = "#1a1a1a";
    c.font = "bold 30px monospace";
    c.fillText("NAVIGATOR'S LOG", 30, 50);
    c.font = "26px monospace";
    const posE = fm.pos.x / 1000, posN = -fm.pos.z / 1000;
    const left = [
      `POSITION   ${posN.toFixed(1)} km N  ${posE.toFixed(1)} km E`,
      `HEADING    ${r.heading_deg.toFixed(0).padStart(3, "0")}`,
      `TRACK      ${i.trk.toFixed(0).padStart(3, "0")}`,
      `TAS        ${((r.tas_mps as number) * 2.23694).toFixed(0)} mph`,
      `GROUNDSPD  ${(i.gs * 2.23694).toFixed(0)} mph`,
      `ALTITUDE   ${r.alt_ft.toFixed(0)} ft`,
      `WIND       CALM`,
      `CHART      ${this.scaleKm} km square`,
    ];
    left.forEach((t, n) => c.fillText(t, 30, 110 + n * 56));
    c.font = "bold 30px monospace";
    c.fillText(`LEG TO ${this.waypoint.name}`, 1360, 50);
    c.font = "26px monospace";
    const fuelH = fm.pistons.reduce((a, e) => a + e.ff, 0);
    const endur = fuelH > 0 ? fm.fuel.total / fuelH : Infinity;
    const right = [
      `BEARING    ${i.brg.toFixed(0).padStart(3, "0")}`,
      `DISTANCE   ${(i.dist / MI).toFixed(1)} mi`,
      `ETE        ${isFinite(i.ete) ? `${Math.floor(i.ete / 60)} min ${Math.round(i.ete % 60)} s` : "-"}`,
      `TURN       ${wrap180(i.brg - r.heading_deg) >= 0 ? "R" : "L"} ${Math.abs(wrap180(i.brg - r.heading_deg)).toFixed(0)}`,
      `AUTOPILOT  ${this.coupled ? "COUPLED TO NAV" : "-"}`,
      `FUEL       ${fm.fuel.total.toFixed(0)} lb`,
      `ENDURANCE  ${isFinite(endur) ? endur.toFixed(1) + " h" : "-"}`,
      `RANGE      ${isFinite(endur) ? ((endur * 3600 * i.gs) / MI).toFixed(0) + " mi" : "-"}`,
    ];
    right.forEach((t, n) => c.fillText(t, 1360, 110 + n * 56));
    this.texture.needsUpdate = true;
  }
}

// ------------------------------------------------------------------------------------------- radar

// AN/APS-23 search/bombing radar. Ranges, scan rate and beam width ESTIMATED.
const RADAR_RANGES_MI = [10, 25, 50, 100];
const SCAN_RPM = 20;
const BEAM_DEG = 2.5;

function hash2(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Smooth value noise, cells of `cell` metres. */
function vnoise(x: number, z: number, cell: number) {
  const gx = x / cell, gz = z / cell;
  const ix = Math.floor(gx), iz = Math.floor(gz);
  const fx = gx - ix, fz = gz - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

export class RadarScope {
  readonly canvas = document.createElement("canvas");
  readonly texture: THREE.CanvasTexture;
  rangeIdx = 1;
  gain = 0.6;
  /** Optional bomb impact prediction (world x, z) drawn as a cross for radar bombing. */
  impact: { x: number; z: number } | null = null;
  private ppi = document.createElement("canvas");
  private pctx: CanvasRenderingContext2D;
  private ctx: CanvasRenderingContext2D;
  private az = 0; // antenna azimuth relative to the nose, rad
  private static N = 512;

  constructor() {
    const N = RadarScope.N;
    this.canvas.width = this.canvas.height = N;
    this.ppi.width = this.ppi.height = N;
    this.ctx = this.canvas.getContext("2d")!;
    this.pctx = this.ppi.getContext("2d")!;
    this.pctx.fillStyle = "#000";
    this.pctx.fillRect(0, 0, N, N);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
  }

  get rangeMi() {
    return RADAR_RANGES_MI[this.rangeIdx];
  }

  setRange(dir: number) {
    this.rangeIdx = Math.max(0, Math.min(RADAR_RANGES_MI.length - 1, this.rangeIdx + dir));
    this.pctx.fillStyle = "#000";
    this.pctx.fillRect(0, 0, RadarScope.N, RadarScope.N);
  }

  update(fm: FlightModel, range: BombingRange | null, dt: number, draw: boolean) {
    const N = RadarScope.N, c0 = N / 2, R = N / 2 - 8;
    const maxR = this.rangeMi * MI;
    const hdg = (fm.readout.heading_deg * Math.PI) / 180;
    const sweep = Math.min(2 * Math.PI, ((SCAN_RPM * 2 * Math.PI) / 60) * dt);
    const a0 = this.az, a1 = this.az + sweep;
    this.az = a1 % (2 * Math.PI);
    if (!draw) return;
    const p = this.pctx;
    // phosphor decay: one full scan fades a return to about 15% (ESTIMATED)
    p.fillStyle = `rgba(0,0,0,${Math.min(1, 1 - Math.pow(0.15, sweep / (2 * Math.PI)))})`;
    p.fillRect(0, 0, N, N);
    const h = Math.max(fm.pos.y, 1);
    const step = 0.5 * (Math.PI / 180);
    const img = p.getImageData(0, 0, N, N);
    const d = img.data;
    const plot = (px: number, py: number, v: number) => {
      const ix = px | 0, iy = py | 0;
      if (ix < 0 || iy < 0 || ix >= N || iy >= N) return;
      const o = (iy * N + ix) * 4;
      d[o] = Math.max(d[o], v * 120);
      d[o + 1] = Math.max(d[o + 1], v * 255);
      d[o + 2] = Math.max(d[o + 2], v * 90);
    };
    for (let a = a0; a < a1; a += step) {
      const sa = Math.sin(a), ca = Math.cos(a);
      const wa = hdg + a; // true bearing
      const sw = Math.sin(wa), cw = Math.cos(wa);
      for (let i = 0; i < R; i++) {
        const ground = (i / R) * maxR; // display is ground range
        const slant = Math.hypot(ground, h);
        if (slant < h * 1.02) continue; // altitude hole
        const wx = fm.pos.x + ground * sw, wz = fm.pos.z - ground * cw;
        // ground clutter: textured land return, falls off with range (ESTIMATED)
        let v = vnoise(wx, wz, 900) * 0.6 + vnoise(wx, wz, 260) * 0.4;
        v = Math.max(0, v - 0.35) * 1.6 * this.gain * Math.min(1, (6 * h) / slant + 0.25);
        // concrete runway reflects away: dark strip
        if (Math.abs(wx) < RUNWAY.width / 2 && wz < 40 && wz > 40 - RUNWAY.length) v *= 0.1;
        if (v > 0.03) plot(c0 + i * sa, c0 - i * ca, Math.min(1, v));
      }
    }
    // strong returns: range targets (buildings, vehicles), smeared by beam width and pulse length
    if (range) {
      for (const t of range.targets) {
        const dx = t.pos.x - fm.pos.x, dz = t.pos.z - fm.pos.z;
        const g = Math.hypot(dx, dz);
        if (g > maxR || Math.hypot(g, h) < h * 1.02) continue;
        const rel = Math.atan2(dx, -dz) - hdg;
        const relN = ((rel % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const a0n = ((a0 % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        let da = relN - a0n;
        if (da < 0) da += 2 * Math.PI;
        if (da > sweep) continue;
        const strength = (t.destroyed ? 0.45 : 1) * Math.min(1, this.gain * 1.6);
        const big = t.radius > 20 ? 1 : 0.6;
        const ri = (g / maxR) * R;
        const halfBeam = (BEAM_DEG / 2) * (Math.PI / 180);
        for (let b = -halfBeam; b <= halfBeam; b += halfBeam / 4) {
          for (let dr = -1.5; dr <= 1.5; dr += 0.5) {
            plot(c0 + (ri + dr * big) * Math.sin(relN + b), c0 - (ri + dr * big) * Math.cos(relN + b), strength);
          }
        }
      }
    }
    p.putImageData(img, 0, 0);

    // compose: persistence image, range marks, heading marker, sweep, data
    const c = this.ctx;
    c.fillStyle = "#020502";
    c.fillRect(0, 0, N, N);
    c.drawImage(this.ppi, 0, 0);
    c.strokeStyle = "rgba(120,255,120,0.35)";
    c.lineWidth = 1;
    for (let k = 1; k <= 5; k++) { c.beginPath(); c.arc(c0, c0, (R * k) / 5, 0, Math.PI * 2); c.stroke(); }
    c.strokeStyle = "rgba(160,255,160,0.7)";
    c.beginPath(); c.moveTo(c0, c0); c.lineTo(c0, c0 - R); c.stroke(); // heading marker (nose up)
    c.strokeStyle = "rgba(180,255,180,0.9)";
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(c0, c0); c.lineTo(c0 + R * Math.sin(this.az), c0 - R * Math.cos(this.az)); c.stroke();
    if (this.impact) {
      const dx = this.impact.x - fm.pos.x, dz = this.impact.z - fm.pos.z;
      const g = Math.hypot(dx, dz);
      const rel = Math.atan2(dx, -dz) - hdg;
      if (g < maxR) {
        const px = c0 + (g / maxR) * R * Math.sin(rel), py = c0 - (g / maxR) * R * Math.cos(rel);
        c.strokeStyle = "rgba(255,240,140,0.95)";
        c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(px - 9, py); c.lineTo(px + 9, py); c.moveTo(px, py - 9); c.lineTo(px, py + 9); c.stroke();
      }
    }
    c.fillStyle = "rgba(160,255,160,0.9)";
    c.font = "15px monospace";
    c.fillText(`${this.rangeMi} MI  ${this.rangeMi / 5} MI/RING`, 10, 20);
    c.fillText(`GAIN ${(this.gain * 100).toFixed(0)}`, 10, N - 10);
    c.fillText(`HDG ${fm.readout.heading_deg.toFixed(0).padStart(3, "0")}`, N - 82, 20);
    // bezel mask
    c.fillStyle = "#000";
    c.beginPath();
    c.rect(0, 0, N, N);
    c.arc(c0, c0, R + 4, 0, Math.PI * 2, true);
    c.fill("evenodd");
    this.texture.needsUpdate = true;
  }
}

/** Places the displays on the interior: chart on the navigator's table, scope on the radar console. */
export function mountDisplays(root: THREE.Object3D, chart: NavChart, scope: RadarScope) {
  // Model coordinates from tools/model/build_interior.py build_lower_deck (x right, y up, z = d - 24.7).
  const lf = -1.55;
  const chartMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.20, 0.35),
    new THREE.MeshStandardMaterial({ map: chart.texture, roughness: 0.9, emissive: 0xffffff, emissiveMap: chart.texture, emissiveIntensity: 0.25 }));
  chartMesh.name = "NavChart";
  // plane: width along z (fore-aft), height along x; canvas top toward the wall (-x), facing up
  chartMesh.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
  chartMesh.position.set(-1.225, lf + 0.757, 6.0 - 24.7);
  root.add(chartMesh);
  const scopeMesh = new THREE.Mesh(new THREE.CircleGeometry(0.155, 48),
    new THREE.MeshBasicMaterial({ map: scope.texture, toneMapped: false }));
  scopeMesh.name = "RadarScope";
  scopeMesh.position.set(0, lf + 0.80, 4.101 - 24.7 + 0.003);
  root.add(scopeMesh);
  return { chartMesh, scopeMesh };
}
