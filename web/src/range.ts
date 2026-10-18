// Bombing range: ground targets in absolute world (sim) coordinates, impact effects and scoring.
import * as THREE from "three";

export interface Target {
  name: string;
  pos: THREE.Vector3;
  radius: number; // lethal radius for a 1,000 lb GP bomb on this target (ESTIMATED)
  mesh: THREE.Object3D;
  destroyed: boolean;
  hp?: number; // 20 mm hits to destroy (ESTIMATED)
}

/** Range centre: 30 km north of the runway threshold (north = -z). */
export const RANGE_CENTER = new THREE.Vector3(0, 0, -30_000);

export class BombingRange {
  targets: Target[] = [];
  private effects: { mesh: THREE.Mesh; t: number; life: number; grow: number }[] = [];
  log: string[] = [];

  private group: THREE.Object3D;

  constructor(group: THREE.Object3D) {
    this.group = group;
    const c = RANGE_CENTER;
    // aiming circles (100 m, 300 m) as flat rings
    for (const [r, w] of [[100, 6], [300, 8], [600, 8]]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r - w / 2, r + w / 2, 96),
        new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(c.x, 0.05, c.z);
      group.add(ring);
    }
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(8, 160), new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }));
    for (const rot of [0, Math.PI / 2]) {
      const b = bar.clone();
      b.rotation.set(-Math.PI / 2, 0, rot);
      b.position.set(c.x, 0.06, c.z);
      group.add(b);
    }
    // targets: a factory block, hangars, a vehicle column, a rail siding
    const mat = (col: number) => new THREE.MeshStandardMaterial({ color: col, roughness: 0.85 });
    const add = (name: string, x: number, z: number, w: number, h: number, d: number, col: number, radius: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(col));
      m.position.set(c.x + x, h / 2, c.z + z);
      m.castShadow = m.receiveShadow = true;
      group.add(m);
      this.targets.push({ name, pos: m.position.clone(), radius, mesh: m, destroyed: false });
    };
    add("Factory hall", 0, 0, 60, 14, 30, 0x8a7d6b, 35);
    add("Power house", 70, -40, 20, 18, 20, 0x7b6e61, 22);
    add("Hangar A", -180, 120, 50, 12, 40, 0x6f7477, 30);
    add("Hangar B", -120, 120, 50, 12, 40, 0x6f7477, 30);
    for (let i = 0; i < 6; i++) add(`Truck ${i + 1}`, 250 + i * 14, -200, 3, 3, 8, 0x4f5a3c, 15);
    for (let i = 0; i < 5; i++) add(`Rail car ${i + 1}`, -300, -250 + i * 22, 3.5, 4, 18, 0x5a4636, 15);
  }

  /** Bomb impact at a world (sim frame) point: effects, damage, scoring line. */
  impact(p: THREE.Vector3) {
    const fire = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffb060, transparent: true, opacity: 0.9 }));
    fire.position.set(p.x, 2, p.z);
    this.group.add(fire);
    this.effects.push({ mesh: fire, t: 0, life: 1.2, grow: 28 });
    const smoke = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0x4a4540, transparent: true, opacity: 0.7, roughness: 1 }));
    smoke.position.set(p.x, 6, p.z);
    this.group.add(smoke);
    this.effects.push({ mesh: smoke, t: 0, life: 14, grow: 45 });
    const crater = new THREE.Mesh(new THREE.CircleGeometry(7, 24),
      new THREE.MeshStandardMaterial({ color: 0x2c2620, roughness: 1, polygonOffset: true, polygonOffsetFactor: -3 }));
    crater.rotation.x = -Math.PI / 2;
    crater.position.set(p.x, 0.07, p.z);
    this.group.add(crater);

    let nearest: Target | null = null;
    let nd = Infinity;
    for (const t of this.targets) {
      const d = Math.hypot(t.pos.x - p.x, t.pos.z - p.z);
      if (d < nd) { nd = d; nearest = t; }
      if (!t.destroyed && d <= t.radius) {
        t.destroyed = true;
        const m = t.mesh as THREE.Mesh;
        (m.material as THREE.MeshStandardMaterial).color.setHex(0x1d1a17);
        m.scale.y = 0.25;
        m.position.y *= 0.25;
      }
    }
    const fromCenter = Math.hypot(p.x - RANGE_CENTER.x, p.z - RANGE_CENTER.z);
    const msg = fromCenter > 3000
      ? `Impact ${(fromCenter / 1000).toFixed(1)} km from the range`
      : `Impact ${nd.toFixed(0)} m from ${nearest?.name}${nearest && nd <= nearest.radius ? " (destroyed)" : ""}`;
    this.log.unshift(msg);
    this.log.length = Math.min(this.log.length, 4);
  }

  /** A 20 mm round reaching the ground: dust puff, and damage to anything within 6 m. */
  strafe(p: THREE.Vector3) {
    const puff = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0x8a7c66, transparent: true, opacity: 0.7, roughness: 1 }));
    puff.position.set(p.x, 0.8, p.z);
    this.group.add(puff);
    this.effects.push({ mesh: puff, t: 0, life: 1.5, grow: 3 });
    for (const t of this.targets) {
      if (t.destroyed || Math.hypot(t.pos.x - p.x, t.pos.z - p.z) > 6 + t.radius * 0.2) continue;
      t.hp = (t.hp ?? (t.radius <= 15 ? 8 : 120)) - 1;
      if (t.hp <= 0) {
        t.destroyed = true;
        const m = t.mesh as THREE.Mesh;
        (m.material as THREE.MeshStandardMaterial).color.setHex(0x1d1a17);
        this.log.unshift(`${t.name} destroyed by gunfire`);
        this.log.length = Math.min(this.log.length, 4);
      }
    }
  }

  get destroyedCount() {
    return this.targets.filter((t) => t.destroyed).length;
  }

  update(dt: number) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.t += dt;
      const f = e.t / e.life;
      e.mesh.scale.setScalar(1 + e.grow * Math.sqrt(f));
      e.mesh.position.y += dt * (e.life > 5 ? 3 : 0);
      (e.mesh.material as THREE.Material).opacity = Math.max(0, (e.life > 5 ? 0.7 : 0.9) * (1 - f));
      if (f >= 1) {
        this.group.remove(e.mesh);
        this.effects.splice(i, 1);
      }
    }
  }
}
