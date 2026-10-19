// Snapshot interpolation and host clock estimation for multiplayer clients (no DOM, no three.js).
// The host stamps every snapshot with its clock; a client estimates the offset to that clock and
// renders INTERP_DELAY in the past, between the two snapshots that bracket the render time.

export const INTERP_DELAY = 0.1; // s behind the host (3 snapshots at 30 Hz), MEASURED adequate in net_test
export const MAX_EXTRAPOLATE = 0.5; // s of dead reckoning when snapshots stop arriving (MEASURED in net_test: covers 250 ms stalls)

export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];

/** Rigid-body state as sent on the wire. */
export interface Kin { p: V3; v: V3; q: Q4; w: V3 }

/**
 * Playout clock for the crew. Snapshots are stamped with the host's simulation time, which may run
 * slower than real time when the host's frame rate drops. The render clock follows the newest snapshot
 * time (plus the time since it arrived, at most MAX_LEAD), INTERP_DELAY behind, and closes any error
 * by running up to 50% fast or slow; so it locks to the host's real pace, never jumps, and arrival
 * jitter is smoothed out.
 */
export class ClockSync {
  private latestT = NaN;
  private latestArrive = 0;
  private render = NaN;
  private hist: { h: number; l: number }[] = [];
  /** Host simulation seconds per real second, measured over the last PACE_WINDOW of arrivals. */
  pace = 1;
  static MAX_LEAD = 0.3; // s: beyond this without news, stop assuming the host keeps time
  static GAIN = 1.5; // 1/s
  static PACE_WINDOW = 2; // s

  sample(hostT: number, localT: number) {
    if (!Number.isNaN(this.latestT) && hostT <= this.latestT && hostT > this.latestT - 5) return; // not newer
    if (!Number.isNaN(this.latestT) && hostT < this.latestT) this.hist = []; // host reset its clock
    this.latestT = hostT;
    this.latestArrive = localT;
    this.hist.push({ h: hostT, l: localT });
    while (this.hist.length > 2 && this.hist[1].l < localT - ClockSync.PACE_WINDOW) this.hist.shift();
    const o = this.hist[0];
    if (localT - o.l > 0.5) this.pace = Math.max(0.05, Math.min(2, (hostT - o.h) / (localT - o.l)));
  }

  /** Host (simulation) time to render now; call once per frame with the local clock in seconds. */
  renderTime(localT: number, dt: number) {
    if (Number.isNaN(this.latestT)) return NaN;
    const target = this.latestT + Math.min(localT - this.latestArrive, ClockSync.MAX_LEAD) * this.pace - INTERP_DELAY;
    if (Number.isNaN(this.render) || Math.abs(target - this.render) > 1) this.render = target; // first sample, or the host reset
    else {
      const rate = Math.max(0.5, Math.min(1.5, 1 + ClockSync.GAIN * (target - this.render)));
      this.render += dt * this.pace * rate;
    }
    return this.render;
  }
}

/** Time-ordered buffer of stamped snapshots with bracket lookup. */
export class SnapshotBuffer<T extends { t: number }> {
  items: T[] = [];
  private keep: number;

  constructor(keepS = 2) {
    this.keep = keepS;
  }

  push(s: T) {
    if (this.items.length && s.t <= this.items[this.items.length - 1].t) {
      if (s.t < this.items[0].t) return; // very old, ignore
      // out of order (should not happen on TCP): insert in place
      const i = this.items.findIndex((x) => x.t > s.t);
      if (this.items[i - 1]?.t === s.t) return;
      this.items.splice(i, 0, s);
    } else this.items.push(s);
    const newest = this.items[this.items.length - 1].t;
    while (this.items.length > 2 && this.items[0].t < newest - this.keep) this.items.shift();
  }

  get latest(): T | undefined {
    return this.items[this.items.length - 1];
  }

  /** a, b and fraction f in [0, 1] for interpolation; or f > 1 past the newest (extrapolate from b). */
  bracket(t: number): { a: T; b: T; f: number; dt: number } | null {
    const n = this.items.length;
    if (n === 0) return null;
    if (n === 1 || t <= this.items[0].t) return { a: this.items[0], b: this.items[0], f: 0, dt: 0 };
    for (let i = n - 1; i > 0; i--) {
      const a = this.items[i - 1], b = this.items[i];
      if (t >= a.t) {
        const dt = b.t - a.t;
        return { a, b, f: dt > 0 ? (t - a.t) / dt : 0, dt };
      }
    }
    return { a: this.items[0], b: this.items[0], f: 0, dt: 0 };
  }
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

/** Cubic Hermite position from positions and velocities at both ends (dt = b.t - a.t). */
export function hermite(p0: V3, v0: V3, p1: V3, v1: V3, dt: number, f: number): V3 {
  const f2 = f * f, f3 = f2 * f;
  const h00 = 2 * f3 - 3 * f2 + 1, h10 = f3 - 2 * f2 + f, h01 = -2 * f3 + 3 * f2, h11 = f3 - f2;
  return [0, 1, 2].map((i) => h00 * p0[i] + h10 * dt * v0[i] + h01 * p1[i] + h11 * dt * v1[i]) as V3;
}

export function slerp(a: Q4, b: Q4, f: number): Q4 {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let k0 = 1 - f, k1 = f;
  if (cos < 0.9995) {
    const th = Math.acos(cos), s = Math.sin(th);
    k0 = Math.sin((1 - f) * th) / s;
    k1 = Math.sin(f * th) / s;
  }
  const q: Q4 = [a[0] * k0 + bx * k1, a[1] * k0 + by * k1, a[2] * k0 + bz * k1, a[3] * k0 + bw * k1];
  const n = Math.hypot(...q);
  return q.map((x) => x / n) as Q4;
}

/** Integrate a body-rate quaternion forward (omega in body axes, rad/s), for extrapolation. */
export function advanceQuat(q: Q4, w: V3, t: number): Q4 {
  const ang = Math.hypot(...w) * t;
  if (ang < 1e-9) return q;
  const ax = w.map((x) => x / Math.hypot(...w));
  const s = Math.sin(ang / 2);
  const d: Q4 = [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(ang / 2)];
  // q * d (body-frame rotation)
  const [x1, y1, z1, w1] = q, [x2, y2, z2, w2] = d;
  return [
    w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
    w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
    w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
  ];
}

/** Rigid body at render time from a bracket: Hermite position, slerped attitude, or dead reckoning. */
export function sampleKin(a: Kin, b: Kin, f: number, dt: number): Kin {
  if (f <= 1 || dt === 0) {
    const ff = Math.max(0, Math.min(1, f));
    if (dt === 0) return b;
    return {
      p: hermite(a.p, a.v, b.p, b.v, dt, ff),
      v: [0, 1, 2].map((i) => lerp(a.v[i], b.v[i], ff)) as V3,
      q: slerp(a.q, b.q, ff),
      w: [0, 1, 2].map((i) => lerp(a.w[i], b.w[i], ff)) as V3,
    };
  }
  const ext = Math.min((f - 1) * dt, MAX_EXTRAPOLATE);
  return {
    p: [0, 1, 2].map((i) => b.p[i] + b.v[i] * ext) as V3,
    v: b.v,
    q: advanceQuat(b.q, b.w, ext),
    w: b.w,
  };
}

/** Interpolate an angle (radians) the short way round. */
export function lerpAngle(a: number, b: number, f: number) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * f;
}

export { lerp };
