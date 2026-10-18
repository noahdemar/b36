// Crew member movement inside the aircraft, in model coordinates (x right, y up, z aft; the
// same frame as the GLBs). Data comes from b36_nav.json written by tools/model/build_interior.py.
import { Vector3 } from "three";

export interface Rect { x0: number; x1: number; z0: number; z1: number }
export interface Grid { x0: number; z0: number; step: number; nx: number; nz: number; y: number[] }
export interface Deck { id: string; y: number; rects: Rect[]; ceiling: Grid }
export interface Obstacle { name: string; min: [number, number, number]; max: [number, number, number] }
export interface Ladder { name: string; x: number; path: [number, number, number][]; lower: string; upper: string }
export interface Sight { eye: [number, number, number]; turrets: string[]; nose?: boolean; aft?: boolean }
export interface Seat {
  name: string; station: string; eye: [number, number, number]; yaw: number;
  stand: [number, number, number]; deck: string; flies: boolean; sight?: Sight;
}
export interface TunnelEnd { deck: string; stand: [number, number, number] }
export interface Tunnel { name: string; path: [number, number, number][]; trolley: [number, number]; ends: [TunnelEnd, TunnelEnd] }
/** Inner hull profile: radius at `angles` uniform angles from the top toward +x, per station along z. */
export interface Hull { z0: number; step: number; angles: number; yc: number[]; r: number[][] }

export interface NavData {
  radius: number; eyeStand: number; eyeCrouch: number; hull?: Hull;
  decks: Deck[]; obstacles: Obstacle[]; ladders: Ladder[]; seats: Seat[]; tunnels: Tunnel[];
}

export interface MoveInput { forward: number; strafe: number; run: boolean; crouch: boolean }

export type CrewMode = "seated" | "walking" | "climbing" | "tunnel";
export type Interaction = { kind: "seat"; seat: Seat } | { kind: "ladder"; ladder: Ladder } | { kind: "tunnel"; tunnel: Tunnel; end: 0 | 1 };

const WALK = 1.3; // m/s
const RUN = 2.4;
const CLIMB = 0.55;
const TROLLEY = 1.1; // m/s pulling along the tunnel rope (ESTIMATED)
const STEP_OVER = 0.15; // obstacles lower than this are stepped over
const HEAD_CLEAR = 0.1; // eye stays this far below the ceiling

export class Crew {
  readonly nav: NavData;
  mode: CrewMode = "walking";
  seat: Seat | null = null;
  deck: Deck;
  pos = new Vector3(); // feet, model coords
  yaw = 0; // body heading, 0 = facing forward (-z), + = turn left
  pitch = 0;
  eyeHeight: number;
  private climb: { ladder: Ladder; s: number; dir: 1 | -1; length: number } | null = null;
  tunnel: { t: Tunnel; s: number; length: number; dir: 1 | -1 } | null = null;

  constructor(nav: NavData) {
    this.nav = nav;
    this.deck = nav.decks[0];
    this.eyeHeight = nav.eyeStand;
  }

  deckById(id: string) {
    return this.nav.decks.find((d) => d.id === id)!;
  }

  sit(name: string) {
    const s = this.nav.seats.find((x) => x.name === name);
    if (!s) return;
    this.seat = s;
    this.mode = "seated";
    this.deck = this.deckById(s.deck);
    this.pos.set(s.stand[0], s.stand[1], s.stand[2]);
    this.yaw = 0;
    this.pitch = -0.12;
  }

  standUp() {
    if (!this.seat) return;
    const s = this.seat;
    this.pos.set(s.stand[0], s.stand[1], s.stand[2]);
    this.yaw = s.yaw;
    this.pitch = 0;
    this.seat = null;
    this.mode = "walking";
  }

  /** Start climbing; direction from which end the crew member is nearer. */
  useLadder(l: Ladder) {
    const p = l.path;
    const lengths = p.slice(1).map((q, i) => Math.hypot(q[0] - p[i][0], q[1] - p[i][1], q[2] - p[i][2]));
    const length = lengths.reduce((a, b) => a + b, 0);
    const atBottom = this.deck.id === l.lower;
    this.climb = { ladder: l, s: atBottom ? 0 : length, dir: atBottom ? 1 : -1, length };
    this.mode = "climbing";
    this.yaw = 0;
  }

  /** Enter a tunnel at one of its ends (0 = forward, 1 = aft). */
  useTunnel(t: Tunnel, end: 0 | 1) {
    const length = pathLength(t.path);
    this.tunnel = { t, s: end === 0 ? 0 : length, length, dir: end === 0 ? 1 : -1 };
    this.mode = "tunnel";
    this.yaw = end === 0 ? Math.PI : 0; // face the direction of travel (aft = +z)
    this.pitch = 0;
  }

  private pathPoint(l: { path: [number, number, number][] }, s: number, out: Vector3) {
    const p = l.path;
    let rem = s;
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (rem <= seg || i === p.length - 2) {
        const t = seg > 0 ? Math.min(1, rem / seg) : 1;
        return out.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
      }
      rem -= seg;
    }
    return out;
  }

  /** Nearest seat or ladder end the crew member can reach (for the E key). */
  nearestInteraction(): Interaction | null {
    if (this.mode !== "walking") return null;
    let best: { d: number; v: Interaction } | null = null;
    let tunnel: { d: number; v: Interaction } | null = null;
    for (const t of this.nav.tunnels ?? []) {
      t.ends.forEach((e, i) => {
        if (e.deck !== this.deck.id) return;
        const d = Math.hypot(e.stand[0] - this.pos.x, e.stand[2] - this.pos.z);
        if (d < 1.3 && (!tunnel || d < tunnel.d)) tunnel = { d, v: { kind: "tunnel", tunnel: t, end: i as 0 | 1 } };
      });
    }
    for (const s of this.nav.seats) {
      if (s.deck !== this.deck.id) continue;
      const d = Math.hypot(s.stand[0] - this.pos.x, s.stand[2] - this.pos.z);
      if (d < 1.0 && (!best || d < best.d)) best = { d, v: { kind: "seat", seat: s } };
    }
    for (const l of this.nav.ladders) {
      const end = this.deck.id === l.lower ? l.path[0] : this.deck.id === l.upper ? l.path[l.path.length - 1] : null;
      if (!end) continue;
      const d = Math.hypot(end[0] - this.pos.x, end[2] - this.pos.z);
      if (d < 0.9 && (!best || d < best.d)) best = { d, v: { kind: "ladder", ladder: l } };
    }
    // the tunnel hatch wins unless something else is clearly closer (it sits beside the gunner seats)
    const tb = tunnel as { d: number; v: Interaction } | null;
    const bb = best as { d: number; v: Interaction } | null;
    if (tb && (!bb || tb.d < bb.d + 0.5)) return tb.v;
    return bb?.v ?? null;
  }

  /** Distance to the nearest tunnel entrance on this deck (for a "hatch ahead" hint). */
  tunnelDistance(): number {
    let best = Infinity;
    for (const t of this.nav.tunnels ?? []) for (const e of t.ends) {
      if (e.deck === this.deck.id) best = Math.min(best, Math.hypot(e.stand[0] - this.pos.x, e.stand[2] - this.pos.z));
    }
    return best;
  }

  ceilingAt(x: number, z: number): number {
    const g = this.deck.ceiling;
    const fx = Math.max(0, Math.min(g.nx - 1.001, (x - g.x0) / g.step));
    const fz = Math.max(0, Math.min(g.nz - 1.001, (z - g.z0) / g.step));
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const v = (a: number, b: number) => g.y[b * g.nx + a];
    let c = (v(i, j) * (1 - tx) + v(i + 1, j) * tx) * (1 - tz) + (v(i, j + 1) * (1 - tx) + v(i + 1, j + 1) * tx) * tz;
    // overhead equipment lowers the effective ceiling
    const r = this.nav.radius * 0.6;
    for (const o of this.nav.obstacles) {
      if (o.min[1] < this.deck.y + 1.0) continue;
      if (x > o.min[0] - r && x < o.max[0] + r && z > o.min[2] - r && z < o.max[2] + r) c = Math.min(c, o.min[1]);
    }
    return c;
  }

  private inDeck(x: number, z: number) {
    return this.deck.rects.some((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1);
  }

  /** Clamp to the walkable union of rects (closest point on the nearest rect). */
  private clampToDeck(p: Vector3) {
    if (this.inDeck(p.x, p.z)) return;
    let best = Infinity, bx = p.x, bz = p.z;
    for (const r of this.deck.rects) {
      const cx = Math.max(r.x0, Math.min(r.x1, p.x));
      const cz = Math.max(r.z0, Math.min(r.z1, p.z));
      const d = (cx - p.x) ** 2 + (cz - p.z) ** 2;
      if (d < best) { best = d; bx = cx; bz = cz; }
    }
    p.x = bx;
    p.z = bz;
  }

  private pushOutOfObstacles(p: Vector3) {
    const r = this.nav.radius;
    const feet = this.deck.y, head = this.deck.y + this.eyeHeight + 0.12;
    for (const o of this.nav.obstacles) {
      if (o.max[1] <= feet + STEP_OVER || o.min[1] >= head) continue;
      const cx = Math.max(o.min[0], Math.min(o.max[0], p.x));
      const cz = Math.max(o.min[2], Math.min(o.max[2], p.z));
      const dx = p.x - cx, dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > r * r) continue;
      if (d2 > 1e-10) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * r;
        p.z = cz + (dz / d) * r;
      } else {
        // centre inside the box: leave by the nearest face
        const exits = [p.x - o.min[0], o.max[0] - p.x, p.z - o.min[2], o.max[2] - p.z];
        const k = exits.indexOf(Math.min(...exits));
        if (k === 0) p.x = o.min[0] - r;
        else if (k === 1) p.x = o.max[0] + r;
        else if (k === 2) p.z = o.min[2] - r;
        else p.z = o.max[2] + r;
      }
    }
  }

  update(dt: number, input: MoveInput) {
    if (this.mode === "tunnel" && this.tunnel) {
      const tn = this.tunnel;
      tn.s += tn.dir * input.forward * TROLLEY * (input.run ? 1.6 : 1) * dt;
      if (tn.s <= 0 || tn.s >= tn.length) {
        const end = tn.t.ends[tn.s <= 0 ? 0 : 1];
        this.deck = this.deckById(end.deck);
        this.pos.set(end.stand[0], this.deck.y, end.stand[2]);
        this.yaw = tn.s <= 0 ? 0 : Math.PI;
        this.tunnel = null;
        this.mode = "walking";
      }
      return;
    }
    if (this.mode === "climbing" && this.climb) {
      const c = this.climb;
      c.s += c.dir * CLIMB * dt * (input.forward !== 0 ? 1.6 : 1);
      this.pathPoint(c.ladder, Math.max(0, Math.min(c.length, c.s)), this.pos);
      this.eyeHeight = 1.45;
      if (c.s <= 0 || c.s >= c.length) {
        this.deck = this.deckById(c.s >= c.length ? c.ladder.upper : c.ladder.lower);
        this.pos.y = this.deck.y;
        this.climb = null;
        this.mode = "walking";
        this.yaw = c.dir > 0 ? 0 : Math.PI;
      }
      return;
    }
    if (this.mode !== "walking") return;
    const speed = input.run ? RUN : WALK;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw); // forward on the deck plane
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    let mx = (fx * input.forward + rx * input.strafe) * speed * dt;
    let mz = (fz * input.forward + rz * input.strafe) * speed * dt;
    const n = Math.max(1, Math.ceil(Math.hypot(mx, mz) / 0.04));
    mx /= n;
    mz /= n;
    for (let i = 0; i < n; i++) {
      this.pos.x += mx;
      this.pos.z += mz;
      this.pushOutOfObstacles(this.pos);
      this.clampToDeck(this.pos);
    }
    this.pos.y = this.deck.y;
    const want = input.crouch ? this.nav.eyeCrouch : this.nav.eyeStand;
    const room = this.ceilingAt(this.pos.x, this.pos.z) - this.deck.y - HEAD_CLEAR;
    const target = Math.max(0.8, Math.min(want, room));
    this.eyeHeight += (target - this.eyeHeight) * Math.min(1, dt * 8);
  }

  /** Eye position (model coords) and view angles (yaw about +y, pitch about x). */
  eye(out: Vector3): { yaw: number; pitch: number } {
    if (this.mode === "tunnel" && this.tunnel) {
      this.pathPoint(this.tunnel.t, Math.max(0, Math.min(this.tunnel.length, this.tunnel.s)), out);
      return { yaw: this.yaw, pitch: this.pitch };
    }
    if (this.mode === "seated" && this.seat) {
      out.set(this.seat.eye[0], this.seat.eye[1], this.seat.eye[2]);
      return { yaw: this.seat.yaw + this.yaw, pitch: this.pitch };
    }
    out.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
    this.clampToHull(out);
    return { yaw: this.yaw, pitch: this.pitch };
  }

  /** Keeps a point (model coordinates) inside the inner skin with a margin, so the camera never
   * passes through the airframe. */
  clampToHull(p: Vector3, margin = 0.14) {
    const h = this.nav.hull;
    if (!h) return;
    const fi = Math.max(0, Math.min(h.yc.length - 1.001, (p.z - h.z0) / h.step));
    const i = Math.floor(fi), t = fi - i;
    const yc = h.yc[i] * (1 - t) + h.yc[i + 1] * t;
    const dx = p.x, dy = p.y - yc;
    const ang = ((Math.atan2(dx, dy) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const fa = (ang / (2 * Math.PI)) * h.angles;
    const a0 = Math.floor(fa) % h.angles, a1 = (a0 + 1) % h.angles, ta = fa - Math.floor(fa);
    const rAt = (row: number[]) => row[a0] * (1 - ta) + row[a1] * ta;
    const R = rAt(h.r[i]) * (1 - t) + rAt(h.r[i + 1]) * t - margin;
    const r = Math.hypot(dx, dy);
    if (r > R && r > 1e-6) {
      p.x = (dx / r) * R;
      p.y = yc + (dy / r) * R;
    }
  }
}

function pathLength(p: [number, number, number][]) {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1], p[i][2] - p[i - 1][2]);
  return L;
}
