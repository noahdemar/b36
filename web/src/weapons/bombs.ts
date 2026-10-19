// Bomb load, release and ballistics. Bombs fly in absolute world coordinates (the sim's frame,
// before the floating-origin shift) and are drawn inside the World group.
import * as THREE from "three";
import { atmosphere, G0 } from "../sim/atmosphere.ts";
import type { FlightModel } from "../sim/flightmodel.ts";

// AN-M65 1,000 lb general-purpose bomb. Mass and diameter SOURCED (standard type data);
// drag coefficient ESTIMATED.
export const BOMB = { mass: 454, diameter: 0.48, length: 1.8, cd: 0.30 };
const AREA = Math.PI * (BOMB.diameter / 2) ** 2;

// Bay racks in model coordinates (x right, y up, z aft). 4 bays x 12 bombs (3 columns x 4 tiers).
// Bay stations from tools/model/params.py BOMB_BAYS (ESTIMATED); NOSE_Y = 24.7.
const BAYS = [[13.6, 17.9], [18.1, 22.4], [26.6, 30.0], [30.2, 33.6]];
const NOSE_Y = 24.7;

export type ReleaseMode = "single" | "train" | "salvo";

interface Rack { bay: number; local: THREE.Vector3; loaded: boolean; mesh: THREE.Object3D }
interface Falling { pos: THREE.Vector3; vel: THREE.Vector3; mesh: THREE.Object3D }

export interface Impact { pos: THREE.Vector3; time: number }

function bombMesh(): THREE.Object3D {
  const g = new THREE.Group();
  const r = BOMB.diameter / 2;
  const prof: THREE.Vector2[] = [];
  for (let i = 0; i <= 12; i++) prof.push(new THREE.Vector2(r * Math.sin((i / 12) * Math.PI * 0.5), -0.55 + 0.55 * (i / 12) ** 0.6));
  prof.push(new THREE.Vector2(r, 0.55), new THREE.Vector2(r * 0.55, 0.95), new THREE.Vector2(0.06, 1.2));
  const body = new THREE.Mesh(new THREE.LatheGeometry(prof.map((p) => new THREE.Vector2(p.x, -p.y)), 20),
    new THREE.MeshStandardMaterial({ color: 0x4a5130, roughness: 0.7, metalness: 0.2 }));
  body.rotation.x = Math.PI / 2; // lathe axis (y) -> z (nose forward = -z)
  g.add(body);
  const finMat = new THREE.MeshStandardMaterial({ color: 0x3e4428, roughness: 0.7 });
  for (let k = 0; k < 4; k++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.42, 0.42), finMat);
    fin.position.z = 1.0;
    fin.rotation.z = (k * Math.PI) / 2;
    fin.translateY(0.21);
    g.add(fin);
  }
  // yellow nose band
  const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.01, r * 1.01, 0.08, 20), new THREE.MeshStandardMaterial({ color: 0xc8a020, roughness: 0.6 }));
  band.rotation.x = Math.PI / 2;
  band.position.z = -0.3;
  g.add(band);
  g.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });
  return g;
}

export class BombSystem {
  racks: Rack[] = [];
  falling: Falling[] = [];
  mode: ReleaseMode = "single";
  trainInterval = 0.25; // s between bombs in train mode
  armed = false;
  onImpact: ((p: Impact) => void) | null = null;
  private trainQueue = 0;
  private trainTimer = 0;
  private template = bombMesh();

  private worldGroup: THREE.Object3D;

  constructor(aircraftRoot: THREE.Object3D, worldGroup: THREE.Object3D) {
    this.worldGroup = worldGroup;
    BAYS.forEach(([d0, d1], bay) => {
      for (let tier = 0; tier < 4; tier++) {
        for (let col = 0; col < 3; col++) {
          const local = new THREE.Vector3((col - 1) * 0.5, -0.30 - tier * 0.42, (d0 + d1) / 2 - NOSE_Y);
          const mesh = this.template.clone();
          mesh.position.copy(local);
          aircraftRoot.add(mesh);
          this.racks.push({ bay, local, loaded: true, mesh });
        }
      }
    });
  }

  get remaining() {
    return this.racks.filter((r) => r.loaded).length;
  }

  /** Total weight of bombs still aboard (kg). */
  get loadMass() {
    return this.remaining * BOMB.mass;
  }

  reload() {
    for (const r of this.racks) {
      r.loaded = true;
      r.mesh.visible = true;
    }
  }

  /** Press of the release button. Returns a message for the crew status line. */
  release(fm: FlightModel, modelMatrix: THREE.Matrix4): string {
    if (fm.bombDoorPos < 0.95) return "BOMB DOORS NOT OPEN";
    if (!this.armed) return "BOMBS NOT ARMED";
    if (!this.remaining) return "BOMB BAYS EMPTY";
    if (this.mode === "single") this.drop(fm, modelMatrix, 1);
    else if (this.mode === "salvo") this.drop(fm, modelMatrix, this.remaining);
    else {
      this.trainQueue = Math.min(12, this.remaining);
      this.trainTimer = 0;
    }
    return `RELEASE: ${this.mode.toUpperCase()}`;
  }

  /** Release order: lowest tier first; within a tier alternate fore and aft bays. */
  private order() {
    return this.racks.filter((r) => r.loaded)
      .sort((a, b) => (a.local.y - b.local.y) || ((a.bay % 2) - (b.bay % 2)) || (a.bay - b.bay));
  }

  /** World (sim frame) position of the next bomb to fall, for the bombsight's offset correction. */
  nextReleasePoint(fm: FlightModel, modelMatrix: THREE.Matrix4): THREE.Vector3 | null {
    const r = this.order()[0];
    if (!r) return null;
    const p = r.local.clone().applyMatrix4(modelMatrix);
    p.x += fm.pos.x;
    p.z += fm.pos.z;
    return p;
  }

  /** Each bomb released (world position and velocity), for multiplayer replication. */
  onDrop: ((pos: THREE.Vector3, vel: THREE.Vector3) => void) | null = null;

  /** Rack load as a string of 0/1 (multiplayer). */
  get loadedMask() {
    return this.racks.map((r) => (r.loaded ? "1" : "0")).join("");
  }

  set loadedMask(m: string) {
    this.racks.forEach((r, i) => { r.loaded = m[i] === "1"; r.mesh.visible = r.loaded; });
  }

  /** A falling bomb seen on a crew member's screen (the host's drop, replayed). */
  spawnFalling(pos: THREE.Vector3, vel: THREE.Vector3) {
    const mesh = this.template.clone();
    this.worldGroup.add(mesh);
    this.falling.push({ pos: pos.clone(), vel: vel.clone(), mesh });
  }

  /** Drop n bombs in release order. */
  private drop(fm: FlightModel, modelMatrix: THREE.Matrix4, n: number) {
    const order = this.order();
    for (const r of order.slice(0, n)) {
      r.loaded = false;
      r.mesh.visible = false;
      // world position of the rack (sim frame): model matrix places the model in the floating-origin
      // scene, so add the CG's absolute x/z back.
      const p = r.local.clone().applyMatrix4(modelMatrix);
      p.x += fm.pos.x;
      p.z += fm.pos.z;
      const mesh = this.template.clone();
      this.worldGroup.add(mesh);
      this.falling.push({ pos: p, vel: fm.vel.clone().add(new THREE.Vector3(0, -1.5, 0)), mesh });
      this.onDrop?.(p, this.falling[this.falling.length - 1].vel);
      fm.setMass(fm.mass - BOMB.mass);
    }
  }

  static step(pos: THREE.Vector3, vel: THREE.Vector3, dt: number) {
    const rho = atmosphere(pos.y).density;
    const v = vel.length();
    const k = (0.5 * rho * v * BOMB.cd * AREA) / BOMB.mass;
    vel.x -= k * vel.x * dt;
    vel.z -= k * vel.z * dt;
    vel.y -= (G0 + k * vel.y) * dt;
    pos.addScaledVector(vel, dt);
  }

  /** Predicted impact point (world, sim frame) for a bomb released now. */
  static predict(fm: FlightModel, from: THREE.Vector3): { point: THREE.Vector3; time: number } {
    const p = from.clone();
    const v = fm.vel.clone().add(new THREE.Vector3(0, -1.5, 0));
    let t = 0;
    const dt = 0.05;
    while (p.y > 0 && t < 120) {
      BombSystem.step(p, v, dt);
      t += dt;
    }
    return { point: p, time: t };
  }

  update(fm: FlightModel, modelMatrix: THREE.Matrix4, dt: number) {
    if (this.trainQueue > 0) {
      this.trainTimer -= dt;
      if (this.trainTimer <= 0) {
        if (fm.bombDoorPos >= 0.95 && this.remaining) this.drop(fm, modelMatrix, 1);
        this.trainQueue = this.remaining ? this.trainQueue - 1 : 0;
        this.trainTimer = this.trainInterval;
      }
    }
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const b = this.falling[i];
      const sub = 4;
      for (let s = 0; s < sub; s++) BombSystem.step(b.pos, b.vel, dt / sub);
      b.mesh.position.copy(b.pos);
      b.mesh.lookAt(b.pos.clone().sub(b.vel)); // tail toward -velocity: object -z faces velocity
      if (b.pos.y <= 0) {
        b.pos.y = 0;
        this.worldGroup.remove(b.mesh);
        this.falling.splice(i, 1);
        this.onImpact?.({ pos: b.pos.clone(), time: performance.now() });
      }
    }
  }
}
