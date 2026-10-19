import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Aircraft, defaultAircraftState, loadGltf } from "./aircraft";
import { Cockpit, type Pickable } from "./cockpit";
import { Crew, type Interaction, type NavData } from "./crew";
import { DamageFX } from "./damagefx";
import { Flak } from "./flak";
import { Engineer, engineWarnings } from "./engineer";
import { type InputState, KEY_HELP, KeyboardInput, RemoteInput } from "./input";
import { CrewAvatars } from "./avatars";
import { type NetMsg, NetSession } from "./net/session";
import { SnapshotBuffer } from "./net/interp";
import { applyFast, applySlow, buildFast, buildSlow, type Ev, type FastSnap, type GameRefs, interpPoses, type Pose, type SlowSnap } from "./net/replicate";
import { SightComputer } from "./weapons/sightcomputer";
import { BombingRange, RANGE_CENTER } from "./range";
import { Autopilot } from "./sim/autopilot";
import { bearingTo, mountDisplays, NavChart, RadarScope, WAYPOINTS } from "./stations";
import { FlightModel } from "./sim/flightmodel";
import { BombSystem } from "./weapons/bombs";
import { findTurrets, Rounds, type Turret } from "./weapons/turrets";
import { clockCall, Fighters } from "./weapons/fighters";
import { DefensiveFire, type PlayerAim } from "./weapons/gunnery";
import { GunSight } from "./gunsight";
import { Sound } from "./audio";
import { ChaseCam } from "./chasecam";
import { Instructor } from "./sim/instructor";
import { TIMES, World } from "./world";
import { terrainHeight } from "./terrain";
import { atmosphere } from "./sim/atmosphere";

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.shadowMap.enabled = true;
renderer.localClippingEnabled = true; // separated structure is cut with clipping planes
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.03, 260_000);
const world = new World(scene, renderer);

const hud = document.getElementById("hud")!;
hud.style.zIndex = "3";
const help = document.getElementById("help")!;
const label = document.getElementById("label")!;
const yokeDot = document.getElementById("yoke")!;
const sightEl = document.getElementById("sight")!;
const impactEl = document.getElementById("impact")!;
help.innerHTML = "<b>B-36 flight deck</b><table>" + KEY_HELP.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("") + "</table>";

const fm = new FlightModel();
const MASS0 = fm.mass;
const ap = new Autopilot();
const engineer = new Engineer();
const flak = new Flak();
let fx: DamageFX | null = null;
let lastEvent: unknown = null;
/** Turrets are damage components too (found on the model at load). */
function addTurretComponents() {
  aircraftRoot.updateMatrixWorld(true);
  for (const t of turrets.values()) {
    const p = aircraftRoot.worldToLocal(t.yawNode.getWorldPosition(new THREE.Vector3()));
    fm.damage.addComponent({ id: t.name, label: t.name.replace("Turret_", "").replace(/_/g, " ") + " turret", kind: "turret", pos: p, area: 1.6, hpMax: 12 });
  }
}
const chart = new NavChart();
const scope = new RadarScope();
let bigDisplay: "chart" | "scope" | null = null;
let impactT = 0;
for (const cv of [chart.canvas, scope.canvas]) {
  cv.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);display:none;z-index:5;" +
    "border:2px solid #333;box-shadow:0 0 30px #000;";
  document.body.appendChild(cv);
}
chart.canvas.style.width = "min(96vw, 1600px)";
scope.canvas.style.width = "min(80vh, 90vw)";
scope.canvas.style.borderRadius = "50%";
chart.canvas.addEventListener("pointerdown", (e) => {
  const r = chart.canvas.getBoundingClientRect();
  const wp = chart.pick(((e.clientX - r.left) / r.width) * chart.canvas.width, ((e.clientY - r.top) / r.height) * chart.canvas.height);
  if (wp) ctl({ k: "wp", name: wp.name, x: wp.x, z: wp.z });
});
let bombs: BombSystem | null = null;
let range: BombingRange | null = null;
let sightView = false;
let turrets = new Map<string, Turret>();
let rounds: Rounds | null = null;
let fighters: Fighters | null = null;
let defense: DefensiveFire | null = null;
const gunsight = new GunSight();
const chase = new ChaseCam();
const instructor = new Instructor();
let mouseAim = true; // third-person pilot: instructor flies toward the mouse aim
const GUN_CHASE = { dist: 62, lift: 0.22, fov: 60 };
const sound = new Sound();
/** Fighter scenario: waves left to send and the countdown to the next one. */
const raid = { waves: 0, next: -1, quiet: 0 };
let calloutT = 0;
let frameDt = 1 / 60;
const prevRoot = new THREE.Vector3();
let trolley: THREE.Object3D | null = null;
const headlamp = new THREE.PointLight(0xfff0d0, 0.9, 4, 1.5);
let lastSeat: unknown = null;
let crewMsg = "";
let crewMsgT = 0;
/** Crew message (interphone): shown here and, when hosting, to the whole crew. */
function say(msg: string) {
  crewMsg = msg;
  crewMsgT = 4;
  rec(["say", msg]);
}
const debugHook = { fm } as Record<string, unknown>;
(window as unknown as { b36: unknown }).b36 = debugHook; // debug/test hook
const input = new KeyboardInput();
const aircraftRoot = new THREE.Group();
scene.add(aircraftRoot);

type View = "inside" | "outside" | "chase";
let view: View = "inside";
const head = { fov: 62 };
let crew: Crew | null = null;
debugHook.camera = camera;
debugHook.scene = scene;
const eyeLocal = new THREE.Vector3();
const FUNCTIONAL = new Set(["radar_observer", "flight_engineer", "navigator"]);
const isGunner = (station: string) => station.startsWith("gunner") || station === "tail_gunner";
const STATION_NAMES: Record<string, string> = {
  aircraft_commander: "Aircraft commander", pilot: "Pilot", flight_engineer: "Flight engineer",
  radio_operator: "Radio operator", radar_observer: "Radar observer", navigator: "Navigator",
  gunner_upper_fwd_L: "Upper forward gunner (left)", gunner_upper_fwd_R: "Upper forward gunner (right)",
  gunner_upper_aft_L: "Upper aft gunner (left)", gunner_upper_aft_R: "Upper aft gunner (right)",
  gunner_lower_aft_L: "Lower aft gunner (left)", gunner_lower_aft_R: "Lower aft gunner (right)",
  tail_gunner: "Tail gunner",
};
let orbit: OrbitControls | null = null;
let showHud = true;
let extFrames: THREE.Object3D | null = null;

function resetOnRunway(cold = false) {
  ap.disengage();
  bombs?.reload();
  fm.setMass(MASS0);
  fm.resetSystems(!cold);
  fx?.reset();
  addTurretComponents();
  fm.feAuto = fm.fuel.auto = !feManned;
  epoch++;
  fm.placeOnGround(new THREE.Vector3(0, 0, 0), 0);
  clearFighters();
  const c = fm.controls;
  c.throttle.fill(0);
  c.jetThrottle.fill(0);
  c.flaps = 0;
  fm.flapPos = 0;
  c.trim = 0.3;
  c.parkingBrake = true;
}

function setView(v: View) {
  view = v;
  if (v === "outside") {
    camera.near = 0.5;
    orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    debugHook.orbit = orbit;
    orbit.target.copy(aircraftRoot.position);
    camera.position.copy(aircraftRoot.position).add(new THREE.Vector3(-55, 18, 45));
    camera.fov = 45;
  } else if (v === "chase") {
    orbit?.dispose();
    orbit = null;
    camera.near = 0.5;
    camera.fov = 55;
    chase.resetTo(fm.quat);
    instructor.reset(fm);
  } else {
    orbit?.dispose();
    orbit = null;
    camera.near = 0.03;
    camera.fov = head.fov;
  }
  if (v !== "chase") chase.hide();
  camera.updateProjectionMatrix();
}

/** Inside the aircraft, in the cockpit view or third person from a station. */
const aboard = () => view === "inside" || view === "chase";

function clearFighters() {
  fighters?.clear();
  rounds?.clear();
  raid.waves = 0;
  raid.next = -1;
  for (const t of turrets.values()) { t.rearm(); if (t.retract > 0) t.extendCmd = false; }
  gunsight.kills = 0;
}

/** Fighter attack: airborne at 25,000 ft on autopilot, three waves of MiG-15s; man a gun station (Tab). */
function startFighterAttack() {
  epoch++;
  bombs?.reload();
  fm.setMass(MASS0);
  fm.resetSystems(true);
  fx?.reset();
  addTurretComponents();
  clearFighters();
  fm.placeInFlight(32_000 * 0.3048, 105, 0); // high enough for contrails
  fm.controls.throttle.fill(0.85);
  fm.controls.jetThrottle.fill(0);
  fm.controls.flaps = 0;
  fm.flapPos = 0;
  fm.controls.gearDown = false;
  fm.gearPos = 0;
  ap.engage(fm);
  raid.waves = 3;
  raid.next = 4;
  say("FIGHTER ATTACK: MiG-15s inbound, 32,000 ft. Tab: walk to a gun station (gunners in the blisters and the tail).");
}

/** Airborne on the bombing run: 15 km south of the range, 12,000 ft, heading north, autopilot on. */
function startBombRun() {
  epoch++;
  bombs?.reload();
  fm.setMass(MASS0);
  fm.resetSystems(true);
  fx?.reset();
  addTurretComponents();
  fm.placeInFlight(12_000 * 0.3048, 105, 0);
  fm.pos.set(RANGE_CENTER.x + 40, fm.pos.y, RANGE_CENTER.z + 15_000);
  fm.controls.throttle.fill(0.7);
  fm.controls.jetThrottle.fill(0);
  fm.controls.flaps = 0;
  fm.flapPos = 0;
  ap.engage(fm);
  clearFighters();
  raid.waves = 1;
  raid.next = 25; // interceptors arrive on the run in
  say("BOMB RUN: autopilot on, 15 km to the target. Go to the radar observer's seat on the lower deck. Expect fighters.");
}

function atStation(station: string, p: Player | null = me) {
  return !!p && p.aboard && p.crew.mode === "seated" && p.crew.seat?.station === station;
}

/** The gun sight in use, if the crew member is at a gunnery station. */
function gunSight(p: Player | null = me) {
  if (!p || !p.aboard || p.crew.mode !== "seated" || !p.crew.seat?.sight) return null;
  if (p.crew.seat.station === "radar_observer" && !p.noseGuns) return null;
  return p.crew.seat.sight;
}

/** Flight inputs reach the sim only from a pilot seat. */
function flying(p: Player | null = me) {
  return !!p && p.aboard && p.crew.mode === "seated" && !!p.crew.seat?.flies;
}

// ---------------------------------------------------------------- crew members (players)

/** One crew member: this machine's player, or (on the host) a remote one fed by their packets. */
interface Player {
  id: number;
  name: string;
  local: boolean;
  crew: Crew;
  input: InputState;
  sight: SightComputer;
  engineer: Engineer;
  noseGuns: boolean;
  firing: boolean;
  aboard: boolean;
  chase: boolean;
  mouseAim: boolean;
  chaseAim: THREE.Vector3 | null;
  lastFlight: number;
  lastPressed: string[];
  speed: number;
  pose: Pose | null;
}

function makePlayer(id: number, name: string, local: boolean, cr: Crew, inp: InputState, sight: SightComputer, eng: Engineer): Player {
  return { id, name, local, crew: cr, input: inp, sight, engineer: eng, noseGuns: false, firing: false, aboard: true, chase: false,
    mouseAim: true, chaseAim: null, lastFlight: 0, lastPressed: [], speed: 0, pose: null };
}

let me = null as unknown as Player;
const remotes = new Map<number, Player>();
let avatars: CrewAvatars | null = null;
let net: NetSession | null = null;
const isClient = () => !!net && net.connected && !net.isHost;
const isHost = () => !!net && net.connected && net.isHost;
/** Round tag of this machine's gunner (kill credit). */
const myTag = () => (isClient() ? 100 + me.id : 0);
let epoch = 0;
const evq: Ev[] = [];
const rec = (e: Ev) => { if (isHost()) evq.push(e); };
let fastT = 0, slowT = 0, sendT = 0;
/** Host simulation clock (s): snapshots are stamped with it, so the crew follow the simulation's own
 * pace even when the host's frame rate drops and the simulation runs slower than real time. */
let simClock = 0;
const fastBuf = new SnapshotBuffer<FastSnap>();
let lastSlow: SlowSnap | null = null;
let replayedT = -Infinity;
let posesNow: Pose[] = [];
const pendingPressed: string[] = [];
const pendingCmds: Cmd[] = [];
const localOverride = new Map<string, { until: number; apply: () => void }>();
let mySeatT = 0;
let myShotT = -1;
let feManned = false;
let hostSeats: Record<string, number> = {};
const FLIGHT_KEYS = ["KeyW", "KeyS", "KeyA", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyQ", "KeyE",
  "PageUp", "PageDown", "Home", "End", "Equal", "Minus", "KeyB"];

type Cmd =
  | { k: "throttle" | "jet"; i: number; all: boolean; v: number }
  | { k: "trim" | "tiller" | "flaps"; v: number }
  | { k: "gear" | "brake"; v: boolean }
  | { k: "wp"; name: string; x: number; z: number }
  | { k: "apoff" };

const refs = (): GameRefs => ({ fm, ap, turrets, fighters, bombs, range });
const nowS = () => performance.now() / 1000;
const allPlayers = () => [me, ...remotes.values()];
const playerName = (id: number) => (id === me.id ? me.name : remotes.get(id)?.name ?? net?.roster.find((r) => r.id === id)?.name ?? `Crew ${id}`);

/** Pose of a crew member in the model frame. */
function poseOf(p: Player): Pose {
  const e = new THREE.Vector3();
  const ang = p.crew.eye(e);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return {
    id: p.id, name: p.name, mode: p.crew.mode, seat: p.crew.mode === "seated" ? p.crew.seat?.name ?? "" : "", deck: p.crew.deck.id,
    feet: [r(p.crew.pos.x), r(p.crew.pos.y), r(p.crew.pos.z)], eye: [r(e.x), r(e.y), r(e.z)], yaw: r(ang.yaw), pitch: r(ang.pitch),
    speed: r(p.speed), crouch: p.crew.eyeHeight < p.crew.nav.eyeStand - 0.15,
  };
}

/** Everyone's pose for avatars (and, on the host, for the snapshot). */
function crewPoses(): Pose[] {
  if (isClient()) return posesNow;
  if (!isHost()) return [];
  return [poseOf(me), ...[...remotes.values()].filter((p) => p.pose).map((p) => p.pose!)];
}

/** A remote crew member's pose drives their Crew on the host (seat, look direction for the gun sight). */
function applyPose(p: Player, pose: Pose) {
  p.pose = { ...pose, id: p.id, name: p.name };
  const cr = p.crew;
  cr.mode = pose.mode as Crew["mode"];
  cr.seat = pose.mode === "seated" ? cr.nav.seats.find((s) => s.name === pose.seat) ?? null : null;
  if (pose.mode === "seated" && !cr.seat) cr.mode = "walking";
  cr.deck = cr.nav.decks.find((d) => d.id === pose.deck) ?? cr.deck;
  cr.pos.set(...pose.feet);
  cr.yaw = pose.yaw - (cr.seat ? cr.seat.yaw : 0);
  cr.pitch = pose.pitch;
}

/** Seat held by another crew member (seat name -> player id). */
function seatOwner(name: string): number | null {
  if (isClient()) {
    const id = lastSlow?.seats[name];
    return id !== undefined && id !== me.id ? id : null;
  }
  for (const p of remotes.values()) if (p.crew.mode === "seated" && p.crew.seat?.name === name) return p.id;
  return null;
}

function trySit(cr: Crew, name: string) {
  const owner = seatOwner(name);
  if (owner !== null) { localSay(`That station is taken (${playerName(owner)})`); return false; }
  cr.sit(name);
  mySeatT = nowS();
  return true;
}

/** Host: who holds each seat (first come keeps it). */
function updateHostSeats() {
  const next: Record<string, number> = {};
  for (const p of allPlayers()) {
    if (p.crew.mode !== "seated" || !p.crew.seat) continue;
    const n = p.crew.seat.name;
    if (next[n] === undefined || hostSeats[n] === p.id) next[n] = p.id;
  }
  hostSeats = next;
}

/** Toggles that are the crew member's own state and also matter on their own screen. */
function playerToggles(p: Player, pressed: Set<string>) {
  if (atStation("radar_observer", p) && pressed.has("KeyT")) {
    p.noseGuns = !p.noseGuns;
    if (p.local) { sightView = false; p.crew.yaw = 0; p.crew.pitch = -0.1; }
  }
  const gs = gunSight(p);
  if (gs && pressed.has("KeyG") && !gs.aft) {
    p.sight.assist = !p.sight.assist;
    if (p.local) localSay(p.sight.assist ? "RANGE ASSIST ON (game aid: the ring frames the nearest fighter)" : "MANUAL RANGING");
  }
}

/** This machine's views, walking interactions and displays (never sent anywhere). */
function localUI(p: Player, pressedList: string[], dt: number) {
  const pressed = new Set(pressedList);
  const cr = p.crew;
  if (isClient()) pendingPressed.push(...pressedList);
  if (pressed.has("KeyC")) {
    // from a pilot or gun station C toggles third person; elsewhere the free outside camera
    const thirdOk = cr.mode === "seated" && (!!cr.seat?.flies || !!gunSight());
    setView(view !== "inside" ? "inside" : thirdOk ? "chase" : "outside");
    if (view === "chase") localSay(cr.seat?.flies ? "THIRD PERSON: the mouse aims, the aircraft follows (click to capture the mouse; W/S/A/D override; M mouse aim on/off; C cockpit)"
      : "THIRD PERSON GUNNER: the mouse aims, hold left button or Space to fire, wheel sets range; C back to the sight");
  }
  if (view === "chase" && (cr.mode !== "seated" || (!cr.seat?.flies && !gunSight()))) setView("inside");
  if (aboard() && pressed.has("KeyX") && cr.mode === "seated") { cr.standUp(); if (view === "chase") setView("inside"); }
  if (view === "inside" && pressed.has("KeyE") && cr.mode === "walking") {
    const it = cr.nearestInteraction();
    if (it?.kind === "seat") trySit(cr, it.seat.name);
    else if (it?.kind === "ladder") cr.useLadder(it.ladder);
    else if (it?.kind === "tunnel") cr.useTunnel(it.tunnel, it.end);
  }
  // walked into a station that someone else holds (click-to-walk or the station list)
  if (cr.mode === "seated" && cr.seat && cr.seat !== lastSeat) {
    const owner = seatOwner(cr.seat.name);
    if (owner !== null) { cr.standUp(); localSay(`That station is taken (${playerName(owner)})`); }
    else mySeatT = nowS();
  }
  // the host settled a simultaneous claim against us
  if (isClient() && cr.mode === "seated" && cr.seat && nowS() - mySeatT > 1.5) {
    const owner = seatOwner(cr.seat.name);
    if (owner !== null) { cr.standUp(); localSay(`${playerName(owner)} has that station`); }
  }
  if (pressed.has("Tab") && aboard()) toggleStations();
  // just sat down (E, click or walked there): look where the station works
  if (cr.mode === "seated" && cr.seat && cr.seat !== lastSeat) {
    const st = cr.seat.station;
    cr.yaw = 0;
    if (cr.seat.sight && st !== "radar_observer") {
      cr.pitch = st.includes("lower") ? -0.35 : 0.1;
      head.fov = 45; // reflector sight: narrower view (Shift+wheel zooms)
    }
    if (st === "navigator") cr.pitch = -0.75;
    if (st === "radar_observer") cr.pitch = -0.45;
  }
  if (lastSeat && (lastSeat as { sight?: unknown }).sight && (cr.mode !== "seated" || cr.seat !== lastSeat)) head.fov = 62;
  lastSeat = cr.mode === "seated" ? cr.seat : null;
  if (cr.mode !== "seated") { p.noseGuns = false; p.firing = false; if (document.pointerLockElement) document.exitPointerLock(); }
  playerToggles(p, pressed);
  if (isClient() && atStation("flight_engineer")) p.engineer.select(pressedList);
  if (pressed.has("KeyH")) {
    showHud = !showHud;
    help.style.display = showHud ? "block" : "none";
  }
  const station = cr.mode === "seated" && aboard() ? cr.seat?.station ?? "" : "";
  if (station === "navigator" && pressed.has("KeyV")) bigDisplay = bigDisplay === "chart" ? null : "chart";
  if (station === "radar_observer" && !p.noseGuns && pressed.has("KeyB")) bigDisplay = bigDisplay === "scope" ? null : "scope";
  if ((bigDisplay === "chart" && station !== "navigator") || (bigDisplay === "scope" && (station !== "radar_observer" || p.noseGuns))) bigDisplay = null;
  if (station === "radar_observer" && !p.noseGuns && bombs) { if (pressed.has("KeyV")) sightView = !sightView; } else sightView = false;
  if (flying() && view === "chase" && pressed.has("KeyM")) {
    mouseAim = !mouseAim;
    if (!isClient()) instructor.reset(fm);
    localSay(mouseAim ? "MOUSE AIM ON" : "MOUSE AIM OFF: direct controls");
  }
  p.mouseAim = mouseAim;
  // crew machines never run the flight input code, so the mouse yoke is toggled here (and sent as state)
  if (isClient()) {
    if (flying() && pressed.has("KeyY")) input.mouseYoke = !input.mouseYoke;
    if (!flying()) input.mouseYoke = false;
  }
  void dt;
}

/** Host: one crew member's station controls (the host's own, or a remote player's packets). */
function stationFrame(p: Player, pressedList: string[], dt: number) {
  p.lastPressed = pressedList;
  const pressed = new Set(pressedList);
  const inp = p.input;
  if (!p.local) playerToggles(p, pressed);
  const gs = gunSight(p);
  if (gs && pressed.has("KeyU")) {
    const ts = gs.turrets.map((n) => turrets.get(n)!).filter(Boolean);
    const out = !ts.every((t) => t.extendCmd);
    for (const t of ts) t.extendCmd = out;
    say(ts.some((t) => t.retract > 0) ? (out ? "TURRETS EXTENDING" : "TURRETS RETRACTING") : "THIS TURRET IS FIXED (ALWAYS READY)");
  }
  // scenario changes belong to the host
  const scenario = ["KeyR", "KeyR+S", "KeyN", "KeyL", "KeyT+S"].filter((k) => pressed.has(k));
  if (scenario.length && !p.local) tell(p, "Only the host can reset or start a scenario");
  else {
    if (pressed.has("KeyR")) resetOnRunway();
    if (pressed.has("KeyR+S")) { resetOnRunway(true); say("COLD AND DARK: engines off. Start them from the flight engineer's seat (behind the right pilot)."); }
    if (pressed.has("KeyN")) startBombRun();
    if (pressed.has("KeyL")) startFighterAttack();
    if (pressed.has("KeyT+S")) {
      const i = (TIMES.indexOf(world.hours) + 1) % TIMES.length;
      world.setTime(TIMES[i]);
      const h = Math.floor(TIMES[i]), m = Math.round((TIMES[i] - h) * 60);
      say(`TIME OF DAY ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  if (atStation("flight_engineer", p)) {
    const m = p.engineer.update(fm, inp, pressedList, dt);
    if (m) say(m);
  }
  // navigator: waypoints, chart scale, autopilot coupling
  if (atStation("navigator", p)) {
    for (const [k, i] of [["Digit1", 0], ["Digit2", 1], ["Digit3", 2]] as const) {
      if (pressed.has(k)) { chart.waypoint = WAYPOINTS[i]; say(`NAVIGATOR: course to ${chart.waypoint.name}`); }
    }
    if (pressed.has("PageUp")) chart.zoom(-1);
    if (pressed.has("PageDown")) chart.zoom(1);
    if (pressed.has("Enter")) {
      chart.coupled = !chart.coupled;
      if (chart.coupled && !ap.engaged) ap.engage(fm);
      say(chart.coupled ? `AUTOPILOT COUPLED: steering to ${chart.waypoint.name}` : "AUTOPILOT UNCOUPLED from the navigator");
    }
  }
  // radar observer: scope range and gain
  if (atStation("radar_observer", p) && !p.noseGuns) {
    if (pressed.has("PageUp")) scope.setRange(1);
    if (pressed.has("PageDown")) scope.setRange(-1);
    if (inp.isDown("BracketRight")) scope.gain = Math.min(1, scope.gain + 0.4 * dt);
    if (inp.isDown("BracketLeft")) scope.gain = Math.max(0, scope.gain - 0.4 * dt);
  }
  // autopilot: Z from the pilot seats or the bombardier; yoke input disengages it
  if (pressed.has("KeyZ") && (flying(p) || atStation("radar_observer", p))) {
    if (ap.engaged) ap.disengage();
    else ap.engage(fm);
    say(ap.engaged ? `AUTOPILOT ON: ${ap.altitudeFt.toFixed(0)} ft, heading ${ap.headingDeg.toFixed(0)}` : "AUTOPILOT OFF");
  }
  if (ap.engaged && flying(p) && ["KeyW", "KeyS", "KeyA", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].some((k) => pressed.has(k))) {
    ap.disengage();
    say("AUTOPILOT OFF (yoke input)");
  }
  // bombardier / bomb controls (doors also from the pilot seats)
  const bombardier = atStation("radar_observer", p);
  if (pressed.has("KeyO") && (bombardier || flying(p))) {
    fm.controls.bombDoors = fm.controls.bombDoors > 0.5 ? 0 : 1;
    say(fm.controls.bombDoors ? "BOMB DOORS OPENING" : "BOMB DOORS CLOSING");
  }
  if (bombardier && bombs && !p.noseGuns) {
    if (pressed.has("KeyK")) { bombs.armed = !bombs.armed; say(bombs.armed ? "BOMBS ARMED" : "BOMBS SAFE"); }
    if (pressed.has("KeyM")) {
      bombs.mode = bombs.mode === "single" ? "train" : bombs.mode === "train" ? "salvo" : "single";
      say(`RELEASE MODE: ${bombs.mode.toUpperCase()}`);
    }
    if (pressed.has("Space")) {
      aircraftRoot.updateMatrixWorld(true);
      say(bombs.release(fm, aircraftRoot.matrixWorld));
    }
    if (ap.engaged) {
      const k = (inp.isDown("KeyD") ? 1 : 0) - (inp.isDown("KeyA") ? 1 : 0);
      if (k) ap.turn(k * 2 * dt); // 2 deg/s course correction through the autopilot
    }
  }
  if (flying(p) && (FLIGHT_KEYS.some((k) => inp.isDown(k)) || pressedList.some((k) => /^Key[GFPY]/.test(k)) || inp.mouseYoke)) p.lastFlight = nowS();
}

/** The pilot in command's controls (keyboard, mouse yoke, third-person mouse aim). */
function flightInput(p: Player, pressedList: string[], dt: number) {
  p.input.apply(fm.controls, dt, pressedList);
  if (!p.chase) return;
  const keys = ["KeyW", "KeyS", "KeyA", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].some((k) => p.input.isDown(k));
  const aim = p.local ? chase.aimDir() : p.chaseAim;
  if (p.mouseAim && !ap.engaged && !keys && aim) instructor.update(fm, dt, aim);
  else if (keys) { if (p.local) chase.resetTo(fm.quat); instructor.reset(fm); } // keys override; the aim follows the nose
}

/** Host: the automatic engineer runs whenever nobody sits at the engineer's panel. */
function feHandover() {
  const manned = allPlayers().some((p) => atStation("flight_engineer", p));
  if (manned === feManned) return;
  feManned = manned;
  if (manned) {
    fm.feAuto = false;
    fm.fuel.auto = false;
    say("FLIGHT ENGINEER: you have the panel (automatic engineer off; J hands it back)");
  } else {
    for (const p of allPlayers()) p.engineer.release(fm);
    fm.feAuto = fm.fuel.auto = true;
    say("Automatic engineer back on the panel (cowl flaps, tank sequencing)");
  }
}

/** A manned gun station: the sight computer turns the gunner's line of sight into turret commands. */
function playerAim(p: Player, dt: number, fire: boolean): PlayerAim | null {
  const sightNow = gunSight(p);
  if (!sightNow || !p.crew.seat) { if (!p.local) p.sight.reset(); return null; }
  const q = aircraftRoot.quaternion;
  const eyeW = new THREE.Vector3(...sightNow.eye).applyMatrix4(aircraftRoot.matrixWorld).add(new THREE.Vector3(fm.pos.x, 0, fm.pos.z));
  let dirW = new THREE.Vector3(0, 0, -1).applyQuaternion(q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(p.crew.pitch, p.crew.seat.yaw + p.crew.yaw, 0, "YXZ"))));
  if (p.chase) {
    // third person: the crosshair is on the camera's axis; lay the sight line through that point
    const cam = new THREE.Vector3(fm.pos.x, fm.pos.y, fm.pos.z).addScaledVector(dirW, -GUN_CHASE.dist).add(new THREE.Vector3(0, GUN_CHASE.dist * GUN_CHASE.lift, 0));
    dirW = cam.addScaledVector(dirW, p.sight.range).sub(eyeW).normalize();
  }
  const aimFor = p.sight.compute(dt, fm, q, eyeW, dirW, fighters, !!sightNow.aft);
  return { turrets: sightNow.turrets, aimFor, fire, tag: p.local ? 0 : 100 + p.id };
}

// ---------------------------------------------------------------- cockpit commands (levers, chart)

function setControl(cmd: Cmd) {
  const c = fm.controls;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  switch (cmd.k) {
    case "throttle": if (cmd.all) c.throttle.fill(clamp01(cmd.v)); else c.throttle[cmd.i] = clamp01(cmd.v); break;
    case "jet": if (cmd.all) c.jetThrottle.fill(clamp01(cmd.v)); else c.jetThrottle[cmd.i] = clamp01(cmd.v); break;
    case "trim": c.trim = Math.max(-1, Math.min(1, cmd.v)); break;
    case "tiller": c.tiller = Math.max(-1, Math.min(1, cmd.v)); break;
    case "flaps": c.flaps = clamp01(cmd.v); break;
    case "gear": c.gearDown = cmd.v; break;
    case "brake": c.parkingBrake = cmd.v; break;
  }
}

/** A cockpit lever, switch or chart mark from this machine: applied here, and sent to the host by crew. */
function ctl(cmd: Cmd) {
  if (!isClient()) { applyCmd(me, cmd); return; }
  pendingCmds.push(cmd);
  if (cmd.k === "wp" || cmd.k === "apoff") return;
  // show the lever where we put it until the host's state catches up (no snapping back)
  setControl(cmd);
  const key = cmd.k === "throttle" || cmd.k === "jet" ? `${cmd.k}${cmd.all ? "*" : cmd.i}` : cmd.k;
  localOverride.set(key, { until: nowS() + 0.6, apply: () => setControl(cmd) });
}

function applyCmd(p: Player, cmd: Cmd) {
  if (cmd.k === "wp") {
    if (!atStation("navigator", p) && !p.local) return;
    chart.waypoint = { name: String(cmd.name).slice(0, 12), x: Number(cmd.x), z: Number(cmd.z) };
    say(`NAVIGATOR: new mark, ${(bearingTo(fm.pos.x, fm.pos.z, chart.waypoint.x, chart.waypoint.z).dist / 1609.344).toFixed(1)} mi`);
    return;
  }
  if (!flying(p)) return;
  if (cmd.k === "apoff") { if (ap.engaged) { ap.disengage(); say("AUTOPILOT OFF (mouse aim)"); } return; }
  p.lastFlight = nowS();
  setControl(cmd);
}

// ---------------------------------------------------------------- session: host side and crew side

function localSay(msg: string) {
  crewMsg = msg;
  crewMsgT = 4;
}

/** Host: a message only one crew member sees. */
function tell(p: Player, msg: string) {
  if (p.local) localSay(msg);
  else net?.send({ type: "say", to: p.id, text: msg });
}

function netFrame(dt: number) {
  if (!net?.connected) return;
  const now = nowS();
  net.tick(now);
  if (net.isHost) {
    simClock += dt;
    fastT -= dt;
    slowT -= dt;
    if (fastT <= 0) {
      fastT = Math.max(0, fastT + 1 / 30);
      net.send(buildFast(simClock, refs(), crewPoses(), evq.splice(0)) as unknown as NetMsg);
    }
    if (slowT <= 0) {
      slowT = 0.2;
      updateHostSeats();
      net.send(buildSlow(simClock, epoch, refs(), {
        chart: { wp: chart.waypoint, coupled: chart.coupled }, scope: { r: scope.rangeIdx, g: Math.round(scope.gain * 100) / 100 },
        raid: { waves: raid.waves, next: Math.round(raid.next * 10) / 10 }, kills: gunsight.kills, fkills: fighters?.kills ?? 0,
        hours: world.hours, seats: hostSeats,
      }) as unknown as NetMsg);
    }
  } else {
    sendT -= dt;
    if (sendT <= 0) {
      sendT = 1 / 30;
      net.send({
        type: "in", keys: input.heldKeys(), pr: pendingPressed.splice(0), my: input.mouseYoke,
        mxy: [input.mouseYokeXY.x, input.mouseYokeXY.y], fire: me.firing, pose: poseOf(me), rng: gunsight.range,
        assist: gunsight.assist, chase: me.chase, ma: mouseAim,
        aim: me.chase && flying() ? chase.aimDir().toArray() : null, cmds: pendingCmds.splice(0),
      });
    }
  }
}

/** Crew side: the host's state at render time (interpolated), events replayed when they happen. */
function applyReplica(dt: number) {
  if (!net) return;
  const now = nowS();
  const rt = net.clock.renderTime(now, dt);
  if (Number.isNaN(rt)) return;
  for (const s of fastBuf.items) {
    if (s.t > replayedT && s.t <= rt) { for (const e of s.ev) replay(e); replayedT = s.t; }
  }
  const br = fastBuf.bracket(rt);
  if (!br) return;
  debugHook.renderT = rt;
  applyFast(refs(), br.a, br.b, br.f, br.dt);
  for (const [k, o] of localOverride) { if (now < o.until) o.apply(); else localOverride.delete(k); }
  fm.refreshReadout(dt);
  posesNow = interpPoses(br.a, br.b, br.f).filter((p) => p.id !== me.id);
  playerAim(me, dt, false); // sight computer for this gunner's own display (lock, range)
}

function onSlow(s: SlowSnap) {
  if (lastSlow && s.epoch !== lastSlow.epoch) {
    fx?.reset();
    rounds?.clear();
    fighters?.clear();
    bombs?.reload();
  }
  lastSlow = s;
  applySlow(refs(), s);
  chart.waypoint = s.chart.wp;
  chart.coupled = s.chart.coupled;
  scope.rangeIdx = s.scope.r;
  scope.gain = s.scope.g;
  raid.waves = s.raid.waves;
  raid.next = s.raid.next;
  if (fighters) fighters.kills = s.fkills;
  if (world.hours !== s.hours) world.setTime(s.hours);
}

const vec = (a: number[], i: number) => new THREE.Vector3(a[i], a[i + 1], a[i + 2]);

/** Crew side: replay one host event (tracers, flak, hits, bombs, messages). */
function replay(e: Ev) {
  const n = e as number[];
  switch (e[0]) {
    case "say": localSay(String(e[1])); break;
    case "r": {
      const pos = vec(n, 1), vel = vec(n, 4), tag = n[9];
      rounds?.spawn(pos, vel, n[7] === 1, n[8], tag);
      const ear = listener();
      fx?.muzzle(pos, vel.clone().sub(fm.vel).normalize(), fm.vel, Math.random() < 0.5);
      sound.gun(pos.distanceTo(ear), view === "inside");
      if (tag === myTag()) myShotT = nowS();
      break;
    }
    case "er": fighters?.rounds.spawn(vec(n, 1), vec(n, 4), n[7] === 1, n[8], n[9]); break;
    case "fl": {
      const w = vec(n, 1), local = vec(n, 4);
      fx?.flakBurst(w, n[7]);
      const hits = (e[8] as unknown as [string, number][]).map(([id, h]) => ({ comp: fm.damage.byId.get(id)!, hits: h })).filter((h) => h.comp);
      if (hits.length) fx?.holesFrom(local, hits);
      break;
    }
    case "ff": { const f = fighters?.list.find((x) => x.id === n[1]); if (f) fighters!.onFire?.(f, vec(n, 2), n[5]); break; }
    case "fh": {
      const comp = fm.damage.byId.get(String(e[1]));
      if (comp) fighters?.onHit?.({ comp, dmg: n[2], pointModel: vec(n, 3), fromModel: vec(n, 6), big: n[9] === 1 });
      break;
    }
    case "fs": { const f = fighters?.list.find((x) => x.id === n[1]); if (f) fighters!.onStruck?.(f, n[2], n[3] === 1); break; }
    case "fx": { const f = fighters?.list.find((x) => x.id === n[1]); if (f) fighters!.onExplode?.(f); break; }
    case "bd": bombs?.spawnFalling(vec(n, 1), vec(n, 4)); break;
  }
}

/** Host: a remote crew member's packet. */
function onInput(p: Player, m: NetMsg) {
  const mxy = (m.mxy as number[]) ?? [0, 0];
  (p.input as RemoteInput).feed((m.keys as string[]) ?? [], (m.pr as string[]) ?? [], !!m.my, { x: mxy[0], y: mxy[1] });
  p.firing = !!m.fire;
  if (m.pose) applyPose(p, m.pose as Pose);
  if (typeof m.rng === "number") p.sight.range = m.rng;
  p.sight.assist = !!m.assist;
  p.chase = !!m.chase;
  p.mouseAim = m.ma !== false;
  p.chaseAim = Array.isArray(m.aim) ? new THREE.Vector3(...(m.aim as [number, number, number])).normalize() : null;
  for (const c of (m.cmds as Cmd[]) ?? []) applyCmd(p, c);
}

function onNet(m: NetMsg) {
  if (!net) return;
  if (net.isHost) {
    if (m.type === "join") {
      const cr = new Crew(me.crew.nav);
      cr.sit("Seat_AC");
      cr.standUp();
      const p = makePlayer(m.id as number, String(m.name), false, cr, new RemoteInput(), new SightComputer(), new Engineer());
      remotes.set(p.id, p);
      say(`${p.name.toUpperCase()} HAS JOINED THE CREW`);
    } else if (m.type === "leave") {
      const p = remotes.get(m.id as number);
      if (p) { remotes.delete(p.id); say(`${p.name.toUpperCase()} HAS LEFT THE AIRCRAFT`); }
    } else if (m.type === "in" && m.from) {
      const p = remotes.get(m.from);
      if (p) onInput(p, m);
    }
    return;
  }
  if (m.type === "fs") {
    const s = m as unknown as FastSnap;
    fastBuf.push(s);
    net.clock.sample(s.t, nowS());
  } else if (m.type === "ss") onSlow(m as unknown as SlowSnap);
  else if (m.type === "say") localSay(String(m.text));
  else if (m.type === "hostLeft") localSay("THE HOST HAS LEFT: the session is over (reload to fly solo)");
}

/** Join overlay: name entry, who is aboard. Resolves with the name. */
function askName(info: { players: { name: string; host: boolean }[]; willHost: boolean }): Promise<string> {
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;inset:0;z-index:20;display:grid;place-items:center;background:rgba(8,10,12,0.72);font:14px system-ui,sans-serif;color:#eee;";
    const host = info.players.find((p) => p.host);
    const aboard = info.players.map((p) => p.name).join(", ");
    let saved = "";
    try { saved = localStorage.getItem("b36.name") ?? ""; } catch { /* storage blocked */ }
    box.innerHTML = `<div style="background:#14181c;padding:22px 26px;border-radius:8px;width:min(360px, 92vw);box-sizing:border-box;">
      <div style="font-weight:600;color:#ffd27a;margin-bottom:6px">B-36 MULTICREW</div>
      <div style="color:#9ab;margin-bottom:14px">${info.willHost ? "You will host this session: the aircraft is simulated on this computer." : host ? `Joining ${esc(host.name)}'s crew.` : "Waiting for the host (the first browser on the host's computer)."}${aboard ? `<br>Aboard: ${esc(aboard)}` : ""}</div>
      <label>Your name <input id="b36name" maxlength="24" style="margin-left:8px;padding:4px 6px;width:170px" value="${esc(saved)}"></label>
      <div style="margin-top:16px;text-align:right"><button id="b36join" style="padding:6px 14px">${info.willHost ? "Start the session" : "Board the aircraft"}</button></div></div>`;
    document.body.appendChild(box);
    const field = box.querySelector("#b36name") as HTMLInputElement;
    field.focus();
    const go = () => {
      const name = field.value.trim() || (info.willHost ? "Host" : "Crew");
      try { localStorage.setItem("b36.name", name); } catch { /* storage blocked */ }
      box.remove();
      resolve(name);
    };
    (box.querySelector("#b36join") as HTMLButtonElement).onclick = go;
    field.onkeydown = (e) => { if (e.key === "Enter") go(); };
  });
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** If this page came from a session server, join it (the host's own browser simulates). */
async function startSession(nav: NavData) {
  const url = NetSession.url();
  if (!url) return;
  let info: { session?: boolean; players: { name: string; host: boolean }[]; willHost: boolean };
  try {
    const r = await fetch("session", { cache: "no-store" });
    if (!r.ok) return;
    info = await r.json();
    if (!info.session) return;
  } catch { return; }
  const name = await askName(info);
  const s = new NetSession();
  s.onMessage = onNet;
  s.onStatus = (t) => localSay(t.toUpperCase());
  const ok = await s.connect(url, name);
  if (!ok) { localSay("COULD NOT JOIN THE SESSION: flying solo"); return; }
  net = s;
  me.id = s.id;
  me.name = name;
  debugHook.net = net;
  debugHook.simT = () => simClock;
  if (s.isHost) {
    // everything the crew must see is recorded as events
    rounds!.onSpawn = (p, v, tr, life, tag) => rec(["r", ...v3r(p), ...v3r(v), tr ? 1 : 0, life, tag]);
    fighters!.rounds.onSpawn = (p, v, tr, life, tag) => rec(["er", ...v3r(p), ...v3r(v), tr ? 1 : 0, life, tag]);
    bombs!.onDrop = (p, v) => rec(["bd", ...v3r(p), ...v3r(v)]);
    startBackgroundTicker();
    localSay(`HOSTING: friends open http://<this computer's IP>:${location.port || 80} (see the server window)`);
  } else {
    rounds!.onSegment = null; // hits are decided on the host
    fighters?.clear();
    me.crew.standUp();
    const host = s.roster.find((r) => r.host)?.name ?? "the host";
    localSay(`JOINED ${host.toUpperCase()}'S CREW: walk to a station (Tab lists them)`);
  }
  void nav;
}

const v3r = (v: THREE.Vector3) => [Math.round(v.x * 1000) / 1000, Math.round(v.y * 1000) / 1000, Math.round(v.z * 1000) / 1000];

/** Host in a background tab: the browser stops animation frames, so a worker timer keeps the
 * simulation and the crew's snapshots going. */
let tickerFrame: ((render: boolean, dt?: number) => void) | null = null;
function startBackgroundTicker() {
  try {
    const w = new Worker(URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 33);"], { type: "text/javascript" })));
    let last = performance.now();
    w.onmessage = () => {
      const n = performance.now();
      const dt = Math.min((n - last) / 1000, 0.1);
      last = n;
      if (document.hidden && isHost()) tickerFrame?.(false, dt);
    };
  } catch { /* no workers: the session pauses while the host's tab is hidden */ }
}

/** Multiplayer line for the HUD. */
function netStatus(): string {
  if (!net) return "";
  if (!net.connected) return "\nSESSION: disconnected";
  const station = (p: Pose | undefined) => {
    const seat = p?.seat ? me.crew.nav.seats.find((s) => s.name === p.seat) : null;
    return seat ? STATION_NAMES[seat.station] ?? seat.station : p?.mode === "tunnel" ? "in the tunnel" : "walking";
  };
  const poses = isClient() ? posesNow : [...remotes.values()].map((p) => p.pose).filter((p): p is Pose => !!p);
  const others = net.roster.filter((r) => r.id !== me.id).map((r) => `${r.name}${r.host ? " (host)" : ""}: ${station(poses.find((p) => p.id === r.id))}`);
  return `\nCREW ${others.length ? others.join("  |  ") : "nobody else aboard yet"}` +
    (isClient() ? `   ping ${(net.rtt * 1000).toFixed(0)} ms` : "   HOSTING");
}


// Model files; the hosted build overrides these with JSON-embedded variants (see web/artifact/build.sh).
const MODELS = (window as unknown as { B36_MODELS?: { exterior: string; interior: string } }).B36_MODELS
  ?? { exterior: "models/b36.gltf", interior: "models/b36_interior.glb" };
const navReq = fetch("models/b36_nav.json").then((r) => r.json() as Promise<NavData>);
Promise.all([loadGltf(MODELS.exterior), loadGltf(MODELS.interior), navReq]).then(([ext, int, nav]) => {
  bombs = new BombSystem(aircraftRoot, world.group);
  range = new BombingRange(world.group);
  bombs.onImpact = (i) => range!.impact(i.pos);
  turrets = findTurrets(ext);
  rounds = new Rounds(world.group);
  rounds.onGround = (p) => range!.strafe(p);
  fighters = new Fighters(world.group);
  defense = new DefensiveFire(turrets, aircraftRoot, rounds, fighters);
  rounds.onSegment = (a, b, tag) => fighters!.struck(a, b, tag, frameDt);
  setupFighterEvents();
  trolley = int.getObjectByName("Tunnel_Trolley") ?? null;
  mountDisplays(int, chart, scope);
  fx = new DamageFX(world.group, aircraftRoot, ext);
  flak.onBurst = (w, local, d, hits) => {
    rec(["fl", ...v3r(w), ...v3r(local), Math.round(d), hits.map((h) => [h.comp.id, h.hits])]);
    fx!.flakBurst(w, d);
    if (hits.length) fx!.holesFrom(local, hits);
    const n = hits.reduce((a, h) => a + h.hits, 0);
    if (n > 0) say(`FLAK: ${n} fragment hit${n > 1 ? "s" : ""}`);
  };
  debugHook.flak = flak;
  debugHook.fx = fx;
  Object.assign(debugHook, { bombs, range, ap, aircraftRoot, world, turrets, rounds, fighters, defense, gunsight, raid, startFighterAttack });
  crew = new Crew(nav);
  crew.sit("Seat_AC");
  me = makePlayer(0, "You", true, crew, input, gunsight, engineer);
  debugHook.crew = crew;
  const aircraft = new Aircraft(ext);
  const cockpit = new Cockpit(int);
  aircraftRoot.add(ext, int);
  const aniso = renderer.capabilities.getMaxAnisotropy();
  ext.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const m = o.material as THREE.MeshStandardMaterial;
      for (const t of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap]) if (t) t.anisotropy = aniso;
    }
    if (o instanceof THREE.Mesh && (o.material as THREE.Material).transparent) o.castShadow = false;
  });
  const cabinEnv = cabinEnvironment(renderer);
  int.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      // the cabin is lit through the glazing only: the shell and everything inside casts and receives
      // shadows; fill and reflections come from a cabin environment (bright only toward the glazing)
      // that turns with the aircraft, darkened by the baked ambient occlusion
      const m = o.material as THREE.MeshStandardMaterial;
      m.envMap = cabinEnv;
      m.envMapIntensity = 1.0;
      cabinMats.add(m);
      if (!m.transparent) { o.castShadow = true; o.receiveShadow = true; }
    }
  });
  extFrames = ext.getObjectByName("CanopyFrame") ?? null;
  aircraftRoot.add(headlamp);
  for (const z of [-11.5, -9.0]) {  // aft compartment
    const l = new THREE.PointLight(0xffe2b8, 1.1, 5.0, 1.6);
    l.position.set(0, 1.0, z);
    aircraftRoot.add(l);
  }
  // Dim cabin lights (model coords): flight deck aft area, radio station, lower deck fore and aft.
  for (const [x, y, z, i] of [[0, 1.6, -18.0, 1.2], [0, 1.6, -15.0, 1.0], [0, -0.1, -20.2, 1.4], [0, -0.1, -16.0, 1.2]]) {
    const l = new THREE.PointLight(0xffe2b8, i, 5.5, 1.6);
    l.position.set(x, y, z);
    aircraftRoot.add(l);
  }

  // station lights: navigator's chart lamp, glow from scopes and equipment lamps (model coords)
  {
    const lamp = new THREE.SpotLight(0xffd9a0, 4, 3.2, 0.75, 0.6, 1.6);
    lamp.position.set(-1.16, -0.43, -19.13);
    lamp.target.position.set(-1.22, -0.8, -18.9);
    aircraftRoot.add(lamp, lamp.target);
    for (const [x, y, z, c, i] of [[0, -0.72, -20.4, 0x50ff80, 0.35], [-0.6, 0.85, -14.85, 0xffb060, 0.3], [0, 0.25, 14.1, 0x50ff80, 0.35], [0.9, -1.0, -18.9, 0xffb060, 0.25]] as const) {
      const l = new THREE.PointLight(c, i, 1.6, 1.8);
      l.position.set(x, y, z);
      aircraftRoot.add(l);
    }
  }

  resetOnRunway();
  setupPointer(cockpit);
  const vis = defaultAircraftState();
  const clock = new THREE.Clock();
  let acc = 0;
  const STEP = 1 / 120;
  avatars = new CrewAvatars(aircraftRoot, nav);
  Object.assign(debugHook, { netRemotes: () => remotes.values(), trySit, avatarCount: () => avatars?.count ?? 0, me });
  void startSession(nav);

  /**
   * One frame. render = false runs only the simulation and the network (the host's tab in the
   * background keeps the session alive for the crew).
   */
  const frame = (render: boolean, dtIn?: number) => {
    const dt = dtIn ?? Math.min(clock.getDelta(), 0.1);
    const pressedList = render ? input.takePressed() : [];
    const pressed = new Set(pressedList);
    const cr = me.crew;
    me.aboard = aboard();
    me.chase = view === "chase";
    if (render) localUI(me, pressedList, dt);
    const sightNow = gunSight();
    const fireNow = me.firing || (sightNow !== null && input.isDown("Space"));

    if (!isClient()) {
      // ------------------------------------------------ host / single player: stations, sim, gunnery
      if (render) stationFrame(me, pressedList, dt);
      for (const p of remotes.values()) stationFrame(p, p.input.takePressed(), dt);
      // the pilot who touched the controls last has the airplane
      const flyers = [me, ...remotes.values()].filter((p) => flying(p));
      const pic = flyers.sort((a, b) => b.lastFlight - a.lastFlight)[0];
      if (pic) flightInput(pic, pic === me ? pressedList : pic.lastPressed, dt);
      else input.neutral(fm.controls, dt);
      feHandover();
      if (chart.coupled) {
        const w = bearingTo(fm.pos.x, fm.pos.z, chart.waypoint.x, chart.waypoint.z);
        if (!ap.engaged) chart.coupled = false;
        else if (w.dist < 1500) { chart.coupled = false; say(`NAVIGATOR: over ${chart.waypoint.name}, holding heading`); }
        else ap.headingDeg = w.brg;
      }
      acc += dt;
      while (acc >= STEP) {
        ap.update(fm, STEP);
        fm.step(STEP, 2);
        flak.update(fm, STEP);
        acc -= STEP;
      }
    }
    if (render && view === "inside" && cr.mode !== "seated") {
      const k = (...codes: string[]) => codes.some((c) => input.isDown(c));
      const before = cr.pos.clone();
      cr.update(dt, {
        forward: (k("KeyW", "ArrowUp") ? 1 : 0) - (k("KeyS", "ArrowDown") ? 1 : 0),
        strafe: (k("KeyD", "ArrowRight") ? 1 : 0) - (k("KeyA", "ArrowLeft") ? 1 : 0),
        run: k("ShiftLeft", "ShiftRight"),
        crouch: k("ControlLeft", "ControlRight"),
      });
      me.speed = dt > 0 ? before.distanceTo(cr.pos) / dt : 0;
    } else if (render) me.speed = 0;
    if (render && extFrames) extFrames.visible = view !== "inside";
    if (isClient()) applyReplica(dt);
    // aircraft pose with floating origin (CG at x = z = 0) before anything is placed relative to it
    {
      const off = fm.modelOffset.applyQuaternion(fm.quat);
      aircraftRoot.position.set(off.x, fm.pos.y + off.y, off.z);
      aircraftRoot.quaternion.copy(fm.quat);
    }
    aircraftRoot.updateMatrixWorld(true);
    bombs?.update(fm, aircraftRoot.matrixWorld, dt);
    frameDt = dt;
    if (!isClient()) {
      updateRaid(dt);
      fighters?.update(fm, dt);
      // turrets: each manned station follows its gunner's computing sight, AI gunners man the rest
      const manned: PlayerAim[] = [];
      for (const p of [me, ...remotes.values()]) {
        const aim = playerAim(p, dt, p === me && render ? fireNow : p.firing || (gunSight(p) !== null && p.input.isDown("Space")));
        if (aim) manned.push(aim);
      }
      if (!gunSight()) gunsight.reset();
      defense?.update(fm, dt, manned);
    } else {
      fighters?.rounds.update(dt); // enemy tracers, visual only on the crew's screens
    }
    weaponEffects(dt, cr);
    rounds?.update(dt);
    fx?.update(fm, dt, window.innerHeight / (2 * Math.tan((camera.fov * Math.PI) / 360)));
    const ev = fm.damage.events[0];
    if (!isClient() && ev && ev !== lastEvent) {
      for (const e of fm.damage.events) { if (e === lastEvent) break; if (e.severe) { say(e.msg.toUpperCase()); break; } }
      lastEvent = ev;
    }
    // the tunnel trolley rides under whoever is in the tunnel
    if (trolley) {
      const inTunnel = cr.tunnel ? (() => { const e = new THREE.Vector3(); cr.eye(e); return e.z; })()
        : crewPoses().find((p) => p.mode === "tunnel")?.eye[2];
      if (inTunnel !== undefined) {
        const [z0, z1] = cr.nav.tunnels[0].trolley;
        trolley.position.z = Math.max(z0, Math.min(z1, inTunnel));
      }
    }
    range?.update(dt);
    crewMsgT -= dt;
    avatars?.update(crewPoses(), me.id, dt);
    netFrame(dt);
    if (!render) return;
    const nearDisplays = view === "inside" && cr.deck.id === "lower";
    impactT -= dt;
    if (bombs && impactT <= 0 && nearDisplays) {
      impactT = 0.25;
      const from = bombs.nextReleasePoint(fm, aircraftRoot.matrixWorld);
      scope.impact = from ? (({ point }) => ({ x: point.x, z: point.z }))(BombSystem.predict(fm, from)) : null;
    }
    chart.update(fm, range, dt, nearDisplays || bigDisplay === "chart");
    scope.update(fm, range, dt, nearDisplays || bigDisplay === "scope");
    chart.canvas.style.display = bigDisplay === "chart" ? "block" : "none";
    scope.canvas.style.display = bigDisplay === "scope" ? "block" : "none";
    const prev = prevRoot.clone();
    prevRoot.copy(aircraftRoot.position);
    world.follow(fm.pos, toWorldPt(camera.getWorldPosition(new THREE.Vector3())));
    // terrain away from the flat plain: flying into it is a crash (the flight model's ground is y = 0)
    if (!isClient() && !fm.damage.crashed && fm.pos.y < terrainHeight(fm.pos.x, fm.pos.z) + 3) fm.damage.crash(fm, "flew into terrain");
    // cabin environment follows the aircraft attitude (world direction -> model direction)
    cabinRot.setFromQuaternion(aircraftRoot.quaternion.clone().invert());
    for (const m of cabinMats) m.envMapRotation.copy(cabinRot);
    // inside: a tight shadow frustum around the eye gives sharp sunlight through the glazing
    if (view === "inside") world.aimSun(camera.getWorldPosition(new THREE.Vector3()), 8);
    else world.aimSun(aircraftRoot.position, 60);

    const c = fm.controls;
    vis.aileron = c.aileron;
    vis.elevator = c.elevator + (c.trim * fm.p.trimMax) / fm.p.elevatorMax;
    vis.rudder = c.rudder;
    vis.flaps = fm.flapPos;
    vis.gear = fm.gearPos;
    vis.bombDoors.fill(fm.bombDoorPos);
    vis.propRpm = fm.pistons.map((e) => e.rpm);
    aircraft.apply(vis, dt);
    cockpit.update(fm, dt);

    if (view === "chase" && cr.seat) {
      const cg = new THREE.Vector3(0, fm.pos.y, 0);
      if (cr.seat.flies) {
        const dir = chase.aimDir();
        chase.place(camera, cg, dir);
        chase.drawPilot(camera, cg, new THREE.Vector3(0, 0, -1).applyQuaternion(fm.quat), mouseAim && !ap.engaged);
      } else {
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(aircraftRoot.quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(cr.pitch, cr.seat.yaw + cr.yaw, 0, "YXZ"))));
        chase.place(camera, cg, dir, GUN_CHASE.dist, GUN_CHASE.lift);
        chase.hide();
        if (camera.fov !== GUN_CHASE.fov) { camera.fov = GUN_CHASE.fov; camera.updateProjectionMatrix(); }
      }
    } else if (view === "inside" && sightView && bombs) {
      // gyro-stabilised bombsight: looks from the nose at the predicted impact point
      aircraftRoot.updateMatrixWorld(true);
      const sightPos = new THREE.Vector3(0, -1.0, 1.4 - 24.7).applyMatrix4(aircraftRoot.matrixWorld);
      const abs = sightPos.clone();
      abs.x += fm.pos.x;
      abs.z += fm.pos.z;
      const pred = BombSystem.predict(fm, bombs.nextReleasePoint(fm, aircraftRoot.matrixWorld) ?? abs);
      const target = pred.point.clone();
      target.x -= fm.pos.x;
      target.z -= fm.pos.z;
      camera.position.copy(sightPos);
      camera.up.set(0, 1, 0);
      const fwd = fm.vel.clone().setY(0).normalize();
      camera.up.copy(fwd);
      camera.lookAt(target);
      camera.fov = 9;
      camera.updateProjectionMatrix();
      let nd = Infinity;
      let nt = "";
      for (const t of range!.targets) {
        if (t.destroyed) continue;
        const d = Math.hypot(t.pos.x - pred.point.x, t.pos.z - pred.point.z);
        if (d < nd) { nd = d; nt = t.name; }
      }
      impactEl.textContent = `TIME OF FALL ${pred.time.toFixed(1)} s   NEAREST TARGET ${nt} ${nd < 10_000 ? nd.toFixed(0) + " m" : "-"}`;
    } else if (view === "inside" && sightNow && cr.seat) {
      const eyeS = new THREE.Vector3(...sightNow.eye).applyMatrix4(aircraftRoot.matrixWorld);
      camera.position.copy(eyeS);
      camera.up.set(0, 1, 0);
      camera.quaternion.copy(aircraftRoot.quaternion).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(cr.pitch, cr.seat.yaw + cr.yaw, 0, "YXZ")));
      // sight vibration from the guns and from hits nearby
      const k = 0.0012 * gunsight.shake + 0.02 * (fx?.shake ?? 0);
      if (k > 0) camera.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler((Math.random() - 0.5) * k, (Math.random() - 0.5) * k, 0)));
      if (camera.fov !== head.fov) { camera.fov = head.fov; camera.updateProjectionMatrix(); }
    } else if (view === "inside") {
      if (camera.fov !== head.fov) { camera.fov = head.fov; camera.updateProjectionMatrix(); camera.up.set(0, 1, 0); }
      aircraftRoot.updateMatrixWorld(true);
      const ang = cr.eye(eyeLocal);
      camera.position.copy(eyeLocal).applyMatrix4(aircraftRoot.matrixWorld);
      const look = new THREE.Quaternion().setFromEuler(new THREE.Euler(ang.pitch, ang.yaw, 0, "YXZ"));
      camera.quaternion.copy(aircraftRoot.quaternion).multiply(look);
      if (fx && fx.shake > 0) {
        const k = 0.02 * fx.shake;
        camera.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler((Math.random() - 0.5) * k, (Math.random() - 0.5) * k, (Math.random() - 0.5) * k)));
      }
    } else if (orbit) {
      const delta = aircraftRoot.position.clone().sub(prev);
      camera.position.add(delta);
      orbit.target.copy(aircraftRoot.position);
      orbit.update();
    }

    const r = fm.readout;
    {
      hud.textContent =
        `IAS ${r.ias_mph.toFixed(0)} mph   ALT ${r.alt_ft.toFixed(0)} ft   VS ${r.vs_fpm.toFixed(0)} fpm   HDG ${r.heading_deg.toFixed(0)}\n` +
        `PISTON ${(c.throttle[0] * 100).toFixed(0)}%   JETS ${c.jetThrottle[0] > 0 ? (c.jetThrottle[0] * 100).toFixed(0) + "%" : "OFF"}   ` +
        `TRIM ${(c.trim * 100).toFixed(0)}   FLAPS ${(fm.flapPos * 100).toFixed(0)}%   GEAR ${fm.gearPos > 0.99 ? "DOWN" : fm.gearPos < 0.01 ? "UP" : "MOVING"}` +
        `${c.parkingBrake ? "   PARK BRAKE" : ""}${input.mouseYoke ? "   MOUSE YOKE" : ""}` +
        `${ap.engaged ? `   AP ${ap.altitudeFt.toFixed(0)} ft / ${ap.headingDeg.toFixed(0).padStart(3, "0")}` : ""}\n` +
        crewStatus(cr) +
        (fm.damage.destroyed ? `\n*** AIRCRAFT ${fm.damage.crashed ? "DESTROYED" : "LOST"}: ${fm.damage.destroyReason.toUpperCase()}   R: reset ***` : "") +
        (atStation("radar_observer") && bombs
          ? `\nBOMBS ${bombs.remaining}   DOORS ${fm.bombDoorPos > 0.95 ? "OPEN" : fm.bombDoorPos < 0.05 ? "CLOSED" : "MOVING"}   ` +
            `${bombs.armed ? "ARMED" : "SAFE"}   MODE ${bombs.mode.toUpperCase()}   HITS ${range!.destroyedCount}/${range!.targets.length}` +
            `\nO doors  K arm  M mode  Space release  V bombsight  A/D steer (autopilot)  Z autopilot`
          : "") +
        (raid.waves > 0 || (fighters?.active ?? 0) > 0 ? `\nFIGHTERS ${fighters!.active} ATTACKING   SHOT DOWN ${fighters!.kills}${raid.waves > 0 && raid.next > 0 ? `   NEXT WAVE ${raid.next.toFixed(0)} s` : ""}` : "") +
        (atStation("flight_engineer") ? me.engineer.status(fm) : engineWarnings(fm)) +
        netStatus() +
        (atStation("navigator") ? navStatus() : "") +
        (atStation("radar_observer") && !me.noseGuns ? `\nRADAR ${scope.rangeMi} MI  GAIN ${(scope.gain * 100).toFixed(0)}   B scope view  PgUp/PgDn range  [ ] gain  (yellow cross: bomb impact)` : "") +
        (crewMsgT > 0 ? `\n${crewMsg}` : "") +
        (range && range.log.length ? `\n${range.log[0]}` : "");
    }
    yokeDot.style.display = input.mouseYoke ? "block" : "none";
    sightEl.style.display = sightView ? "block" : "none";
    drawGunsight(sightNow, fireNow);
    headlamp.visible = view === "inside" && cr.mode === "tunnel";
    if (headlamp.visible) headlamp.position.copy(eyeLocal);
    aircraftRoot.visible = !(view === "inside" && sightView); // the optic looks out through its own window
    renderer.render(scene, camera);
    aircraftRoot.visible = true;
    impactEl.style.display = sightView ? "block" : "none";
  };
  tickerFrame = frame;
  renderer.setAnimationLoop(() => frame(true));
});

const cabinMats = new Set<THREE.MeshStandardMaterial>();
const cabinRot = new THREE.Euler();

/** Environment seen from inside the flight deck, in model axes (x right, y up, z aft): dark cabin,
 * sky through the glazing forward and above, a little ground light through the side windows. */
function cabinEnvironment(r: THREE.WebGLRenderer): THREE.Texture {
  const geo = new THREE.SphereGeometry(10, 64, 32);
  const col: number[] = [];
  const p = geo.getAttribute("position");
  const v = new THREE.Vector3();
  const glaze = new THREE.Vector3(0, 0.55, -0.83).normalize();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const g = THREE.MathUtils.smoothstep(v.dot(glaze), 0.15, 0.6); // canopy
    const side = THREE.MathUtils.smoothstep(Math.abs(v.x), 0.75, 0.95) * THREE.MathUtils.smoothstep(v.y, -0.1, 0.3) * 0.5;
    const sky = new THREE.Color(0.55, 0.68, 0.9);
    const c = new THREE.Color(0.018, 0.018, 0.02).lerp(sky, Math.min(1, g + side));
    col.push(c.r, c.g, c.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const sc = new THREE.Scene();
  sc.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const pm = new THREE.PMREMGenerator(r);
  const tex = pm.fromScene(sc, 0.02).texture;
  pm.dispose();
  return tex;
}

function navStatus(): string {
  const i = chart.info(fm);
  return `\nNAV  ${chart.waypoint.name}: ${i.brg.toFixed(0).padStart(3, "0")} deg, ${(i.dist / 1609.344).toFixed(1)} mi, ETE ${isFinite(i.ete) ? (i.ete / 60).toFixed(1) + " min" : "-"}` +
    `   ${chart.coupled ? "AUTOPILOT COUPLED" : ""}` +
    "\n1 base  2 IP  3 target  (or click the chart in V view)   Enter couple autopilot   PgUp/PgDn chart scale   V chart view";
}

// ---------------------------------------------------------------- fighters, gunnery effects, sound

const toWorldPt = (scene: THREE.Vector3) => scene.clone().add(new THREE.Vector3(fm.pos.x, 0, fm.pos.z));
const toScenePt = (world: THREE.Vector3) => world.clone().sub(new THREE.Vector3(fm.pos.x, 0, fm.pos.z));
const listener = () => toWorldPt(camera.getWorldPosition(new THREE.Vector3()));

function gunnerFor(clock: string) {
  const h = parseInt(clock, 10);
  const low = clock.includes("low"), high = clock.includes("high");
  if (h >= 5 && h <= 7) return "TAIL";
  if (h >= 11 || h <= 1) return "NOSE";
  if (low) return h <= 6 ? "LOWER RIGHT" : "LOWER LEFT";
  if (h <= 4) return high ? "UPPER FORWARD RIGHT" : "RIGHT BLISTER";
  return high ? "UPPER FORWARD LEFT" : "LEFT BLISTER";
}

function setupFighterEvents() {
  const f = fighters!;
  f.onFire = (ft, muzzle, gun) => {
    rec(["ff", ft.id, ...v3r(muzzle), gun]);
    fx?.fire.spawn(muzzle, ft.vel, gun === 0 ? 3 : 1.8, 4, 0.05, 1, [1.0, 0.85, 0.5]);
    if (gun === 0 || Math.random() < 0.5) sound.enemyGun(muzzle.distanceTo(listener()), gun === 0);
  };
  f.onHit = (h) => {
    rec(["fh", h.comp.id, Math.round(h.dmg * 10) / 10, ...v3r(h.pointModel), ...v3r(h.fromModel), h.big ? 1 : 0]);
    const w = toWorldPt(h.pointModel.clone().applyMatrix4(aircraftRoot.matrixWorld));
    fx?.sparks(w, fm.vel, h.big);
    fx?.holeAlong(h.fromModel, h.pointModel, h.big);
    const d = w.distanceTo(listener());
    sound.hit(d, h.big);
    if (fx && d < 14 && view === "inside") fx.shake = Math.max(fx.shake, (h.big ? 0.7 : 0.35) * (1 - d / 14));
  };
  f.onStruck = (ft, tag, killed) => {
    rec(["fs", ft.id, tag, killed ? 1 : 0]);
    fx?.sparks(ft.pos, ft.vel, killed);
    const mine = tag === myTag();
    if (mine) gunsight.notify(killed ? "KILL" : "HIT", killed ? "#ff7050" : "#ffd27a");
    if (!killed) return;
    if (mine) gunsight.kills++;
    if (isClient()) return; // the host announces it
    if (tag === 0 && !net) say("YOU GOT HIM! MiG going down");
    else if (tag === 0 || tag >= 100) say(`${playerName(tag === 0 ? me.id : tag - 100).toUpperCase()} GOT HIM! MiG going down`);
    else say(`${["TAIL", "UPPER AFT", "LOWER AFT", "NOSE"][Math.floor(Math.random() * 4)]} GUNNER: got one, MiG going down!`);
  };
  f.onExplode = (ft) => {
    rec(["fx", ft.id]);
    fx?.explosion(ft.pos, ft.vel);
    sound.explosion(ft.pos.distanceTo(listener()));
  };
  f.onAttack = (ft) => {
    if (calloutT > 0) return;
    calloutT = 3;
    const c = clockCall(fm, ft.pos);
    say(`${gunnerFor(c)}: FIGHTER ${c.toUpperCase()}, COMING IN!`);
  };
}

function updateRaid(dt: number) {
  calloutT -= dt;
  if (!fighters || fm.damage.destroyed) return;
  if (raid.waves > 0 && raid.next > 0) {
    raid.next -= dt;
    if (raid.next <= 0) {
      raid.waves--;
      raid.next = -1;
      raid.quiet = 0;
      fighters.spawnWave(fm, 4);
      const c = clockCall(fm, fighters.list[fighters.list.length - 1].pos);
      say(`TAIL GUNNER: BANDITS, FOUR MiGs ${c.toUpperCase()}, CLOSING. GUNNERS, TURRETS OUT!`);
    }
  } else if (raid.next < 0 && fighters.list.length > 0 && fighters.active === 0) {
    raid.quiet += dt;
    if (raid.quiet > 4) {
      fighters.clear();
      if (raid.waves > 0) { raid.next = 25; say("ALL STATIONS: they've broken off. Reload and stay sharp, more coming."); }
      else say(`ALL CLEAR. Fighters shot down: ${fighters.kills} (you: ${gunsight.kills}).`);
    }
  }
}

function weaponEffects(dt: number, cr: Crew) {
  const ear = listener();
  const inside = view === "inside";
  let n = 0;
  for (const s of defense?.shots ?? []) {
    fx?.muzzle(s.posWorld, s.dirWorld, fm.vel, n++ % 2 === 0);
    sound.gun(s.posWorld.distanceTo(ear), inside);
  }
  // contrails: six piston engines, four jets, and the fighters
  const tK = atmosphere(fm.pos.y).temperature;
  if (fx && tK < 245) {
    const m = aircraftRoot.matrixWorld;
    fm.p.piston.x.forEach((x, i) => {
      if (fm.pistons[i].rpm < 300) return;
      const l = new THREE.Vector3(x, 0.45, 26.29 + 0.0507 * Math.abs(x) - 24.7 + 2.5);
      fx!.contrail(`p${i}`, toWorldPt(l.applyMatrix4(m)), tK);
    });
    fm.p.jet.x.forEach((x, i) => {
      if (fm.jets[i].n < 0.2) return;
      fx!.contrail(`j${i}`, toWorldPt(new THREE.Vector3(x, -1.8, 22.6 - 24.7 + 3).applyMatrix4(m)), tK, 0.7);
    });
    for (const f of fighters?.list ?? []) if (f.alive) fx.contrail(`f${f.id}`, f.pos.clone().addScaledVector(f.vel, -0.03), atmosphere(f.pos.y).temperature, 0.6);
  }
  let near = Infinity, closing = 0;
  for (const f of fighters?.list ?? []) {
    if (f.smoking || f.burning) fx?.fighterTrail(f.prevPos, f.pos, f.smoking, f.burning);
    const d = f.pos.distanceTo(ear);
    if (d < near && f.state !== "gone") {
      near = d;
      closing = f.vel.clone().sub(fm.vel).dot(ear.clone().sub(f.pos).normalize());
    }
  }
  const mine = gunSight()?.turrets.map((n) => turrets.get(n)).filter((t): t is Turret => !!t) ?? [];
  const slew = mine.some((t) => t.slewing) ? 1 : mine.some((t) => t.ext > 0 && t.ext < 1) ? 0.6 : 0;
  const power = fm.pistons.reduce((a, e, i) => a + (e.running ? 0.35 + 0.65 * fm.controls.throttle[i] : 0), 0) / 6;
  sound.frame(cr.mode === "seated" && cr.seat?.sight ? slew : 0, near, closing, inside ? power : power * 0.5);
  void dt;
}

function drawGunsight(sight: ReturnType<typeof gunSight>, fireNow: boolean) {
  if (!sight || !aboard()) { gunsight.canvas.style.display = "none"; return; }
  gunsight.canvas.style.display = "block";
  const ts = sight.turrets.map((n) => turrets.get(n)).filter((t): t is Turret => !!t);
  const lines: THREE.Vector3[] = [];
  for (const t of ts) {
    if (!t.ready) continue;
    const p = t.pitchNode.getWorldPosition(new THREE.Vector3());
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(t.pitchNode.getWorldQuaternion(new THREE.Quaternion()));
    lines.push(p.addScaledVector(dir, gunsight.range));
  }
  const firingNow = fireNow && (isClient() ? nowS() - myShotT < 0.2 : defense?.shots.some((s) => s.tag === 0) ?? false);
  const name = STATION_NAMES[crew!.seat!.station] ?? crew!.seat!.station;
  gunsight.draw(camera, ts, lines, name, firingNow, defense?.interrupted ?? false, frameDt, !!sight.aft, view === "chase");
  if (gunsight.lock) {
    const v = toScenePt(gunsight.lock.pos).project(camera);
    if (v.z < 1) {
      const size = (window.innerHeight / 2 / Math.tan((camera.fov * Math.PI) / 360)) * (5 / Math.max(50, gunsight.lock.pos.distanceTo(listener())));
      gunsight.bracket((v.x * 0.5 + 0.5) * window.innerWidth, (-v.y * 0.5 + 0.5) * window.innerHeight, size);
    }
  }
}

function crewStatus(cr: Crew): string {
  if (view === "outside") return "OUTSIDE VIEW   C: back aboard";
  if (view === "chase" && cr.seat?.flies) return `THIRD PERSON   ${mouseAim ? (ap.engaged ? "AUTOPILOT ON (move the mouse to take over)" : "MOUSE AIM: the aircraft follows the circle") : "DIRECT CONTROLS"}   wheel: distance   M: mouse aim   C: cockpit`;
  if (view === "chase") return "THIRD PERSON GUNNER   C: back to the sight";
  if (cr.mode === "seated" && cr.seat) {
    const name = STATION_NAMES[cr.seat.station] ?? cr.seat.station;
    const working = cr.seat.flies || FUNCTIONAL.has(cr.seat.station) || isGunner(cr.seat.station);
    return `${name.toUpperCase()} SEAT   X: stand up   Tab: crew stations${cr.seat.station === "radar_observer" ? "   T: nose guns / bombsight" : ""}${working ? "" : "   (station not functional yet)"}`;
  }
  if (cr.mode === "climbing") return "ON LADDER";
  if (cr.auto) {
    const g = cr.auto.goal;
    const to = g.kind === "seat" ? STATION_NAMES[g.seat.station] ?? g.seat.name : g.kind === "ladder" ? "the ladder" : "the tunnel hatch";
    return `${cr.mode === "tunnel" ? "IN THE TUNNEL, " : ""}GOING TO ${to.toUpperCase()}   (any move key: stop)`;
  }
  if (cr.mode === "tunnel") return "IN THE TUNNEL (on the trolley)   W / S: pull along the rope, Shift faster";
  const it = cr.nearestInteraction();
  const hint = it?.kind === "seat" ? `   E: sit (${STATION_NAMES[it.seat.station] ?? it.seat.station})`
    : it?.kind === "ladder" ? `   E: ${cr.deck.id === it.ladder.lower ? "climb up" : "climb down"}`
    : it?.kind === "tunnel" ? `   E: enter the tunnel to the ${it.end === 0 ? "aft" : "forward"} compartment` : "";
  const td = cr.tunnelDistance();
  const tunnelHint = it?.kind !== "tunnel" && td < 4
    ? `   TUNNEL HATCH ${td.toFixed(1)} m ${cr.deck.id === "upper" ? "aft, on the left of the aft bulkhead" : "forward, top of the ladder"}` : "";
  const deck = cr.deck.id === "upper" ? "FLIGHT DECK" : cr.deck.id === "lower" ? "LOWER DECK" : "AFT COMPARTMENT";
  return `WALKING, ${deck}${hint}${tunnelHint}   Tab: crew stations`;
}

// ---------------------------------------------------------------- crew station list (Tab)

const stationsEl = document.createElement("div");
stationsEl.style.cssText = "position:fixed;left:12px;top:50%;transform:translateY(-50%);z-index:6;display:none;" +
  "background:rgba(10,12,14,0.85);color:#eee;font:13px system-ui,sans-serif;padding:8px 0;border-radius:6px;min-width:250px;";
document.body.appendChild(stationsEl);
function toggleStations() {
  const cr = crew;
  if (!cr || stationsEl.style.display === "block") { stationsEl.style.display = "none"; return; }
  const groups: [string, string][] = [["upper", "Flight deck"], ["lower", "Lower deck (forward compartment)"], ["aft", "Aft compartment (through the tunnel)"]];
  stationsEl.innerHTML = '<div style="padding:2px 12px 6px;color:#ffd27a">Walk to a station (Tab closes)</div>';
  for (const [deck, title] of groups) {
    const h = document.createElement("div");
    h.textContent = title;
    h.style.cssText = "padding:6px 12px 2px;color:#9ab;font-size:11px;text-transform:uppercase;";
    stationsEl.appendChild(h);
    for (const seat of cr.nav.seats.filter((s) => s.deck === deck)) {
      const row = document.createElement("div");
      const here = cr.seat === seat;
      row.textContent = (STATION_NAMES[seat.station] ?? seat.station) + (here ? "  (here)" : "");
      row.style.cssText = `padding:3px 18px;cursor:pointer;${here ? "color:#888;" : ""}`;
      row.onmouseenter = () => { row.style.background = "rgba(255,210,122,0.18)"; };
      row.onmouseleave = () => { row.style.background = ""; };
      row.onpointerdown = (e) => {
        e.stopPropagation();
        stationsEl.style.display = "none";
        if (!here && !cr.goTo({ kind: "seat", seat })) say("No way there from here");
      };
      stationsEl.appendChild(row);
    }
  }
  stationsEl.style.display = "block";
}

// ---------------------------------------------------------------- pointer: look, pick, drag

function setupPointer(cockpit: Cockpit) {
  const el = renderer.domElement;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let looking = false;
  let drag: { pick: Pickable; startY: number; startX: number; start: number; all: boolean } | null = null;
  el.addEventListener("contextmenu", (e) => e.preventDefault());

  debugHook.pickAt = (x: number, y: number) => {
    ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObject(cockpit.root, true).slice(0, 4).map((h) => `${h.object.name}@${h.distance.toFixed(2)}:${cockpit.pick(h.object)?.control ?? "-"}`);
  };
  const walkPick = (c: string) => c === "sit" || c === "ladder" || c === "tunnel";
  const pickAt = (e: PointerEvent): Pickable | null => {
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObject(cockpit.root, true);
    for (const h of hits) {
      if (h.distance > 12) break;
      const p = cockpit.pick(h.object);
      // seats, ladder and hatch can be picked across the cabin (the crew member walks there)
      if (p && (h.distance <= 2.5 || walkPick(p.control))) return p;
      if ((h.object as THREE.Mesh).isMesh) break; // first solid surface blocks
    }
    return null;
  };

  const controlValue = (p: Pickable): number => {
    const c = fm.controls;
    const i = ((p.data.engine as number) ?? 1) - 1;
    switch (p.control) {
      case "throttle": return c.throttle[i];
      case "jet_throttle": return c.jetThrottle[i];
      case "trim_elevator": return c.trim;
      case "tiller": return c.tiller;
      default: return 0;
    }
  };

  document.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement === el && view === "chase" && flying()) {
      chase.mouse(e.movementX, e.movementY, camera.fov);
      if (ap.engaged && Math.hypot(e.movementX, e.movementY) > 2) ctl({ k: "apoff" });
      return;
    }
    if (document.pointerLockElement === el && crew && gunSight()) {
      crew.yaw -= e.movementX * 0.0025 * (head.fov / 62);
      crew.pitch = Math.max(-1.4, Math.min(1.4, crew.pitch - e.movementY * 0.0025 * (head.fov / 62)));
    }
  });
  el.addEventListener("pointerdown", (e) => {
    if (view === "chase" && flying() && e.button === 0) {
      if (document.pointerLockElement !== el) {
        try { void (el.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {}); } catch { /* not available */ }
      }
      return;
    }
    if (gunSight() && e.button === 0) {
      if (document.pointerLockElement !== el) {
        try { void (el.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {}); } catch { /* not available */ }
      }
      me.firing = true;
      return;
    }
    if (e.button === 2) {
      looking = true;
      el.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0 || view !== "inside") return;
    const p = pickAt(e);
    if (!p) return;
    const cr = crew!;
    if (walkPick(p.control)) {
      if (cr.mode !== "walking") return;
      const it = cr.nearestInteraction();
      let goal: Interaction | null = null;
      if (p.control === "sit") {
        const seat = cr.nav.seats.find((s) => s.name === p.data.sit);
        if (seat) goal = { kind: "seat", seat };
      } else if (p.control === "ladder") goal = { kind: "ladder", ladder: cr.nav.ladders[0] };
      else {
        const t = cr.nav.tunnels[0];
        const end = t.ends.findIndex((x) => x.deck === cr.deck.id);
        if (end >= 0) goal = { kind: "tunnel", tunnel: t, end: end as 0 | 1 };
      }
      if (!goal) return;
      const same = it && it.kind === goal.kind && (it.kind !== "seat" || (goal.kind === "seat" && it.seat === goal.seat));
      if (same && it.kind === "seat") trySit(cr, it.seat.name);
      else if (same && it.kind === "ladder") cr.useLadder(it.ladder);
      else if (same && it.kind === "tunnel") cr.useTunnel(it.tunnel, it.end);
      else if (!cr.goTo(goal)) say("No way there from here");
      return;
    }
    if (!flying()) return;
    const c = fm.controls;
    switch (p.control) {
      case "yoke_pitch":
      case "yoke_roll":
        input.mouseYoke = !input.mouseYoke;
        return;
      case "gear": ctl({ k: "gear", v: !c.gearDown }); return;
      case "parking_brake": ctl({ k: "brake", v: !c.parkingBrake }); return;
      case "flaps":
        ctl({ k: "flaps", v: Math.max(0, Math.min(1, Math.round((c.flaps + (e.shiftKey ? -0.25 : 0.25)) * 4) / 4)) });
        return;
      case "pedal": return;
    }
    drag = { pick: p, startY: e.clientY, startX: e.clientX, start: controlValue(p), all: e.shiftKey };
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener("pointermove", (e) => {
    if (input.mouseYoke) {
      const dz = (v: number) => (Math.abs(v) < 0.04 ? 0 : v);
      input.mouseYokeXY.x = dz(Math.max(-1, Math.min(1, ((e.clientX / window.innerWidth) * 2 - 1) * 1.6)));
      input.mouseYokeXY.y = dz(Math.max(-1, Math.min(1, ((e.clientY / window.innerHeight) * 2 - 1) * -1.6)));
      yokeDot.style.left = `${e.clientX}px`;
      yokeDot.style.top = `${e.clientY}px`;
    }
    if (looking && view === "inside" && crew) {
      crew.yaw -= e.movementX * 0.004;
      if (crew.mode === "seated") crew.yaw = Math.max(-2.6, Math.min(2.6, crew.yaw));
      crew.pitch = Math.max(-1.3, Math.min(1.3, crew.pitch - e.movementY * 0.004));
      return;
    }
    if (drag) {
      const dv = (drag.startY - e.clientY) * 0.004;
      const p = drag.pick;
      const i = ((p.data.engine as number) ?? 1) - 1;
      switch (p.control) {
        case "throttle": ctl({ k: "throttle", i, all: drag.all, v: drag.start + dv }); break;
        case "jet_throttle": ctl({ k: "jet", i, all: drag.all, v: drag.start + dv }); break;
        case "trim_elevator": ctl({ k: "trim", v: drag.start + dv * 0.5 }); break;
        case "tiller": ctl({ k: "tiller", v: drag.start + (e.clientX - drag.startX) * 0.004 }); break;
      }
      return;
    }
    if (view === "inside") {
      let p = pickAt(e);
      if (p && !walkPick(p.control) && !flying()) p = null;
      if (p && walkPick(p.control) && crew?.mode !== "walking") p = null;
      el.style.cursor = p ? "pointer" : "default";
      label.textContent = p ? describe(p) : "";
    }
  });

  const end = (e: PointerEvent) => {
    looking = false;
    if (e.button === 0) me.firing = false;
    if (drag?.pick.control === "tiller") ctl({ k: "tiller", v: 0 }); // spring-centred
    drag = null;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("wheel", (e) => {
    if (view === "chase" && flying()) { chase.wheel(e.deltaY); return; }
    if (!aboard()) return;
    if (gunSight() && !e.shiftKey) { gunsight.wheel(e.deltaY); return; }
    head.fov = Math.max(25, Math.min(80, head.fov + Math.sign(e.deltaY) * 4));
    camera.fov = head.fov;
    camera.updateProjectionMatrix();
  }, { passive: true });
}

function describe(p: Pickable): string {
  const n = p.data.engine as number | undefined;
  switch (p.control) {
    case "throttle": return `Engine ${n} throttle (drag; Shift+drag moves all)`;
    case "jet_throttle": return `Jet ${n} throttle (drag; Shift+drag moves all)`;
    case "yoke_pitch":
    case "yoke_roll": return "Control wheel (click: mouse yoke on/off)";
    case "gear": return `Landing gear lever: ${fm.controls.gearDown ? "DOWN" : "UP"} (click)`;
    case "flaps": return "Wing flap switch (click: down, Shift+click: up)";
    case "parking_brake": return `Parking brake: ${fm.controls.parkingBrake ? "SET" : "OFF"} (click)`;
    case "trim_elevator": return "Elevator trim wheel (drag)";
    case "tiller": return "Nose wheel steering (drag sideways)";
    case "pedal": return "Rudder pedals (Q / E)";
    case "sit": return `Seat: ${String(p.data.sit).replace("Seat_", "")} (click to sit)`;
    case "ladder": return "Ladder between decks (click or E at either end)";
    case "tunnel": return "Crawl tunnel over the bomb bays (click or E at the hatch)";
    default: return p.control;
  }
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
