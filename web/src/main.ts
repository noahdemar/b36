import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Aircraft, defaultAircraftState, loadGltf } from "./aircraft";
import { Cockpit, type Pickable } from "./cockpit";
import { Crew, type NavData } from "./crew";
import { KEY_HELP, KeyboardInput } from "./input";
import { FlightModel } from "./sim/flightmodel";
import { World } from "./world";

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.03, 60_000);
const world = new World(scene, renderer);

const hud = document.getElementById("hud")!;
const help = document.getElementById("help")!;
const label = document.getElementById("label")!;
const yokeDot = document.getElementById("yoke")!;
help.innerHTML = "<b>B-36 flight deck</b><table>" + KEY_HELP.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("") + "</table>";

const fm = new FlightModel();
const debugHook = { fm } as Record<string, unknown>;
(window as unknown as { b36: unknown }).b36 = debugHook; // debug/test hook
const input = new KeyboardInput();
const aircraftRoot = new THREE.Group();
scene.add(aircraftRoot);

type View = "inside" | "outside";
let view: View = "inside";
const head = { fov: 62 };
let crew: Crew | null = null;
debugHook.camera = camera;
debugHook.scene = scene;
const eyeLocal = new THREE.Vector3();
const STATION_NAMES: Record<string, string> = {
  aircraft_commander: "Aircraft commander", pilot: "Pilot", flight_engineer: "Flight engineer",
  radio_operator: "Radio operator", radar_observer: "Radar observer", navigator: "Navigator",
};
let orbit: OrbitControls | null = null;
let showHud = true;
let extFrames: THREE.Object3D | null = null;

function resetOnRunway() {
  fm.placeOnGround(new THREE.Vector3(0, 0, 0), 0);
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
    orbit.target.copy(aircraftRoot.position);
    camera.position.copy(aircraftRoot.position).add(new THREE.Vector3(-55, 18, 45));
    camera.fov = 45;
  } else {
    orbit?.dispose();
    orbit = null;
    camera.near = 0.03;
    camera.fov = head.fov;
  }
  camera.updateProjectionMatrix();
}

/** Flight inputs reach the sim only from a pilot seat. */
function flying() {
  return view === "inside" && crew?.mode === "seated" && !!crew.seat?.flies;
}

// Model files; the hosted build overrides these with JSON-embedded variants (see web/artifact/build.sh).
const MODELS = (window as unknown as { B36_MODELS?: { exterior: string; interior: string } }).B36_MODELS
  ?? { exterior: "models/b36.gltf", interior: "models/b36_interior.glb" };
const navReq = fetch("models/b36_nav.json").then((r) => r.json() as Promise<NavData>);
Promise.all([loadGltf(MODELS.exterior), loadGltf(MODELS.interior), navReq]).then(([ext, int, nav]) => {
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
    // stowed turrets sit inside the forward cabin; hide them from the cabin view
    if (o.name.startsWith("Turret_UpperFwd")) o.visible = false;
  });
  int.traverse((o) => {
    if (o instanceof THREE.Mesh) (o.material as THREE.MeshStandardMaterial).envMapIntensity = 0.12;
  });
  extFrames = ext.getObjectByName("CanopyFrame") ?? null;
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
    if (pressed.has("KeyC")) setView(view === "inside" ? "outside" : "inside");
    if (view === "inside" && pressed.has("KeyX") && cr.mode === "seated") cr.standUp();
    if (view === "inside" && pressed.has("KeyE") && cr.mode === "walking") {
      const it = cr.nearestInteraction();
      if (it?.kind === "seat") cr.sit(it.seat.name);
      else if (it?.kind === "ladder") cr.useLadder(it.ladder);
    }
    if (pressed.has("KeyR")) resetOnRunway();
    if (pressed.has("KeyH")) {
      showHud = !showHud;
      help.style.display = showHud ? "block" : "none";
    }
    if (flying()) input.apply(fm.controls, dt, pressedList);
    else input.neutral(fm.controls, dt);
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
      fm.step(STEP, 2);
      acc -= STEP;
    }

    // Aircraft pose with floating origin: CG stays at x = z = 0.
    const off = fm.modelOffset.applyQuaternion(fm.quat);
    const prev = aircraftRoot.position.clone();
    aircraftRoot.position.set(off.x, fm.pos.y + off.y, off.z);
    aircraftRoot.quaternion.copy(fm.quat);
    world.follow(fm.pos);
    world.aimSun(aircraftRoot.position);

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

    if (view === "inside") {
      aircraftRoot.updateMatrixWorld(true);
      const ang = cr.eye(eyeLocal);
      camera.position.copy(eyeLocal).applyMatrix4(aircraftRoot.matrixWorld);
      const look = new THREE.Quaternion().setFromEuler(new THREE.Euler(ang.pitch, ang.yaw, 0, "YXZ"));
      camera.quaternion.copy(aircraftRoot.quaternion).multiply(look);
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
        `${c.parkingBrake ? "   PARK BRAKE" : ""}${input.mouseYoke ? "   MOUSE YOKE" : ""}\n` +
        crewStatus(cr);
    }
    yokeDot.style.display = input.mouseYoke ? "block" : "none";
    renderer.render(scene, camera);
  });
});

function crewStatus(cr: Crew): string {
  if (view !== "inside") return "OUTSIDE VIEW";
  if (cr.mode === "seated" && cr.seat) {
    const name = STATION_NAMES[cr.seat.station] ?? cr.seat.station;
    return `${name.toUpperCase()} SEAT   X: stand up${cr.seat.flies ? "" : "   (station not functional yet)"}`;
  }
  if (cr.mode === "climbing") return "ON LADDER";
  const it = cr.nearestInteraction();
  const hint = it?.kind === "seat" ? `   E: sit (${STATION_NAMES[it.seat.station] ?? it.seat.station})`
    : it?.kind === "ladder" ? `   E: ${cr.deck.id === it.ladder.lower ? "climb up" : "climb down"}` : "";
  return `WALKING, ${cr.deck.id === "upper" ? "FLIGHT DECK" : "LOWER DECK"}${hint}`;
}

// ---------------------------------------------------------------- pointer: look, pick, drag

function setupPointer(cockpit: Cockpit) {
  const el = renderer.domElement;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let looking = false;
  let drag: { pick: Pickable; startY: number; startX: number; start: number; all: boolean } | null = null;
  el.addEventListener("contextmenu", (e) => e.preventDefault());

  const pickAt = (e: PointerEvent): Pickable | null => {
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObject(cockpit.root, true);
    for (const h of hits) {
      if (h.distance > 2.5) break;
      const p = cockpit.pick(h.object);
      if (p) return p;
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

  el.addEventListener("pointerdown", (e) => {
    if (e.button === 2) {
      looking = true;
      el.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0 || view !== "inside") return;
    const p = pickAt(e);
    if (!p) return;
    const cr = crew!;
    if (p.control === "sit" || p.control === "ladder") {
      if (cr.mode !== "walking") return;
      const it = cr.nearestInteraction();
      if (p.control === "sit") {
        const seat = cr.nav.seats.find((s) => s.name === p.data.sit);
        if (seat && Math.hypot(seat.stand[0] - cr.pos.x, seat.stand[2] - cr.pos.z) < 2.0) cr.sit(seat.name);
      } else if (it?.kind === "ladder") cr.useLadder(it.ladder);
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
      if (p && p.control !== "sit" && p.control !== "ladder" && !flying()) p = null;
      if (p && (p.control === "sit" || p.control === "ladder") && crew?.mode !== "walking") p = null;
      el.style.cursor = p ? "pointer" : "default";
      label.textContent = p ? describe(p) : "";
    }
  });

  const end = (e: PointerEvent) => {
    looking = false;
    if (drag?.pick.control === "tiller") fm.controls.tiller = 0; // spring-centred
    drag = null;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("wheel", (e) => {
    if (view !== "inside") return;
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
    default: return p.control;
  }
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
