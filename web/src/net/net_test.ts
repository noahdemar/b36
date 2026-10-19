// Multiplayer sync: a manoeuvring bomber on the host, 30 Hz snapshots through a modelled network
// (delay, jitter, TCP head-of-line stalls), a client rendering at 60 Hz with clock estimation and
// interpolation. Measures how far the rendered aircraft is from the true path at the same host time,
// and how smooth it is. Run: node --experimental-strip-types src/net/net_test.ts
import { Quaternion, Vector3 } from "three";
import { Autopilot } from "../sim/autopilot.ts";
import { FlightModel } from "../sim/flightmodel.ts";
import { ClockSync, type Kin, sampleKin, SnapshotBuffer, INTERP_DELAY } from "./interp.ts";

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

interface Snap { t: number; k: Kin }
const kinOf = (fm: FlightModel): Kin => ({
  p: [fm.pos.x, fm.pos.y, fm.pos.z], v: [fm.vel.x, fm.vel.y, fm.vel.z],
  q: [fm.quat.x, fm.quat.y, fm.quat.z, fm.quat.w], w: [fm.omega.x, fm.omega.y, fm.omega.z],
});

/** pace: host simulation seconds per real second (below 1 when the host's frame rate is too low). */
function run(name: string, net: { delay: number; jitter: number; stallP: number; stall: number; loss?: number }, seed = 1, pace = 1) {
  const rng = seeded(seed);
  const fm = new FlightModel();
  fm.damage.randomFailures = false;
  fm.placeInFlight(12_000 * 0.3048, 105, 0);
  fm.controls.throttle.fill(0.75);
  const ap = new Autopilot();
  ap.engage(fm);
  const HOST_DT = 1 / 120, SNAP_DT = 1 / 30, FRAME_DT = 1 / 60;
  const truth: Snap[] = [];
  const inflight: { arrive: number; s: Snap }[] = [];
  const clockOffset = 1234.567; // client clock = host clock - offset
  const buf = new SnapshotBuffer<Snap>();
  const clock = new ClockSync();
  let lastArrive = 0;
  let nextSnap = 0, nextFrame = 1;
  const errs: number[] = [], angErrs: number[] = [], jerks: number[] = [], delays: number[] = [];
  const rendered: { t: number; p: Vector3 }[] = [];
  const T = 120;
  for (let t = 0; t < T; t += HOST_DT) {
    const wall = t / pace;
    // manoeuvres: heading changes and a climb, so the path curves in every axis
    if (Math.abs(t - 10) < HOST_DT / 2) ap.headingDeg = 90;
    if (Math.abs(t - 40) < HOST_DT / 2) ap.altitudeFt = 13_500;
    if (Math.abs(t - 60) < HOST_DT / 2) ap.headingDeg = 300;
    ap.update(fm, HOST_DT);
    fm.step(HOST_DT, 2);
    truth.push({ t, k: kinOf(fm) });
    if (t >= nextSnap) {
      nextSnap += SNAP_DT;
      if (!(net.loss && rng() < net.loss)) {
        let d = net.delay + (-Math.log(Math.max(rng(), 1e-9)) * net.jitter);
        if (rng() < net.stallP) d += net.stall; // retransmit stall
        // TCP delivers in order: a packet cannot overtake the one before it
        const arrive = Math.max(wall + d, lastArrive);
        lastArrive = arrive;
        inflight.push({ arrive, s: { t, k: kinOf(fm) } });
      }
    }
    while (inflight.length && inflight[0].arrive <= wall) {
      const m = inflight.shift()!;
      buf.push(m.s);
      clock.sample(m.s.t, m.arrive - clockOffset);
    }
    if (wall >= nextFrame) {
      nextFrame += FRAME_DT;
      const local = wall - clockOffset;
      const rt = clock.renderTime(local, FRAME_DT);
      const br = buf.bracket(rt);
      if (!br || t < 5) continue; // let the clock settle
      const k = sampleKin(br.a.k, br.b.k, br.f, br.dt);
      // truth at host time rt
      const fi = Math.max(0, rt / HOST_DT);
      const i0 = Math.min(truth.length - 2, Math.floor(fi));
      const ta = truth[i0], tb = truth[i0 + 1];
      const tk = sampleKin(ta.k, tb.k, Math.min(1, (rt - ta.t) / (tb.t - ta.t)), tb.t - ta.t);
      const p = new Vector3(...k.p);
      errs.push(p.distanceTo(new Vector3(...tk.p)));
      const qa = new Quaternion(...k.q), qb = new Quaternion(...tk.q);
      angErrs.push((qa.angleTo(qb) * 180) / Math.PI);
      delays.push((t - rt) / pace);
      rendered.push({ t: rt, p });
    }
  }
  // smoothness: deviation of rendered acceleration from the true path's (m/s^2), frame to frame
  for (let i = 2; i < rendered.length; i++) {
    const a = rendered[i - 2], b = rendered[i - 1], c = rendered[i];
    const dt1 = b.t - a.t, dt2 = c.t - b.t;
    if (dt1 <= 0 || dt2 <= 0) { jerks.push(Infinity); continue; }
    const acc = c.p.clone().sub(b.p).divideScalar(dt2).sub(b.p.clone().sub(a.p).divideScalar(dt1)).divideScalar((dt1 + dt2) / 2);
    jerks.push(acc.length());
  }
  const pct = (xs: number[], q: number) => { const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  const r = { name, p50: pct(errs, 0.5), p99: pct(errs, 0.99), max: Math.max(...errs), ang99: pct(angErrs, 0.99),
    acc99: pct(jerks, 0.99), delay: pct(delays, 0.5) };
  console.log(`     ${name}: position error p50 ${r.p50.toFixed(3)} m, p99 ${r.p99.toFixed(3)} m, max ${r.max.toFixed(2)} m; ` +
    `attitude p99 ${r.ang99.toFixed(3)} deg; rendered accel p99 ${r.acc99.toFixed(1)} m/s2; delay ${(r.delay * 1000).toFixed(0)} ms`);
  return r;
}

const lan = run("LAN (2 ms, jitter 1 ms)", { delay: 0.002, jitter: 0.001, stallP: 0, stall: 0 });
const net = run("internet (40 ms, jitter 8 ms, 1% stalls of 120 ms)", { delay: 0.04, jitter: 0.008, stallP: 0.01, stall: 0.12 });
const slow = run("host at half speed (40 ms, jitter 8 ms)", { delay: 0.04, jitter: 0.008, stallP: 0, stall: 0 }, 2, 0.5);
const bad = run("poor (80 ms, jitter 25 ms, 3% stalls of 250 ms)", { delay: 0.08, jitter: 0.025, stallP: 0.03, stall: 0.25 });

check(lan.p99 < 0.05, `LAN: rendered aircraft within 5 cm of the true path (p99 ${lan.p99.toFixed(3)} m)`);
check(net.p99 < 0.3, `internet: within 30 cm p99 (${net.p99.toFixed(3)} m) at ~105 m/s`);
check(net.ang99 < 0.2, `internet: attitude within 0.2 deg p99 (${net.ang99.toFixed(3)} deg)`);
check(net.acc99 < 20, `internet: smooth (rendered acceleration p99 ${net.acc99.toFixed(1)} m/s2)`);
check(slow.p99 < 0.3 && slow.acc99 < 20, `host running at half speed: tracked smoothly (p99 ${slow.p99.toFixed(3)} m, accel p99 ${slow.acc99.toFixed(1)} m/s2)`);
check(bad.max < 1, `poor link: worst error ${bad.max.toFixed(2)} m (250 ms stalls are dead-reckoned)`);
check(lan.delay < INTERP_DELAY + 0.03 && net.delay < INTERP_DELAY + 0.08, `render delay LAN ${(lan.delay * 1000).toFixed(0)} ms, internet ${(net.delay * 1000).toFixed(0)} ms`);

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
