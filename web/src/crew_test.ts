// Headless checks for the crew controller against the exported nav data.
// Run: node --experimental-strip-types src/crew_test.ts
import { readFileSync } from "node:fs";
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
check(c.pos.x > -1.3 && c.pos.x < -1.0, `stopped by the hull wall (x ${c.pos.x.toFixed(2)})`);
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

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
