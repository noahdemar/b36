import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Aircraft, defaultAircraftState, loadGltf } from "./aircraft";
import { Cockpit, type Pickable } from "./cockpit";
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

type View = "cockpit" | "outside";
let view: View = "cockpit";
const head = { yaw: 0, pitch: -0.12, fov: 62 };
debugHook.head = head;
debugHook.camera = camera;
debugHook.scene = scene;
const eyeLocal = new THREE.Vector3();
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

const MODEL_EXT = (window as unknown as { B36_MODEL_EXT?: string }).B36_MODEL_EXT ?? "glb";
Promise.all([loadGltf(`models/b36.${MODEL_EXT}`), loadGltf(`models/b36_interior.${MODEL_EXT}`)]).then(([ext, int]) => {
  const aircraft = new Aircraft(ext);
  const cockpit = new Cockpit(int);
  aircraftRoot.add(ext, int);
  ext.traverse((o) => {
    if (o instanceof THREE.Mesh && (o.material as THREE.Material).transparent) o.castShadow = false;
    // stowed turrets sit inside the forward cabin; hide them from the cabin view
    if (o.name.startsWith("Turret_UpperFwd")) o.visible = false;
  });
  int.traverse((o) => {
    if (o instanceof THREE.Mesh) (o.material as THREE.MeshStandardMaterial).envMapIntensity = 0.12;
  });
  extFrames = ext.getObjectByName("CanopyFrame") ?? null;
  aircraftRoot.updateMatrixWorld(true);
  const eye = cockpit.eyes.get("Seat_AC")!;
  eye.getWorldPosition(eyeLocal);
  aircraftRoot.worldToLocal(eyeLocal);

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
    if (pressed.has("KeyC")) setView(view === "cockpit" ? "outside" : "cockpit");
    if (pressed.has("KeyR")) resetOnRunway();
    if (pressed.has("KeyH")) {
      showHud = !showHud;
      help.style.display = showHud ? "block" : "none";
    }
    input.apply(fm.controls, dt, pressedList);
    if (extFrames) extFrames.visible = view !== "cockpit";
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

    if (view === "cockpit") {
      aircraftRoot.updateMatrixWorld(true);
      camera.position.copy(eyeLocal).applyMatrix4(aircraftRoot.matrixWorld);
      const look = new THREE.Quaternion().setFromEuler(new THREE.Euler(head.pitch, head.yaw, 0, "YXZ"));
      camera.quaternion.copy(aircraftRoot.quaternion).multiply(look);
    } else if (orbit) {
      const delta = aircraftRoot.position.clone().sub(prev);
      camera.position.add(delta);
      orbit.target.copy(aircraftRoot.position);
      orbit.update();
    }

    const r = fm.readout;
    if (showHud) {
      hud.textContent =
        `IAS ${r.ias_mph.toFixed(0)} mph   ALT ${r.alt_ft.toFixed(0)} ft   VS ${r.vs_fpm.toFixed(0)} fpm   HDG ${r.heading_deg.toFixed(0)}\n` +
        `PISTON ${(c.throttle[0] * 100).toFixed(0)}%   JETS ${c.jetThrottle[0] > 0 ? (c.jetThrottle[0] * 100).toFixed(0) + "%" : "OFF"}   ` +
        `TRIM ${(c.trim * 100).toFixed(0)}   FLAPS ${(fm.flapPos * 100).toFixed(0)}%   GEAR ${fm.gearPos > 0.99 ? "DOWN" : fm.gearPos < 0.01 ? "UP" : "MOVING"}` +
        `${c.parkingBrake ? "   PARK BRAKE" : ""}${input.mouseYoke ? "   MOUSE YOKE" : ""}`;
    } else hud.textContent = "";
    yokeDot.style.display = input.mouseYoke ? "block" : "none";
    renderer.render(scene, camera);
  });
});

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
    if (e.button !== 0 || view !== "cockpit") return;
    const p = pickAt(e);
    if (!p) return;
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
    if (looking && view === "cockpit") {
      head.yaw = Math.max(-2.6, Math.min(2.6, head.yaw - e.movementX * 0.004));
      head.pitch = Math.max(-1.3, Math.min(1.3, head.pitch - e.movementY * 0.004));
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
    if (view === "cockpit") {
      const p = pickAt(e);
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
    if (view !== "cockpit") return;
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
    default: return p.control;
  }
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
