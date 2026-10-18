import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Aircraft, defaultAircraftState, loadGltf } from "./aircraft";
import { Cockpit, type Pickable } from "./cockpit";
import { Crew, type Interaction, type NavData } from "./crew";
import { DamageFX } from "./damagefx";
import { Flak } from "./flak";
import { Engineer, engineWarnings } from "./engineer";
import { KEY_HELP, KeyboardInput } from "./input";
import { BombingRange, RANGE_CENTER } from "./range";
import { Autopilot } from "./sim/autopilot";
import { bearingTo, mountDisplays, NavChart, RadarScope, WAYPOINTS } from "./stations";
import { FlightModel } from "./sim/flightmodel";
import { BombSystem } from "./weapons/bombs";
import { findTurrets, Rounds, type Turret } from "./weapons/turrets";
import { clockCall, Fighters } from "./weapons/fighters";
import { DefensiveFire } from "./weapons/gunnery";
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
let lastStation = "";
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
  if (wp) { chart.waypoint = wp; say(`NAVIGATOR: new mark, ${(bearingTo(fm.pos.x, fm.pos.z, wp.x, wp.z).dist / 1609.344).toFixed(1)} mi`); }
});
let bombs: BombSystem | null = null;
let range: BombingRange | null = null;
let sightView = false;
let noseGuns = false; // radar observer seat: nose turret control instead of the bombsight
let firing = false;
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
function say(msg: string) {
  crewMsg = msg;
  crewMsgT = 4;
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
  fm.feAuto = fm.fuel.auto = !atStation("flight_engineer");
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

function atStation(station: string) {
  return aboard() && crew?.mode === "seated" && crew.seat?.station === station;
}

/** The gun sight in use, if the crew member is at a gunnery station. */
function gunSight() {
  if (!aboard() || crew?.mode !== "seated" || !crew.seat?.sight) return null;
  if (crew.seat.station === "radar_observer" && !noseGuns) return null;
  return crew.seat.sight;
}

/** Flight inputs reach the sim only from a pilot seat. */
function flying() {
  return aboard() && crew?.mode === "seated" && !!crew.seat?.flies;
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

  resetOnRunway();
  setupPointer(cockpit);
  const vis = defaultAircraftState();
  const clock = new THREE.Clock();
  let acc = 0;
  const STEP = 1 / 120;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    const pressedList = input.takePressed();
    const pressed = new Set(pressedList);
    const cr = crew!;
    if (pressed.has("KeyC")) {
      // from a pilot or gun station C toggles third person; elsewhere the free outside camera
      const thirdOk = cr.mode === "seated" && (!!cr.seat?.flies || !!gunSight());
      setView(view !== "inside" ? "inside" : thirdOk ? "chase" : "outside");
      if (view === "chase") say(cr.seat?.flies ? "THIRD PERSON: the mouse aims, the aircraft follows (click to capture the mouse; W/S/A/D override; M mouse aim on/off; C cockpit)"
        : "THIRD PERSON GUNNER: the mouse aims, hold left button or Space to fire, wheel sets range; C back to the sight");
    }
    if (view === "chase" && (cr.mode !== "seated" || (!cr.seat?.flies && !gunSight()))) setView("inside");
    if (aboard() && pressed.has("KeyX") && cr.mode === "seated") { cr.standUp(); if (view === "chase") setView("inside"); }
    if (view === "inside" && pressed.has("KeyE") && cr.mode === "walking") {
      const it = cr.nearestInteraction();
      if (it?.kind === "seat") cr.sit(it.seat.name);
      else if (it?.kind === "ladder") cr.useLadder(it.ladder);
      else if (it?.kind === "tunnel") cr.useTunnel(it.tunnel, it.end);
    }
    if (pressed.has("Tab") && view === "inside") toggleStations();
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
    if (cr.mode !== "seated") { noseGuns = false; firing = false; if (document.pointerLockElement) document.exitPointerLock(); }
    const gs = gunSight();
    if (atStation("radar_observer") && pressed.has("KeyT")) { noseGuns = !noseGuns; sightView = false; cr.yaw = 0; cr.pitch = -0.1; }
    if (gs && pressed.has("KeyU")) {
      const ts = gs.turrets.map((n) => turrets.get(n)!).filter(Boolean);
      const out = !ts.every((t) => t.extendCmd);
      for (const t of ts) t.extendCmd = out;
      say(ts.some((t) => t.retract > 0) ? (out ? "TURRETS EXTENDING" : "TURRETS RETRACTING") : "THIS TURRET IS FIXED (ALWAYS READY)");
    }
    if (pressed.has("KeyR")) resetOnRunway();
    if (pressed.has("KeyR+S")) { resetOnRunway(true); say("COLD AND DARK: engines off. Start them from the flight engineer's seat (behind the right pilot)."); }
    // flight engineer: sitting down takes over from the automatic engineer
    const station = cr.mode === "seated" && aboard() ? cr.seat?.station ?? "" : "";
    if (station !== lastStation) {
      if (station === "flight_engineer") {
        fm.feAuto = false;
        fm.fuel.auto = false;
        say("FLIGHT ENGINEER: you have the panel (automatic engineer off; J hands it back)");
      } else if (lastStation === "flight_engineer") {
        engineer.release(fm);
        fm.feAuto = fm.fuel.auto = true;
        say("Automatic engineer back on the panel (cowl flaps, tank sequencing)");
      }
      lastStation = station;
    }
    if (station === "flight_engineer") {
      const m = engineer.update(fm, input, pressedList, dt);
      if (m) say(m);
    }
    // navigator: waypoints, chart scale, autopilot coupling
    if (station === "navigator") {
      for (const [k, i] of [["Digit1", 0], ["Digit2", 1], ["Digit3", 2]] as const) {
        if (pressed.has(k)) { chart.waypoint = WAYPOINTS[i]; say(`NAVIGATOR: course to ${chart.waypoint.name}`); }
      }
      if (pressed.has("PageUp")) chart.zoom(-1);
      if (pressed.has("PageDown")) chart.zoom(1);
      if (pressed.has("KeyV")) bigDisplay = bigDisplay === "chart" ? null : "chart";
      if (pressed.has("Enter")) {
        chart.coupled = !chart.coupled;
        if (chart.coupled && !ap.engaged) ap.engage(fm);
        say(chart.coupled ? `AUTOPILOT COUPLED: steering to ${chart.waypoint.name}` : "AUTOPILOT UNCOUPLED from the navigator");
      }
    }
    if (chart.coupled) {
      const w = bearingTo(fm.pos.x, fm.pos.z, chart.waypoint.x, chart.waypoint.z);
      if (!ap.engaged) chart.coupled = false;
      else if (w.dist < 1500) { chart.coupled = false; say(`NAVIGATOR: over ${chart.waypoint.name}, holding heading`); }
      else ap.headingDeg = w.brg;
    }
    // radar observer: scope range and gain (the bombsight keys stay as they are)
    if (station === "radar_observer" && !noseGuns) {
      if (pressed.has("KeyB")) bigDisplay = bigDisplay === "scope" ? null : "scope";
      if (pressed.has("PageUp")) scope.setRange(1);
      if (pressed.has("PageDown")) scope.setRange(-1);
      if (input.isDown("BracketRight")) scope.gain = Math.min(1, scope.gain + 0.4 * dt);
      if (input.isDown("BracketLeft")) scope.gain = Math.max(0, scope.gain - 0.4 * dt);
    }
    if ((bigDisplay === "chart" && station !== "navigator") || (bigDisplay === "scope" && (station !== "radar_observer" || noseGuns))) bigDisplay = null;
    if (pressed.has("KeyN")) startBombRun();
    if (pressed.has("KeyL")) startFighterAttack();
    if (pressed.has("KeyT+S")) {
      const i = (TIMES.indexOf(world.hours) + 1) % TIMES.length;
      world.setTime(TIMES[i]);
      const h = Math.floor(TIMES[i]), m = Math.round((TIMES[i] - h) * 60);
      say(`TIME OF DAY ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
    if (gs && pressed.has("KeyG") && !gs.aft) { gunsight.assist = !gunsight.assist; say(gunsight.assist ? "RANGE ASSIST ON (game aid: the ring frames the nearest fighter)" : "MANUAL RANGING"); }
    // autopilot: Z from the pilot seats or the bombardier; yoke input disengages it
    if (pressed.has("KeyZ") && (flying() || atStation("radar_observer"))) {
      if (ap.engaged) ap.disengage();
      else ap.engage(fm);
      say(ap.engaged ? `AUTOPILOT ON: ${ap.altitudeFt.toFixed(0)} ft, heading ${ap.headingDeg.toFixed(0)}` : "AUTOPILOT OFF");
    }
    if (ap.engaged && flying() && ["KeyW", "KeyS", "KeyA", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].some((k) => pressed.has(k))) {
      ap.disengage();
      say("AUTOPILOT OFF (yoke input)");
    }
    // bombardier / bomb controls (doors also from the pilot seats)
    const bombardier = atStation("radar_observer");
    if (pressed.has("KeyO") && (bombardier || flying())) {
      fm.controls.bombDoors = fm.controls.bombDoors > 0.5 ? 0 : 1;
      say(fm.controls.bombDoors ? "BOMB DOORS OPENING" : "BOMB DOORS CLOSING");
    }
    if (bombardier && bombs && !noseGuns) {
      if (pressed.has("KeyK")) { bombs.armed = !bombs.armed; say(bombs.armed ? "BOMBS ARMED" : "BOMBS SAFE"); }
      if (pressed.has("KeyM")) {
        bombs.mode = bombs.mode === "single" ? "train" : bombs.mode === "train" ? "salvo" : "single";
        say(`RELEASE MODE: ${bombs.mode.toUpperCase()}`);
      }
      if (pressed.has("KeyV")) sightView = !sightView;
      if (pressed.has("Space")) {
        aircraftRoot.updateMatrixWorld(true);
        say(bombs.release(fm, aircraftRoot.matrixWorld));
      }
      if (ap.engaged) {
        const k = (input.isDown("KeyD") ? 1 : 0) - (input.isDown("KeyA") ? 1 : 0);
        if (k) ap.turn(k * 2 * dt); // 2 deg/s course correction through the autopilot
      }
    } else sightView = false;
    if (pressed.has("KeyH")) {
      showHud = !showHud;
      help.style.display = showHud ? "block" : "none";
    }
    if (flying()) {
      input.apply(fm.controls, dt, pressedList);
      if (view === "chase") {
        if (pressed.has("KeyM")) { mouseAim = !mouseAim; instructor.reset(fm); say(mouseAim ? "MOUSE AIM ON" : "MOUSE AIM OFF: direct controls"); }
        const keys = ["KeyW", "KeyS", "KeyA", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].some((k) => input.isDown(k));
        if (mouseAim && !ap.engaged && !keys) instructor.update(fm, dt, chase.aimDir());
        else if (keys) { chase.resetTo(fm.quat); instructor.reset(fm); } // keys override; the aim follows the nose
      }
    } else input.neutral(fm.controls, dt);
    if (view === "inside" && cr.mode !== "seated") {
      const k = (...codes: string[]) => codes.some((c) => input.isDown(c));
      cr.update(dt, {
        forward: (k("KeyW", "ArrowUp") ? 1 : 0) - (k("KeyS", "ArrowDown") ? 1 : 0),
        strafe: (k("KeyD", "ArrowRight") ? 1 : 0) - (k("KeyA", "ArrowLeft") ? 1 : 0),
        run: k("ShiftLeft", "ShiftRight"),
        crouch: k("ControlLeft", "ControlRight"),
      });
    }
    if (extFrames) extFrames.visible = view !== "inside";
    acc += dt;
    while (acc >= STEP) {
      ap.update(fm, STEP);
      fm.step(STEP, 2);
      flak.update(fm, STEP);
      acc -= STEP;
    }
    // aircraft pose with floating origin (CG at x = z = 0) before anything is placed relative to it
    {
      const off = fm.modelOffset.applyQuaternion(fm.quat);
      aircraftRoot.position.set(off.x, fm.pos.y + off.y, off.z);
      aircraftRoot.quaternion.copy(fm.quat);
    }
    aircraftRoot.updateMatrixWorld(true);
    bombs?.update(fm, aircraftRoot.matrixWorld, dt);
    frameDt = dt;
    updateRaid(dt);
    fighters?.update(fm, dt);
    // turrets: the manned station follows the computing sight, AI gunners man the rest
    const sightNow = gunSight();
    const fireNow = firing || (sightNow !== null && input.isDown("Space"));
    let aimFor: ((t: Turret, pivotW: THREE.Vector3) => THREE.Vector3 | null) | null = null;
    if (sightNow && cr.seat) {
      const q = aircraftRoot.quaternion;
      const eyeW = new THREE.Vector3(...sightNow.eye).applyMatrix4(aircraftRoot.matrixWorld).add(new THREE.Vector3(fm.pos.x, 0, fm.pos.z));
      let dirW = new THREE.Vector3(0, 0, -1).applyQuaternion(q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(cr.pitch, cr.seat.yaw + cr.yaw, 0, "YXZ"))));
      if (view === "chase") {
        // third person: the crosshair is on the camera's axis; lay the sight line through that point
        const cam = new THREE.Vector3(fm.pos.x, fm.pos.y, fm.pos.z).addScaledVector(dirW, -GUN_CHASE.dist).add(new THREE.Vector3(0, GUN_CHASE.dist * GUN_CHASE.lift, 0));
        dirW = cam.addScaledVector(dirW, gunsight.range).sub(eyeW).normalize();
      }
      aimFor = gunsight.compute(dt, fm, q, eyeW, dirW, fighters, !!sightNow.aft);
    } else gunsight.reset();
    defense?.update(fm, dt, sightNow ? { turrets: sightNow.turrets, aimFor, fire: fireNow } : null);
    weaponEffects(dt, cr);
    rounds?.update(dt);
    fx?.update(fm, dt, window.innerHeight / (2 * Math.tan((camera.fov * Math.PI) / 360)));
    const ev = fm.damage.events[0];
    if (ev && ev !== lastEvent) {
      for (const e of fm.damage.events) { if (e === lastEvent) break; if (e.severe) { say(e.msg.toUpperCase()); break; } }
      lastEvent = ev;
    }
    if (trolley && cr.tunnel) {
      const e = new THREE.Vector3();
      cr.eye(e);
      const [z0, z1] = cr.tunnel.t.trolley;
      trolley.position.z = Math.max(z0, Math.min(z1, e.z));
    }
    range?.update(dt);
    crewMsgT -= dt;
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
    if (!fm.damage.crashed && fm.pos.y < terrainHeight(fm.pos.x, fm.pos.z) + 3) fm.damage.crash(fm, "flew into terrain");
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
        (atStation("flight_engineer") ? engineer.status(fm) : engineWarnings(fm)) +
        (atStation("navigator") ? navStatus() : "") +
        (atStation("radar_observer") && !noseGuns ? `\nRADAR ${scope.rangeMi} MI  GAIN ${(scope.gain * 100).toFixed(0)}   B scope view  PgUp/PgDn range  [ ] gain  (yellow cross: bomb impact)` : "") +
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
  });
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
    fx?.fire.spawn(muzzle, ft.vel, gun === 0 ? 3 : 1.8, 4, 0.05, 1, [1.0, 0.85, 0.5]);
    if (gun === 0 || Math.random() < 0.5) sound.enemyGun(muzzle.distanceTo(listener()), gun === 0);
  };
  f.onHit = (h) => {
    const w = toWorldPt(h.pointModel.clone().applyMatrix4(aircraftRoot.matrixWorld));
    fx?.sparks(w, fm.vel, h.big);
    fx?.holeAlong(h.fromModel, h.pointModel, h.big);
    const d = w.distanceTo(listener());
    sound.hit(d, h.big);
    if (fx && d < 14 && view === "inside") fx.shake = Math.max(fx.shake, (h.big ? 0.7 : 0.35) * (1 - d / 14));
  };
  f.onStruck = (ft, tag, killed) => {
    fx?.sparks(ft.pos, ft.vel, killed);
    if (tag === 0) gunsight.notify(killed ? "KILL" : "HIT", killed ? "#ff7050" : "#ffd27a");
    if (killed) {
      if (tag === 0) { gunsight.kills++; say("YOU GOT HIM! MiG going down"); }
      else say(`${["TAIL", "UPPER AFT", "LOWER AFT", "NOSE"][Math.floor(Math.random() * 4)]} GUNNER: got one, MiG going down!`);
    }
  };
  f.onExplode = (ft) => {
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
  const firingNow = fireNow && (defense?.shots.some((s) => s.player) ?? false);
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
      if (ap.engaged && Math.hypot(e.movementX, e.movementY) > 2) { ap.disengage(); say("AUTOPILOT OFF (mouse aim)"); }
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
      firing = true;
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
      if (same && it.kind === "seat") cr.sit(it.seat.name);
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
      case "gear": c.gearDown = !c.gearDown; return;
      case "parking_brake": c.parkingBrake = !c.parkingBrake; return;
      case "flaps":
        c.flaps = Math.max(0, Math.min(1, Math.round((c.flaps + (e.shiftKey ? -0.25 : 0.25)) * 4) / 4));
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
      const c = fm.controls;
      const dv = (drag.startY - e.clientY) * 0.004;
      const p = drag.pick;
      const i = ((p.data.engine as number) ?? 1) - 1;
      const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
      switch (p.control) {
        case "throttle":
          if (drag.all) c.throttle.fill(clamp01(drag.start + dv));
          else c.throttle[i] = clamp01(drag.start + dv);
          break;
        case "jet_throttle":
          if (drag.all) c.jetThrottle.fill(clamp01(drag.start + dv));
          else c.jetThrottle[i] = clamp01(drag.start + dv);
          break;
        case "trim_elevator":
          c.trim = Math.max(-1, Math.min(1, drag.start + dv * 0.5));
          break;
        case "tiller":
          c.tiller = Math.max(-1, Math.min(1, drag.start + (e.clientX - drag.startX) * 0.004));
          break;
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
    if (e.button === 0) firing = false;
    if (drag?.pick.control === "tiller") fm.controls.tiller = 0; // spring-centred
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
