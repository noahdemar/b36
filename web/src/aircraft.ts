import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/** Visual state of the exterior model. Angles in radians, ratios 0..1. */
export interface AircraftState {
  aileron: number; // -1..1, + = roll right
  elevator: number; // -1..1, + = nose up
  rudder: number; // -1..1, + = nose right
  flaps: number; // 0..1
  gear: number; // 0 = up, 1 = down
  bombDoors: number[]; // per bay 0..1
  propRpm: number[]; // 6 entries, engine 1 (left outboard) .. 6 (right outboard)
  cowl: number[]; // 6, cowl flap opening 0..1
  feather: boolean[]; // 6
  running: boolean[]; // 6
  power: number[]; // 6, fraction of takeoff power
  jetN: number[]; // 4, jet spool 0..1, left outboard first
  tas: number; // m/s, for the propeller blade angle
  steer: number; // rad, nose wheel steering, + = right
  legs: { name: string; comp: number; roll: number }[]; // FlightModel.legContacts()
  night: number; // 0 = day .. 1 = dark, for exhaust glow
}

export function defaultAircraftState(): AircraftState {
  return {
    aileron: 0, elevator: 0, rudder: 0, flaps: 0, gear: 1,
    bombDoors: [0, 0, 0, 0], propRpm: [0, 0, 0, 0, 0, 0],
    cowl: [1, 1, 1, 1, 1, 1], feather: [false, false, false, false, false, false],
    running: [false, false, false, false, false, false], power: [0, 0, 0, 0, 0, 0], jetN: [0, 0, 0, 0],
    tas: 0, steer: 0, legs: [], night: 0,
  };
}

export interface Part {
  node: THREE.Object3D;
  axis: THREE.Vector3;
  base: THREE.Quaternion;
  data: Record<string, unknown>;
}

/** Collect nodes carrying glTF extras with an `axis` (animated parts). */
export function collectParts(root: THREE.Object3D, key: string): Map<string, Part> {
  const parts = new Map<string, Part>();
  root.traverse((o) => {
    const d = o.userData as Record<string, unknown>;
    if (d[key] !== undefined && Array.isArray(d.axis)) {
      const [x, y, z] = d.axis as number[];
      parts.set(o.name, { node: o, axis: new THREE.Vector3(x, y, z).normalize(), base: o.quaternion.clone(), data: d });
    }
  });
  return parts;
}

const tmpQ = new THREE.Quaternion();
export function rotatePart(p: Part | undefined, angle: number) {
  if (!p) return;
  tmpQ.setFromAxisAngle(p.axis, angle);
  p.node.quaternion.copy(p.base).multiply(tmpQ);
}

const MAX_SURFACE = THREE.MathUtils.degToRad(25);
const MAX_FLAP = THREE.MathUtils.degToRad(40);

/** Rebuild a GLB from glTF JSON whose single buffer is an embedded base64 data URI. */
function jsonToGlb(gltf: { buffers: { uri?: string; byteLength: number }[] }): ArrayBuffer {
  const uri = gltf.buffers[0].uri ?? "";
  const bin = Uint8Array.from(atob(uri.slice(uri.indexOf(",") + 1)), (ch) => ch.charCodeAt(0));
  delete gltf.buffers[0].uri;
  const pad = (n: number) => (n + 3) & ~3;
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jl = pad(json.length), bl = pad(bin.length);
  const out = new ArrayBuffer(12 + 8 + jl + 8 + bl);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.byteLength, true);
  dv.setUint32(12, jl, true); dv.setUint32(16, 0x4e4f534a, true);
  u8.fill(0x20, 20, 20 + jl); u8.set(json, 20);
  dv.setUint32(20 + jl, bl, true); dv.setUint32(24 + jl, 0x004e4942, true);
  u8.set(bin, 28 + jl);
  return out;
}

/** Load a .glb, or a .json glTF with an embedded buffer (used where .glb cannot be served). */
export async function loadGltf(url: string) {
  const loader = new GLTFLoader();
  if (url.endsWith(".json")) {
    const gltf = await (await fetch(url)).json();
    const base = url.slice(0, url.lastIndexOf("/") + 1); // external textures resolve next to the file
    return (await loader.parseAsync(jsonToGlb(gltf), base)).scene;
  }
  return (await loader.loadAsync(url)).scene;
}

// Propeller blade angle at 0.75 R. The governor holds the blade at a small angle of attack to the
// relative wind; fine-pitch stop, feathered angle, angle of attack and pitch-change rate are ESTIMATED
// (no B-36 / Curtiss Electric figures found). Reverse pitch is not modelled by the sim.
const PROP_GEAR = 0.375; // R-4360 prop reduction gear (ESTIMATED)
const BLADE_AOA = THREE.MathUtils.degToRad(4);
const BLADE_FINE = THREE.MathUtils.degToRad(14);
const BLADE_FEATHER = THREE.MathUtils.degToRad(88);
const BLADE_RATE = THREE.MathUtils.degToRad(10); // rad/s
const OLEO_STROKE = 0.6; // m, visual travel limit (the sim's static compression is 0.22 m MEASURED)
const TIRE_SPINUP_TAU = 0.12; // s, ESTIMATED
const WHEEL_FREE_TAU = 25; // s, free-wheel spin down in the air, ESTIMATED

/** Engine index (0 = left outboard .. 5 = right outboard) from a part's side and engine (1 = inboard). */
function engineIndex(d: Record<string, unknown>) {
  const k = d.engine as number ?? d.exhaust as number;
  return d.side === "L" ? 3 - k : 2 + k;
}

function radialTexture(stops: [number, string][]) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [t, col] of stops) g.addColorStop(t, col);
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Prop { part: Part; i: number; angle: number; pitch: number; blades: { part: Part; beta75: number; mats: THREE.Material[] }[]; disc: THREE.Mesh; r75: number }
interface Leg { oleo?: Part; steer: boolean; wheels: { part: Part; r: number }[]; spin: number; angle: number; slip: number }

export class Aircraft {
  readonly root: THREE.Object3D;
  private parts: Map<string, Part>;
  private gearNodes: THREE.Object3D[] = [];
  private props: Prop[] = [];
  private cowls: { i: number; meshes: THREE.Mesh[] }[] = [];
  private legs = new Map<string, Leg>();
  private exhausts: { i: number; sprite: THREE.Sprite; jet: boolean }[] = [];
  private t = 0;
  /** Called per leg and frame while a tire skids on touchdown: wheel node, slip speed (m/s), dt. */
  onTireSlip: ((wheel: THREE.Object3D, radius: number, slip: number, dt: number) => void) | null = null;

  constructor(root: THREE.Object3D) {
    this.root = root;
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.parts = collectParts(root, "part");
    const extras: { o: THREE.Object3D; d: Record<string, unknown> }[] = [];
    root.traverse((o) => extras.push({ o, d: o.userData as Record<string, unknown> }));
    for (const { o, d } of extras) if (d.part === "gear") this.gearNodes.push(o);

    // propellers: blades turn for pitch; a translucent disc stands in for the blur at speed
    const discTex = radialTexture([[0, "rgba(40,40,40,0)"], [0.16, "rgba(40,40,40,0)"], [0.2, "rgba(30,30,30,0.55)"],
      [0.86, "rgba(30,30,30,0.35)"], [0.9, "rgba(200,175,60,0.22)"], [0.99, "rgba(200,175,60,0.12)"], [1, "rgba(0,0,0,0)"]]);
    for (const part of this.parts.values()) {
      if (part.data.part !== "prop") continue;
      const blades: Prop["blades"] = [];
      let r75 = 2.17, radius = 2.9;
      part.node.traverse((o) => {
        const bp = o !== part.node ? this.parts.get(o.name) : undefined;
        if (!bp || bp.data.part !== "blade") return;
        r75 = bp.data.r75 as number;
        radius = bp.data.radius as number;
        const mats: THREE.Material[] = [];
        o.traverse((m) => {
          if (!(m instanceof THREE.Mesh)) return;
          m.material = (Array.isArray(m.material) ? m.material : [m.material]).map((x) => { const c = x.clone(); c.transparent = true; mats.push(c); return c; });
          if (m.material.length === 1) m.material = m.material[0];
        });
        blades.push({ part: bp, beta75: THREE.MathUtils.degToRad(bp.data.beta75 as number), mats });
      });
      const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 48),
        new THREE.MeshLambertMaterial({ map: discTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 }));
      disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), part.axis); // circle faces +z
      disc.position.addScaledVector(part.axis, -0.1); // blade plane (the blades sweep aft of the hub)
      disc.visible = false;
      disc.renderOrder = 2;
      part.node.add(disc);
      this.props.push({ part, i: engineIndex(part.data), angle: 0, pitch: BLADE_FINE, blades, disc, r75 });
    }

    // cowl flaps: one morph target ("open") per nacelle side
    for (const { o, d } of extras) {
      if (d.cowl === undefined) continue;
      const meshes: THREE.Mesh[] = [];
      o.traverse((m) => { if (m instanceof THREE.Mesh && m.morphTargetInfluences) meshes.push(m); });
      this.cowls.push({ i: engineIndex({ engine: d.cowl, side: d.side }), meshes });
    }

    // gear legs: oleo (slides, nose steers) and wheels
    for (const part of this.parts.values()) {
      const leg = part.data.leg as string | undefined;
      if (!leg) continue;
      const l = this.legs.get(leg) ?? { steer: false, wheels: [], spin: 0, angle: 0, slip: 0 };
      if (part.data.part === "oleo") { l.oleo = part; l.steer = !!part.data.steer; part.data.basePos = part.node.position.clone(); }
      if (part.data.part === "wheel") l.wheels.push({ part, r: part.data.radius as number });
      this.legs.set(leg, l);
    }

    // exhaust glow at the stacks (engines) and nozzles (jets)
    const glowTex = radialTexture([[0, "rgba(255,240,200,1)"], [0.25, "rgba(255,150,60,0.7)"], [0.6, "rgba(200,70,20,0.2)"], [1, "rgba(0,0,0,0)"]]);
    const jetNodes: THREE.Object3D[] = [];
    for (const { o, d } of extras) {
      if (d.exhaust === undefined && d.jet_exhaust === undefined) continue;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      sprite.visible = false;
      o.add(sprite);
      if (d.jet_exhaust !== undefined) jetNodes.push(o);
      this.exhausts.push({ i: d.exhaust !== undefined ? engineIndex(d) : -1, sprite, jet: d.jet_exhaust !== undefined });
    }
    jetNodes.sort((a, b) => a.position.x - b.position.x);
    for (const e of this.exhausts) if (e.jet) e.i = jetNodes.indexOf(e.sprite.parent!);
  }

  static async load(url: string): Promise<Aircraft> {
    return new Aircraft(await loadGltf(url));
  }

  partNames(kind: string): string[] {
    return [...this.parts.values()].filter((p) => p.data.part === kind).map((p) => p.node.name);
  }

  apply(s: AircraftState, dt: number) {
    this.t += dt;
    // Hinge local X points toward +X world on both sides; positive rotation = trailing edge down.
    const ail = s.aileron * MAX_SURFACE;
    rotatePart(this.parts.get("Aileron_R"), -ail); // right aileron up for right roll
    rotatePart(this.parts.get("Aileron_L"), ail);
    rotatePart(this.parts.get("Elevator_R"), -s.elevator * MAX_SURFACE);
    rotatePart(this.parts.get("Elevator_L"), -s.elevator * MAX_SURFACE);
    rotatePart(this.parts.get("Rudder"), s.rudder * MAX_SURFACE); // hinge X up: + = trailing edge right
    for (const name of this.partNames("flap")) rotatePart(this.parts.get(name), s.flaps * MAX_FLAP);

    for (const name of this.partNames("bombdoor")) {
      const p = this.parts.get(name)!;
      rotatePart(p, (s.bombDoors[(p.data.bay as number) - 1] ?? 0) * (p.data.open_angle as number));
    }

    for (const pr of this.props) {
      const rpm = (s.propRpm[pr.i] ?? 0) * PROP_GEAR;
      const omega = (rpm / 60) * 2 * Math.PI;
      pr.angle = (pr.angle + omega * dt) % (2 * Math.PI);
      rotatePart(pr.part, pr.angle);
      // blade angle: feathered, governing (relative wind + angle of attack), or on the fine stop
      const target = s.feather[pr.i] ? BLADE_FEATHER
        : s.running[pr.i] ? THREE.MathUtils.clamp(Math.atan2(s.tas, Math.max(omega * pr.r75, 1)) + BLADE_AOA, BLADE_FINE, BLADE_FEATHER)
          : BLADE_FINE;
      pr.pitch += THREE.MathUtils.clamp(target - pr.pitch, -BLADE_RATE * dt, BLADE_RATE * dt);
      // blur: blades fade and the disc shows once the blade-pass rate is beyond what a frame can follow
      const blur = THREE.MathUtils.smoothstep(rpm, 120, 450); // visual tuning
      for (const b of pr.blades) {
        rotatePart(b.part, pr.pitch - b.beta75);
        for (const m of b.mats) m.opacity = 1 - 0.85 * blur;
      }
      (pr.disc.material as THREE.MeshLambertMaterial).opacity = 0.45 * blur;
      pr.disc.visible = blur > 0.01;
    }

    for (const c of this.cowls) for (const m of c.meshes) m.morphTargetInfluences![0] = s.cowl[c.i] ?? 0;

    // Gear: simple retraction (fold up into the wing/fuselage), hidden when fully up.
    for (const g of this.gearNodes) {
      const p = this.parts.get(g.name);
      rotatePart(p, (1 - s.gear) * (g.name === "Gear_Nose" ? -1.6 : 1.6));
      g.visible = s.gear > 0.02;
    }
    for (const lc of s.legs) {
      const l = this.legs.get(lc.name);
      if (!l) continue;
      if (l.oleo) {
        l.oleo.node.position.copy(l.oleo.data.basePos as THREE.Vector3).addScaledVector(l.oleo.axis, Math.min(lc.comp, OLEO_STROKE));
        rotatePart(l.oleo, l.steer ? -s.steer : 0);
      }
      const r = l.wheels[0]?.r ?? 1;
      const onGround = lc.comp > 0.005;
      const want = onGround ? lc.roll / r : s.gear < 0.99 ? 0 : l.spin;
      const tau = onGround ? TIRE_SPINUP_TAU : s.gear < 0.99 ? 2 : WHEEL_FREE_TAU;
      l.spin += ((onGround ? want : 0) - l.spin) * (1 - Math.exp(-dt / tau));
      l.slip = onGround ? Math.abs(lc.roll - l.spin * r) : 0;
      l.angle = (l.angle - l.spin * dt) % (2 * Math.PI); // + x axis: negative angle rolls forward
      for (const w of l.wheels) rotatePart(w.part, l.angle);
      if (l.slip > 2 && this.onTireSlip && l.wheels.length) for (const w of l.wheels) this.onTireSlip(w.part.node, w.r, l.slip, dt / l.wheels.length);
    }

    // exhaust: brighter and larger with power, flickering; mostly a night effect
    for (const e of this.exhausts) {
      const pw = e.jet ? (s.jetN[e.i] ?? 0) : s.running[e.i] ? 0.15 + 0.85 * (s.power[e.i] ?? 0) : 0;
      const flick = 0.85 + 0.15 * Math.sin(this.t * 47 + e.i * 1.7) * Math.sin(this.t * 31 + e.i);
      const a = pw * (0.12 + 0.88 * s.night) * flick;
      e.sprite.visible = a > 0.01;
      (e.sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, a);
      const size = (e.jet ? 1.4 : 0.6) * (0.6 + 0.6 * pw);
      e.sprite.scale.set(size, size, 1);
    }

    // Turret yaw / pitch / extension are driven by weapons/turrets.ts (Turret.update), not here: writing
    // them here every frame reset the turrets to their stowed pose after they had been aimed.
  }
}
