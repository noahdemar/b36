// Damage visuals: smoke and fire trails, flak bursts, hole decals, separating structure and debris,
// crash fire. Particles live in the World group (absolute sim coordinates).
import * as THREE from "three";
import type { Component, Separation } from "./sim/damage";
import type { FlightModel } from "./sim/flightmodel";

// ------------------------------------------------------------------------------------- particles

class Particles {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private color: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private age: Float32Array;
  private grow: Float32Array;
  private a0: Float32Array;
  private n = 0;
  private max: number;
  private geo: THREE.BufferGeometry;

  constructor(max: number, additive: boolean) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.color = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.age = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.a0 = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("psize", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("palpha", new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("pcolor", new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      uniforms: { scale: { value: 600 } },
      vertexShader: `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float psize; attribute float palpha; attribute vec3 pcolor;
        uniform float scale; varying float vA; varying vec3 vC;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min(psize * scale / max(-mv.z, 0.1), 512.0);
          vA = palpha; vC = pcolor;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying float vA; varying vec3 vC;
        void main() {
          #include <logdepthbuf_fragment>
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d) * 4.0;
          if (r > 1.0) discard;
          gl_FragColor = vec4(vC, vA * (1.0 - r) * (1.0 - r));
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
  }

  spawn(p: THREE.Vector3, v: THREE.Vector3, size: number, grow: number, life: number, alpha: number, col: [number, number, number]) {
    let i = this.n;
    if (i >= this.max) {
      // replace the oldest-relative particle
      i = Math.floor(Math.random() * this.max);
    } else this.n++;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.color.set(col, i * 3);
    this.size[i] = size;
    this.grow[i] = grow;
    this.life[i] = life;
    this.age[i] = 0;
    this.a0[i] = alpha;
    this.alpha[i] = alpha;
  }

  update(dt: number, cameraFovScale: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = cameraFovScale;
    let i = 0;
    while (i < this.n) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        const last = --this.n;
        if (i !== last) {
          for (let k = 0; k < 3; k++) { this.pos[i * 3 + k] = this.pos[last * 3 + k]; this.vel[i * 3 + k] = this.vel[last * 3 + k]; this.color[i * 3 + k] = this.color[last * 3 + k]; }
          this.size[i] = this.size[last]; this.grow[i] = this.grow[last]; this.life[i] = this.life[last];
          this.age[i] = this.age[last]; this.a0[i] = this.a0[last]; this.alpha[i] = this.alpha[last];
        }
        continue;
      }
      const drag = Math.exp(-dt * 0.6);
      for (let k = 0; k < 3; k++) { this.vel[i * 3 + k] *= drag; this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt; }
      this.size[i] += this.grow[i] * dt;
      const f = this.age[i] / this.life[i];
      this.alpha[i] = this.a0[i] * (f < 0.1 ? f / 0.1 : 1 - (f - 0.1) / 0.9);
      i++;
    }
    this.geo.setDrawRange(0, this.n);
    for (const name of ["position", "psize", "palpha", "pcolor"]) (this.geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
  }

  clear() {
    this.n = 0;
  }
}

// ------------------------------------------------------------------------------------- effects

interface Debris { obj: THREE.Object3D; vel: THREE.Vector3; spin: THREE.Vector3; clips: { mat: THREE.Material; local: THREE.Plane }[]; grounded: boolean; t: number }
interface Restore { obj: THREE.Object3D; parent: THREE.Object3D; matrix: THREE.Matrix4 }

export class DamageFX {
  smoke = new Particles(9000, false);
  fire = new Particles(4000, true);
  private holes: THREE.InstancedMesh;
  private nHoles = 0;
  private emitT = 0;
  private lastEmit = new Map<string, THREE.Vector3>();
  private seenSeparations = 0;
  private debris: Debris[] = [];
  private restores: Restore[] = [];
  private aircraftClips: { mat: THREE.Material; local: THREE.Plane }[] = [];
  private clonedMats = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private ray = new THREE.Raycaster();
  shake = 0;

  private world: THREE.Object3D;
  private aircraftRoot: THREE.Object3D;
  private ext: THREE.Object3D;

  constructor(world: THREE.Object3D, aircraftRoot: THREE.Object3D, ext: THREE.Object3D) {
    this.world = world;
    this.aircraftRoot = aircraftRoot;
    this.ext = ext;
    world.add(this.smoke.points, this.fire.points);
    const hg = new THREE.CircleGeometry(1, 10);
    const hm = new THREE.MeshStandardMaterial({ color: 0x0b0b0b, roughness: 1, polygonOffset: true, polygonOffsetFactor: -4, side: THREE.DoubleSide });
    this.holes = new THREE.InstancedMesh(hg, hm, 600);
    this.holes.count = 0;
    this.holes.frustumCulled = false;
    aircraftRoot.add(this.holes);
  }

  /** Model coordinates -> absolute world (sim frame). */
  private toWorld(fm: FlightModel, local: THREE.Vector3) {
    const w = local.clone().applyMatrix4(this.aircraftRoot.matrixWorld);
    w.x += fm.pos.x;
    w.z += fm.pos.z;
    return w;
  }

  flakBurst(world: THREE.Vector3, distance: number) {
    const o = new THREE.Vector3();
    for (let k = 0; k < 7; k++) {
      o.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(10);
      this.smoke.spawn(world.clone().add(o), o.clone().multiplyScalar(0.6), 9, 2.5, 14 + Math.random() * 6, 0.85, [0.06, 0.06, 0.06]);
    }
    this.fire.spawn(world, new THREE.Vector3(), 22, 30, 0.25, 1, [1.0, 0.6, 0.25]);
    if (distance < 150) this.shake = Math.max(this.shake, Math.min(1, 40 / Math.max(distance, 10)));
  }

  /** Hole decals where fragments struck, by raycasting from the burst toward each part hit. */
  holesFrom(burstLocal: THREE.Vector3, hits: { comp: Component; hits: number }[]) {
    const meshes: THREE.Object3D[] = [];
    this.ext.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.visible) meshes.push(o); });
    const toScene = this.aircraftRoot.matrixWorld.clone();
    const origin = burstLocal.clone().applyMatrix4(toScene);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (const { comp, hits: n } of hits) {
      for (let k = 0; k < Math.min(n, 6); k++) {
        const target = comp.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 4));
        const tw = target.applyMatrix4(toScene);
        this.ray.set(origin, tw.sub(origin).normalize());
        this.ray.far = 200;
        const hit = this.ray.intersectObjects(meshes, false)[0];
        if (!hit || !hit.face) continue;
        const nLocal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
          .transformDirection(this.aircraftRoot.matrixWorld.clone().invert());
        const pLocal = this.aircraftRoot.worldToLocal(hit.point.clone()).addScaledVector(nLocal, 0.01);
        q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nLocal);
        const s = 0.04 + Math.random() * 0.1;
        m.compose(pLocal, q, new THREE.Vector3(s, s, s));
        this.holes.setMatrixAt(this.nHoles % 600, m);
        this.nHoles++;
        this.holes.count = Math.min(this.nHoles, 600);
        this.holes.instanceMatrix.needsUpdate = true;
      }
    }
  }

  update(fm: FlightModel, dt: number, fovScale: number) {
    const d = fm.damage;
    this.emitT -= dt;
    {
      const wreck = this.emitT <= 0;
      if (wreck) this.emitT = 0.05;
      // trails: particles laid along the path each emitter flew since the last frame, spaced by size,
      // so they stay continuous at any frame rate and speed
      const seen = new Set<string>();
      const emit = (local: THREE.Vector3, kind: "fire" | "black" | "grey" | "fuel", scale = 1) => {
        const key = `${kind}:${local.x.toFixed(1)}:${local.y.toFixed(1)}:${local.z.toFixed(1)}`;
        seen.add(key);
        const p = this.toWorld(fm, local);
        const prev = this.lastEmit.get(key);
        this.lastEmit.set(key, p.clone());
        const spacing = { fire: 0.7, black: 1.4, grey: 1.0, fuel: 0.7 }[kind] * scale;
        const dist = prev ? prev.distanceTo(p) : 0;
        const n = prev && dist < 300 ? Math.min(60, Math.max(1, Math.ceil(dist / spacing))) : 1;
        for (let j = 1; j <= n; j++) {
          const q = prev && n > 1 ? prev.clone().lerp(p, j / n) : p;
          const jitter = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2);
          const age = (1 - j / n) * dt; // older particles further back
          if (kind === "fire") {
            this.fire.spawn(q, jitter.clone().multiplyScalar(0.5), 1.3 * scale, 1.5, 0.10 - age * 0.3, 1.0, [1.0, 0.85, 0.55]); // hot core
            this.fire.spawn(q.clone().addScaledVector(jitter, 0.4), jitter, 2.2 * scale, 5, 0.2 - age * 0.3, 0.75, [1.0, 0.42 + Math.random() * 0.15, 0.08]);
            if (j % 2 === 0) this.smoke.spawn(q.clone().addScaledVector(fm.vel, -0.15), jitter, 3 * scale, 4, 14, 0.8, [0.13, 0.12, 0.11]);
          } else if (kind === "black") this.smoke.spawn(q, jitter, 3 * scale, 3.5, 10, 0.55, [0.16, 0.15, 0.14]);
          else if (kind === "grey") this.smoke.spawn(q, jitter, 2 * scale, 2, 6, 0.3, [0.45, 0.45, 0.45]);
          else this.smoke.spawn(q, jitter, 1.5 * scale, 2.5, 4, 0.25, [0.9, 0.92, 0.95]);
        }
      };
      if (!d.crashed) {
        for (const c of d.comps) {
          if (c.lost) continue;
          const aft = c.pos.clone().add(new THREE.Vector3(0, 0, 2.2));
          if (c.kind === "engine") {
            if (d.engineFire.has(c.index!)) emit(aft, "fire", 1.2);
            else if (d.oilLeak.has(c.index!) || fm.pistons[c.index!].failed) emit(aft, d.oilLeak.has(c.index!) ? "black" : "grey");
          } else if (c.kind === "jet" && d.jetFire.has(c.index!)) emit(aft, "fire");
          else if (c.kind === "tank") {
            if (d.tankFire.has(c.index!)) { emit(aft, "fire", 1.6); emit(c.pos, "fire", 1.2); }
            else if ((d.leaks.get(c.index!) ?? 0) > 0 && fm.fuel.tanks[c.index!].qty > 1) emit(aft.add(new THREE.Vector3(0, -0.3, 1.5)), "fuel");
          } else if ((c.kind === "wing" || c.kind === "fuselage") && c.hp / c.hpMax < 0.35) emit(c.pos, "grey", 0.8);
        }
      } else if (wreck) {
        // wreck burning on the ground
        const p = this.toWorld(fm, new THREE.Vector3((Math.random() - 0.5) * 30, 0, (Math.random() - 0.5) * 30));
        p.y = Math.max(p.y, 1);
        this.fire.spawn(p, new THREE.Vector3(0, 4, 0), 10, 6, 1.5, 0.9, [1, 0.5, 0.15]);
        this.smoke.spawn(p, new THREE.Vector3(Math.random() - 0.5, 6, Math.random() - 0.5), 10, 6, 25, 0.8, [0.05, 0.05, 0.05]);
      }
      for (const k of this.lastEmit.keys()) if (!seen.has(k)) this.lastEmit.delete(k);
    }
    // new separations
    while (this.seenSeparations < d.separations.length) this.separate(fm, d.separations[this.seenSeparations++]);
    // clipping planes follow their objects
    for (const c of this.aircraftClips) this.updateClip(c, this.aircraftRoot);
    for (const db of this.debris) {
      if (!db.grounded) {
        db.vel.y -= 9.80665 * dt;
        db.vel.multiplyScalar(Math.exp(-dt * 0.08));
        db.obj.position.addScaledVector(db.vel, dt);
        db.obj.rotation.x += db.spin.x * dt;
        db.obj.rotation.y += db.spin.y * dt;
        db.obj.rotation.z += db.spin.z * dt;
        db.t += dt;
        if (db.t < 20 && Math.random() < 0.5) this.smoke.spawn(db.obj.position.clone(), new THREE.Vector3(), 3, 3, 6, 0.5, [0.1, 0.1, 0.1]);
        if (db.obj.position.y < 1) { db.obj.position.y = 1; db.grounded = true; }
      }
      db.obj.updateMatrixWorld(true);
      for (const c of db.clips) this.updateClip(c, db.obj);
    }
    this.smoke.update(dt, fovScale);
    this.fire.update(dt, fovScale);
    this.shake = Math.max(0, this.shake - dt * 2.5);
  }

  private updateClip(c: { mat: THREE.Material; local: THREE.Plane }, frame: THREE.Object3D) {
    const w = c.local.clone().applyMatrix4(frame.matrixWorld);
    const planes = c.mat.clippingPlanes ?? [];
    const idx = (c as unknown as { idx?: number }).idx ?? 0;
    planes[idx] = w;
    c.mat.clippingPlanes = planes;
  }

  /** Splits the airframe at a separation: whole parts beyond the cut move to a debris group, parts that
   * straddle it are cloned and clipped on both sides. */
  private separate(fm: FlightModel, s: Separation) {
    this.aircraftRoot.updateMatrixWorld(true);
    const beyond = (v: THREE.Vector3) => (s.axis === "x" ? (s.at < 0 ? v.x < s.at : v.x > s.at) : v.z > s.at);
    // keep-side plane (aircraft) in model coordinates: normal points to the kept side
    const n = s.axis === "x" ? new THREE.Vector3(s.at < 0 ? 1 : -1, 0, 0) : new THREE.Vector3(0, 0, -1);
    const keep = new THREE.Plane().setFromNormalAndCoplanarPoint(n, s.axis === "x" ? new THREE.Vector3(s.at, 0, 0) : new THREE.Vector3(0, 0, s.at));
    const debrisRoot = new THREE.Group();
    debrisRoot.position.copy(this.aircraftRoot.position);
    debrisRoot.quaternion.copy(this.aircraftRoot.quaternion);
    debrisRoot.position.x += fm.pos.x;
    debrisRoot.position.z += fm.pos.z;
    this.world.add(debrisRoot);
    debrisRoot.updateMatrixWorld(true);
    const db: Debris = { obj: debrisRoot, vel: fm.vel.clone().add(new THREE.Vector3((Math.random() - 0.5) * 8, -3, 0)),
      spin: new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3), clips: [], grounded: false, t: 0 };
    const toModel = this.aircraftRoot.matrixWorld.clone().invert();
    const meshes: THREE.Mesh[] = [];
    this.ext.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    const moved = new Set<THREE.Object3D>();
    for (const mesh of meshes) {
      if (!mesh.visible || [...moved].some((m) => isAncestor(m, mesh))) continue;
      const box = new THREE.Box3().setFromObject(mesh).applyMatrix4(toModel);
      const lo = box.min, hi = box.max;
      const allBeyond = beyond(lo) && beyond(hi);
      const anyBeyond = beyond(lo) || beyond(hi);
      if (allBeyond) {
        // move the topmost ancestor below ext that is also entirely beyond, so moving parts stay intact
        let top: THREE.Object3D = mesh;
        while (top.parent && top.parent !== this.ext) {
          const pb = new THREE.Box3().setFromObject(top.parent).applyMatrix4(toModel);
          if (beyond(pb.min) && beyond(pb.max)) top = top.parent; else break;
        }
        this.restores.push({ obj: top, parent: top.parent!, matrix: top.matrix.clone() });
        debrisRoot.attach(top);
        moved.add(top);
      } else if (anyBeyond) {
        const own = this.ownMaterial(mesh);
        own.clipShadows = true;
        const c = { mat: own, local: keep.clone() } as { mat: THREE.Material; local: THREE.Plane; idx?: number };
        c.idx = (own.clippingPlanes ?? []).length;
        own.clippingPlanes = [...(own.clippingPlanes ?? []), keep.clone()];
        this.aircraftClips.push(c);
        const clone = mesh.clone();
        const cm = (mesh.material as THREE.Material).clone();
        cm.clippingPlanes = [keep.clone().negate()];
        clone.material = cm;
        mesh.updateMatrixWorld(true);
        clone.matrix.copy(mesh.matrixWorld);
        clone.matrixAutoUpdate = false;
        debrisRoot.attach(clone);
        clone.matrixAutoUpdate = true;
        clone.matrix.decompose(clone.position, clone.quaternion, clone.scale);
        // debris space starts equal to model space, so the clone's cut plane is the model-space plane, flipped
        db.clips.push({ mat: cm, local: keep.clone().negate() });
      }
    }
    this.debris.push(db);
  }

  private ownMaterial(mesh: THREE.Mesh): THREE.Material {
    if (!this.clonedMats.has(mesh)) {
      this.clonedMats.set(mesh, mesh.material);
      mesh.material = (mesh.material as THREE.Material).clone();
    }
    return mesh.material as THREE.Material;
  }

  reset() {
    this.smoke.clear();
    this.fire.clear();
    this.nHoles = 0;
    this.holes.count = 0;
    for (const r of this.restores.reverse()) {
      r.parent.add(r.obj);
      r.obj.matrix.copy(r.matrix);
      r.obj.matrix.decompose(r.obj.position, r.obj.quaternion, r.obj.scale);
    }
    this.restores = [];
    for (const db of this.debris) this.world.remove(db.obj);
    this.debris = [];
    for (const [mesh, mat] of this.clonedMats) mesh.material = mat;
    this.clonedMats.clear();
    this.aircraftClips = [];
    this.seenSeparations = 0;
  }
}

function isAncestor(a: THREE.Object3D, b: THREE.Object3D) {
  for (let p: THREE.Object3D | null = b; p; p = p.parent) if (p === a) return true;
  return false;
}
