import * as THREE from "three";
import { collectParts, rotatePart, type Part } from "./aircraft";
import type { FlightModel } from "./sim/flightmodel";

const DEG = Math.PI / 180;

/** Piecewise-linear lookup over a flat [v0, a0, v1, a1, ...] table. */
function lookup(table: number[], v: number) {
  const n = table.length / 2;
  if (v <= table[0]) return table[1];
  for (let i = 0; i < n - 1; i++) {
    const v0 = table[2 * i], a0 = table[2 * i + 1], v1 = table[2 * i + 2], a1 = table[2 * i + 3];
    if (v <= v1) return a0 + ((a1 - a0) * (v - v0)) / (v1 - v0);
  }
  return table[2 * n - 1];
}

export interface Pickable {
  node: THREE.Object3D;
  control: string;
  data: Record<string, unknown>;
}

/** Binds the interior GLB to the flight model: instruments out, controls in. */
export class Cockpit {
  readonly root: THREE.Object3D;
  private needles: Part[] = [];
  private cards: Part[] = [];
  private attRoll: Part[] = [];
  private attPitch: Part[] = [];
  private controls: Map<string, Part>;
  readonly eyes = new Map<string, THREE.Object3D>();
  private smooth = new Map<string, number>();

  constructor(root: THREE.Object3D) {
    this.root = root;
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.receiveShadow = true;
        o.castShadow = false;
      }
      const d = o.userData as Record<string, unknown>;
      if (typeof d.seat === "string" && !(o instanceof THREE.Mesh)) this.eyes.set(d.seat as string, o);
    });
    const inst = collectParts(root, "instrument");
    for (const p of inst.values()) {
      if (p.data.needle !== undefined) this.needles.push(p);
      else if (p.data.card) this.cards.push(p);
      else if (p.data.att === "roll") this.attRoll.push(p);
      else if (p.data.att === "pitch") this.attPitch.push(p);
    }
    this.controls = collectParts(root, "control");
  }

  /** Map a picked mesh to the control node it belongs to. */
  pick(obj: THREE.Object3D | null): Pickable | null {
    for (let o = obj; o; o = o.parent) {
      const d = o.userData as Record<string, unknown>;
      if (typeof d.control === "string") return { node: o, control: d.control, data: d };
    }
    return null;
  }

  private value(fm: FlightModel, src: string) {
    const r = fm.readout as Record<string, number | boolean>;
    const v = r[src];
    return typeof v === "number" ? v : 0;
  }

  /** Instruments lag slightly like real mechanical gauges. */
  private lag(key: string, v: number, dt: number, tau = 0.25) {
    const prev = this.smooth.get(key);
    const out = prev === undefined ? v : prev + (v - prev) * (1 - Math.exp(-dt / tau));
    this.smooth.set(key, out);
    return out;
  }

  update(fm: FlightModel, dt: number) {
    for (const p of this.needles) {
      const src = p.data.source as string | undefined;
      if (!src) continue;
      const v = this.lag(p.node.name, this.value(fm, src), dt);
      let deg: number;
      if (typeof p.data.period === "number") {
        const per = p.data.period as number;
        deg = (360 * (((v % per) + per) % per)) / per;
      } else {
        deg = lookup(p.data.scale as number[], v);
      }
      rotatePart(p, -deg * DEG); // clockwise as seen by the crew
    }
    const r = fm.readout;
    for (const p of this.cards) rotatePart(p, this.lag(p.node.name, r.heading_deg, dt, 0.4) * DEG);
    for (const p of this.attRoll) rotatePart(p, r.roll_deg * DEG);
    for (const p of this.attPitch) rotatePart(p, Math.max(-60, Math.min(60, r.pitch_deg)) * DEG);

    // Control positions follow the sim controls.
    const c = fm.controls;
    for (const [name, p] of this.controls) {
      const d = p.data;
      const lo = d.min as number, hi = d.max as number;
      switch (d.control) {
        case "yoke_pitch":
          rotatePart(p, c.elevator * hi);
          break;
        case "yoke_roll":
          rotatePart(p, -c.aileron * hi);
          break;
        case "pedal":
          rotatePart(p, (d.side === "R" ? 1 : -1) * c.rudder * hi);
          break;
        case "throttle":
          rotatePart(p, hi + (lo - hi) * (c.throttle[(d.engine as number) - 1] ?? 0));
          break;
        case "jet_throttle":
          rotatePart(p, lo + (hi - lo) * (c.jetThrottle[(d.engine as number) - 1] ?? 0));
          break;
        case "gear":
          rotatePart(p, c.gearDown ? hi : lo);
          break;
        case "flaps": {
          const moving = Math.abs(c.flaps - fm.flapPos) > 0.005;
          rotatePart(p, moving ? (c.flaps > fm.flapPos ? hi : lo) : 0);
          break;
        }
        case "parking_brake":
          rotatePart(p, c.parkingBrake ? hi : lo);
          break;
        case "trim_elevator":
          rotatePart(p, c.trim * hi);
          break;
        case "tiller":
          rotatePart(p, -c.tiller * hi);
          break;
      }
      void name;
    }
  }
}
