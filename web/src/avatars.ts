// Other crew members aboard: a simple figure (olive flight suit, helmet, oxygen mask) with a name tag,
// placed from their pose in the aircraft's model frame, so it rides with the cabin exactly.
import * as THREE from "three";
import type { NavData } from "./crew";
import type { Pose } from "./net/replicate";

const SUIT = new THREE.MeshStandardMaterial({ color: 0x4a4f36, roughness: 0.9 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x1a1a18, roughness: 0.7 });
const HELMET = new THREE.MeshStandardMaterial({ color: 0x6b6a5a, roughness: 0.55, metalness: 0.1 });
const SKIN = new THREE.MeshStandardMaterial({ color: 0xc89a7a, roughness: 0.8 });

interface Figure {
  root: THREE.Group;
  hips: THREE.Group; // legs hang from here
  torso: THREE.Group; // leans with the head pitch a little
  head: THREE.Group;
  legL: THREE.Group; legR: THREE.Group; shinL: THREE.Group; shinR: THREE.Group;
  armL: THREE.Group; armR: THREE.Group;
  tag: THREE.Sprite;
  phase: number;
}

function limb(len: number, r: number, mat: THREE.Material) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len - 2 * r, 4, 8), mat);
  m.position.y = -len / 2;
  m.castShadow = true;
  g.add(m);
  return g;
}

function nameTag(name: string) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const x = c.getContext("2d")!;
  x.fillStyle = "rgba(10,12,14,0.6)";
  x.fillRect(0, 8, 256, 48);
  x.fillStyle = "#ffd27a";
  x.font = "bold 30px system-ui, sans-serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(name.slice(0, 16), 128, 33);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  s.scale.set(0.5, 0.125, 1);
  s.renderOrder = 10;
  return s;
}

function buildFigure(name: string): Figure {
  const root = new THREE.Group();
  const hips = new THREE.Group();
  hips.position.y = 0.92;
  root.add(hips);
  const torso = new THREE.Group();
  hips.add(torso);
  const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.36, 4, 10), SUIT);
  chest.position.y = 0.3;
  chest.scale.set(1, 1, 0.7);
  chest.castShadow = true;
  torso.add(chest);
  const harness = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.07, 0.25), DARK);
  harness.position.y = 0.12;
  torso.add(harness);
  const head = new THREE.Group();
  head.position.y = 0.66;
  torso.add(head);
  const face = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), SKIN);
  head.add(face);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), HELMET);
  helmet.position.y = 0.02;
  helmet.castShadow = true;
  head.add(helmet);
  const mask = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.09, 10), DARK);
  mask.rotation.x = Math.PI / 2;
  mask.position.set(0, -0.04, -0.1);
  head.add(mask);
  const hose = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.3, 6), DARK);
  hose.position.set(0.05, -0.18, -0.1);
  hose.rotation.z = 0.4;
  head.add(hose);
  const mk = (x: number, len: number, r: number) => { const l = limb(len, r, SUIT); l.position.x = x; return l; };
  const legL = mk(-0.1, 0.46, 0.075), legR = mk(0.1, 0.46, 0.075);
  hips.add(legL, legR);
  const shinL = limb(0.46, 0.065, SUIT), shinR = limb(0.46, 0.065, SUIT);
  shinL.position.y = -0.46; shinR.position.y = -0.46;
  for (const s of [shinL, shinR]) {
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.08, 0.26), DARK);
    boot.position.set(0, -0.46, -0.05);
    s.add(boot);
  }
  legL.add(shinL); legR.add(shinR);
  const armL = mk(-0.23, 0.6, 0.055), armR = mk(0.23, 0.6, 0.055);
  armL.position.y = armR.position.y = 0.52;
  torso.add(armL, armR);
  const tag = nameTag(name);
  tag.position.y = 2.0;
  root.add(tag);
  return { root, hips, torso, head, legL, legR, shinL, shinR, armL, armR, tag, phase: 0 };
}

export class CrewAvatars {
  private figs = new Map<number, Figure>();
  private parent: THREE.Object3D;
  private nav: NavData;

  constructor(aircraftRoot: THREE.Object3D, nav: NavData) {
    this.parent = aircraftRoot;
    this.nav = nav;
  }

  /** Show everyone in `poses` except `selfId`; figures for players who left are removed. */
  update(poses: Pose[], selfId: number, dt: number) {
    const keep = new Set<number>();
    for (const p of poses) {
      if (p.id === selfId) continue;
      keep.add(p.id);
      let f = this.figs.get(p.id);
      if (!f) { f = buildFigure(p.name); this.figs.set(p.id, f); this.parent.add(f.root); }
      this.pose(f, p, dt);
    }
    for (const [id, f] of this.figs) if (!keep.has(id)) { this.parent.remove(f.root); this.figs.delete(id); }
  }

  private pose(f: Figure, p: Pose, dt: number) {
    const r = f.root;
    r.rotation.set(0, 0, 0);
    f.hips.rotation.set(0, 0, 0);
    f.torso.rotation.set(0, 0, 0);
    for (const l of [f.legL, f.legR, f.shinL, f.shinR, f.armL, f.armR]) l.rotation.set(0, 0, 0);
    f.head.rotation.set(p.pitch * 0.8, 0, 0);
    if (p.mode === "seated") {
      const seat = this.nav.seats.find((s) => s.name === p.seat);
      const yaw = seat ? seat.yaw : p.yaw;
      // seated: hips ~0.62 m below the eye, thighs forward, shins down
      r.position.set(p.eye[0], p.eye[1] - 1.42, p.eye[2]);
      r.rotation.y = yaw;
      f.head.rotation.y = p.yaw - yaw;
      f.hips.position.set(0, 0.8, 0.12);
      f.legL.rotation.x = f.legR.rotation.x = Math.PI / 2;
      f.shinL.rotation.x = f.shinR.rotation.x = -Math.PI / 2;
      f.armL.rotation.x = f.armR.rotation.x = 0.9;
      f.tag.position.y = 1.75;
    } else if (p.mode === "tunnel") {
      // prone on the trolley, head first along the tunnel
      r.position.set(p.eye[0], p.eye[1] - 0.25, p.eye[2]);
      r.rotation.y = p.yaw;
      r.rotation.x = -Math.PI / 2;
      f.hips.position.set(0, 0, 0.9);
      f.armL.rotation.x = f.armR.rotation.x = Math.PI * 0.9;
      f.tag.position.y = 0.4;
    } else {
      r.position.set(p.feet[0], p.feet[1], p.feet[2]);
      r.rotation.y = p.yaw;
      const crouch = p.crouch ? 0.35 : 0;
      f.hips.position.set(0, 0.92 - crouch, 0);
      f.phase += dt * Math.min(p.speed, 3) * 4.5;
      const swing = p.mode === "climbing" ? 0.6 * Math.sin(f.phase) : Math.min(p.speed, 2.4) * 0.28 * Math.sin(f.phase);
      f.legL.rotation.x = swing + crouch * 1.4;
      f.legR.rotation.x = -swing + crouch * 1.4;
      f.shinL.rotation.x = -Math.max(0, -swing) * 0.8 - crouch * 2.2;
      f.shinR.rotation.x = -Math.max(0, swing) * 0.8 - crouch * 2.2;
      f.armL.rotation.x = p.mode === "climbing" ? 2.6 + swing : -swing * 0.8;
      f.armR.rotation.x = p.mode === "climbing" ? 2.6 - swing : swing * 0.8;
      f.torso.rotation.x = -crouch * 0.6;
      f.tag.position.y = 2.0 - crouch;
    }
  }

  get count() {
    return this.figs.size;
  }

  clear() {
    for (const f of this.figs.values()) this.parent.remove(f.root);
    this.figs.clear();
  }
}
