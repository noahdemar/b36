// Headless checks for the crew controller against the exported nav data.
// Run: node --experimental-strip-types src/crew_test.ts
import { readFileSync } from "node:fs";
import { Vector3 } from "three";
import { Crew, type NavData } from "./crew.ts";

const nav = JSON.parse(readFileSync(new URL("../public/models/b36_nav.json", import.meta.url), "utf8")) as NavData;
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

function insideObstacle(c: Crew) {
  const r = nav.radius - 0.01;
  return nav.obstacles.find((o) =>
    o.max[1] > c.deck.y + 0.15 && o.min[1] < c.deck.y + c.eyeHeight &&
    c.pos.x > o.min[0] - r && c.pos.x < o.max[0] + r && c.pos.z > o.min[2] - r && c.pos.z < o.max[2] + r &&
    Math.hypot(c.pos.x - Math.max(o.min[0], Math.min(o.max[0], c.pos.x)), c.pos.z - Math.max(o.min[2], Math.min(o.max[2], c.pos.z))) < r);
}

/** Walk toward a target (x, z) for up to `seconds`, steering by yaw. Returns final distance. */
function walkTo(c: Crew, x: number, z: number, seconds = 20) {
  let worst: string | undefined;
  for (let t = 0; t < seconds; t += 1 / 60) {
    const dx = x - c.pos.x, dz = z - c.pos.z;
    if (Math.hypot(dx, dz) < 0.08) break;
    c.yaw = Math.atan2(-dx, -dz);
    c.update(1 / 60, { forward: 1, strafe: 0, run: false, crouch: false });
    const hit = insideObstacle(c);
    if (hit) worst = hit.name;
  }
  return { dist: Math.hypot(x - c.pos.x, z - c.pos.z), hit: worst };
}

const c = new Crew(nav);
c.sit("Seat_AC");
check(c.mode === "seated", "starts seated in the aircraft commander's seat");
c.standUp();
check(c.mode === "walking" && c.deck.id === "upper", "stands up onto the upper deck");

const ladder = nav.ladders[0];
const top = ladder.path[ladder.path.length - 1];
let r = walkTo(c, top[0], top[2]);
check(r.dist < 0.3 && !r.hit, `walks to the ladder top (dist ${r.dist.toFixed(2)} m${r.hit ? ", inside " + r.hit : ""})`);
const near = c.nearestInteraction();
check(near?.kind === "ladder", "ladder is the nearest interaction at its top");
if (near?.kind === "ladder") c.useLadder(near.ladder);
for (let t = 0; t < 15 && c.mode === "climbing"; t += 1 / 60) c.update(1 / 60, { forward: 0, strafe: 0, run: false, crouch: false });
check(c.mode === "walking" && c.deck.id === "lower", `climbs down to the lower deck (y ${c.pos.y.toFixed(2)})`);

const radar = nav.seats.find((s) => s.name === "Seat_RADAR")!;
r = walkTo(c, radar.stand[0], radar.stand[2]);
check(r.dist < 0.3 && !r.hit, `walks to the radar observer's seat (dist ${r.dist.toFixed(2)} m${r.hit ? ", inside " + r.hit : ""})`);
check(c.eyeHeight > 1.5, `stands upright on the lower deck (eye ${c.eyeHeight.toFixed(2)} m)`);

// Walls: from open floor aft (d ~ 10), walk hard left and check the hull stops us
walkTo(c, 0.3, -20.0);
walkTo(c, 0.3, -15.0);
walkTo(c, -5, -15.0, 5);
check(c.pos.x > -1.35 && c.pos.x < -1.0, `stopped by the hull wall (x ${c.pos.x.toFixed(2)})`);
walkTo(c, 0.3, -15.0);
walkTo(c, 0.3, -20.0);
// Obstacle: walk into the radar console from behind
walkTo(c, 0, -20.9, 5);
r = { dist: 0, hit: insideObstacle(c)?.name };
check(!r.hit, `blocked by the radar console (z ${c.pos.z.toFixed(2)})`);

// Back up the ladder
const bottom = ladder.path[0];
walkTo(c, 0.3, -19.0);
walkTo(c, 0.3, bottom[2]);
r = walkTo(c, bottom[0], bottom[2]);
check(r.dist < 0.3, `walks to the ladder foot (dist ${r.dist.toFixed(2)} m)`);
const n2 = c.nearestInteraction();
if (n2?.kind === "ladder") c.useLadder(n2.ladder);
for (let t = 0; t < 15 && c.mode === "climbing"; t += 1 / 60) c.update(1 / 60, { forward: 0, strafe: 0, run: false, crouch: false });
check(c.deck.id === "upper", "climbs back up to the flight deck");

// Upper deck headroom aft of the canopy is low: eye should drop below standing height
walkTo(c, 0.4, -14.0);
check(c.eyeHeight < nav.eyeStand - 0.05, `stoops under the low cabin roof (eye ${c.eyeHeight.toFixed(2)} m above deck)`);

const fe = nav.seats.find((s) => s.name === "Seat_FE")!;
// route forward: right of the ladder opening, then left around the engineer's panel
for (const [x, z] of [[0.3, -16.6], [0.3, -17.13], [-0.55, -17.13], [-0.55, -18.5]]) walkTo(c, x, z);
r = walkTo(c, fe.stand[0], fe.stand[2]);
check(r.dist < 0.3, `reaches the flight engineer's seat (dist ${r.dist.toFixed(2)} m)`);
const n3 = c.nearestInteraction();
check(n3?.kind === "seat" && n3.seat.name === "Seat_FE", "flight engineer's seat is the nearest interaction");

// To the tunnel: aft along the right of the ladder opening, then across to the hatch
c.standUp();
for (const [x, z] of [[-0.55, -18.5], [-0.55, -17.13], [0.3, -17.13], [0.3, -16.6], [0.15, -12.8]]) walkTo(c, x, z);
const tun = nav.tunnels[0];
r = walkTo(c, tun.ends[0].stand[0], tun.ends[0].stand[2]);
check(r.dist < 0.3 && !r.hit, `reaches the tunnel hatch (dist ${r.dist.toFixed(2)} m${r.hit ? ", inside " + r.hit : ""})`);
const nt = c.nearestInteraction();
check(nt?.kind === "tunnel", "tunnel is the nearest interaction at the hatch");
if (nt?.kind === "tunnel") c.useTunnel(nt.tunnel, nt.end);
let tunnelTime = 0;
for (; tunnelTime < 60 && c.mode === "tunnel"; tunnelTime += 1 / 60) c.update(1 / 60, { forward: 1, strafe: 0, run: false, crouch: false });
check(c.mode === "walking" && c.deck.id === "aft", `crawls the tunnel to the aft compartment in ${tunnelTime.toFixed(0)} s`);
const ua = nav.seats.find((s) => s.name === "Seat_GUA_L")!;
r = walkTo(c, ua.stand[0], ua.stand[2]);
check(r.dist < 0.3 && !r.hit, `walks to the upper aft gunner's seat (dist ${r.dist.toFixed(2)} m${r.hit ? ", inside " + r.hit : ""})`);
const ns = c.nearestInteraction();
check(ns?.kind === "seat" && ns.seat.name === "Seat_GUA_L", "upper aft gunner's seat is the nearest interaction");
check(!!ua.sight && ua.sight.turrets.length === 2, "the station controls the two upper aft turrets");
const tail = nav.seats.find((s) => s.name === "Seat_TAIL")!;
r = walkTo(c, tail.stand[0], tail.stand[2]);
check(r.dist < 0.3 && !r.hit, `walks to the tail gunner's station (dist ${r.dist.toFixed(2)} m${r.hit ? ", inside " + r.hit : ""})`);
// Player-style route, keyboard only: W held, view turned with a limited mouse rate and some aim
// noise, waypoints only roughly reached (30 cm), then E at the hatch and W through the tunnel.
{
  const h = new Crew(nav);
  h.sit("Seat_AC");
  h.standUp();
  let seed = 3;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const sloppy = (x: number, z: number, tol = 0.3) => {
    for (let t = 0; t < 20; t += 1 / 60) {
      const dx = x - h.pos.x, dz = z - h.pos.z;
      if (Math.hypot(dx, dz) < tol) return true;
      const want = Math.atan2(-dx, -dz) + (rnd() - 0.5) * 0.25;
      const err = Math.atan2(Math.sin(want - h.yaw), Math.cos(want - h.yaw));
      h.yaw += Math.max(-3 / 60, Math.min(3 / 60, err));
      h.update(1 / 60, { forward: Math.abs(err) < 1.2 ? 1 : 0, strafe: 0, run: false, crouch: false });
    }
    return false;
  };
  const route: [number, number][] = [[0, -19.0], [-0.05, -17.6], [-0.05, -16.0], [0.5, -15.4], [0.5, -14.3], [0, -13.6], [0, -12.9], [-0.55, -12.62]];
  const stuck = route.find(([x, z]) => !sloppy(x, z));
  check(!stuck, `player-style walk from the AC seat to the hatch${stuck ? ": stuck before " + stuck.join(", ") + " at " + h.pos.x.toFixed(2) + ", " + h.pos.z.toFixed(2) : ""}`);
  const it = h.nearestInteraction();
  check(it?.kind === "tunnel", `E at the hatch enters the tunnel (nearest: ${it?.kind ?? "none"})`);
  if (it?.kind === "tunnel") h.useTunnel(it.tunnel, it.end);
  for (let t = 0; t < 60 && h.mode === "tunnel"; t += 1 / 60) h.update(1 / 60, { forward: 1, strafe: 0, run: false, crouch: false });
  check(h.mode === "walking" && h.deck.id === "aft", "W through the tunnel to the aft compartment");
}

// Click-to-walk: every seat is reachable from the AC seat on foot (ladder and tunnel included)
{
  const bad: string[] = [];
  for (const st of nav.seats) {
    const a = new Crew(nav);
    a.sit("Seat_AC");
    if (st.name === "Seat_AC") continue;
    const ok = a.goTo({ kind: "seat", seat: st });
    let t = 0;
    for (; t < 120 && a.mode !== "seated"; t += 1 / 60) {
      a.update(1 / 60, { forward: 0, strafe: 0, run: false, crouch: false });
      if (a.mode === "walking" && insideObstacle(a)) { bad.push(`${st.name} (through ${insideObstacle(a)!.name})`); break; }
    }
    if (!ok || a.seat?.name !== st.name) bad.push(`${st.name} (${a.mode} on ${a.deck.id} at ${a.pos.x.toFixed(2)}, ${a.pos.z.toFixed(2)})`);
  }
  check(bad.length === 0, `auto-walk reaches all ${nav.seats.length - 1} other seats${bad.length ? ": " + bad.join("; ") : ""}`);
  const back = new Crew(nav);
  back.sit("Seat_TAIL");
  back.goTo({ kind: "seat", seat: nav.seats.find((s) => s.name === "Seat_RADAR")! });
  for (let t = 0; t < 150 && back.mode !== "seated"; t += 1 / 60) back.update(1 / 60, { forward: 0, strafe: 0, run: false, crouch: false });
  check(back.seat?.name === "Seat_RADAR", "auto-walk from the tail gunner to the radar observer (tunnel and ladder)");
}

// Camera never leaves the airframe: seat eyes are inside the inner skin; random walks keep the eye inside
{
  const v = new Vector3();
  const bad: string[] = [];
  const cc = new Crew(nav);
  for (const st of nav.seats) {
    v.set(st.eye[0], st.eye[1], st.eye[2]);
    const before = v.clone();
    cc.clampToHull(v, 0.05);
    if (before.distanceTo(v) > 1e-6) bad.push(`${st.name} (${before.distanceTo(v).toFixed(2)} m out)`);
  }
  check(bad.length === 0, `all seat eye points inside the hull${bad.length ? ": " + bad.join(", ") : ""}`);
  let worst = 0;
  for (const seat of ["Seat_AC", "Seat_FE", "Seat_RADAR", "Seat_TAIL"]) {
    const w = new Crew(nav);
    w.sit(seat);
    w.standUp();
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let t = 0; t < 120; t += 1 / 30) {
      if (Math.floor(t * 30) % 45 === 0) w.yaw = rnd() * Math.PI * 2;
      w.update(1 / 30, { forward: 1, strafe: rnd() - 0.5, run: rnd() > 0.7, crouch: rnd() > 0.9 });
      w.eye(v);
      const p = v.clone();
      w.clampToHull(p, 0.13);
      worst = Math.max(worst, p.distanceTo(v));
    }
  }
  check(worst < 1e-6, `random walks: eye always at least 13 cm inside the skin (worst ${worst.toFixed(3)} m)`);
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
