import type { Controls } from "./sim/flightmodel";

/** Keyboard flight input. Axes ramp toward the key target and self-center when released. */
export const KEY_HELP: [string, string][] = [
  ["W / S  or  Up / Down", "Push / pull (elevator)"],
  ["A / D  or  Left / Right", "Roll (ailerons)"],
  ["Q / E", "Rudder and nose wheel steering"],
  ["PgUp / PgDn  or  + / -", "Piston throttles (all six)"],
  ["Shift + PgUp / PgDn", "Jet throttles (0 = shut down)"],
  ["Home / End", "Elevator trim"],
  ["G", "Landing gear"],
  ["F / Shift+F", "Flaps down / up one step"],
  ["B (hold)", "Wheel brakes"],
  ["P", "Parking brake"],
  ["Y", "Mouse yoke on / off"],
  ["Z", "Autopilot on / off (holds altitude and heading)"],
  ["N", "Start a bomb run (airborne, 15 km from the range; fighters intercept)"],
  ["L", "Fighter attack: 32,000 ft, three waves of MiG-15s"],
  ["At a gun station", "Mouse aims (click locks the pointer), hold left button or Space fires, wheel sets range (frame the wings in the diamonds), G range assist, U turrets out/in, Shift+wheel zoom"],
  ["X", "Stand up from a seat"],
  ["E (walking)", "Sit down / use ladder / enter tunnel hatch"],
  ["Click a seat, ladder or hatch", "Walk there and use it"],
  ["Tab", "Crew stations: walk to any station (ladder and tunnel included)"],
  ["W A S D (walking)", "Walk; Shift faster, Ctrl crouch"],
  ["C", "Pilot or gun station: cockpit / third person (mouse aim). Elsewhere: inside / outside"],
  ["Shift+T", "Time of day"],
  ["R / Shift+R", "Reset on runway (engines running / cold and dark)"],
  ["At the engineer's seat", "1-6 engine, M mixture, I ignition, Enter starter, [ ] cowl flaps (see HUD)"],
  ["Right-drag, wheel", "Look around, zoom"],
  ["Left-click / drag", "Operate cockpit controls"],
  ["H", "Show / hide this help"],
];

export class KeyboardInput {
  private down = new Set<string>();
  private pressed: string[] = [];
  mouseYoke = false;
  mouseYokeXY = { x: 0, y: 0 };

  constructor(target: Window = window) {
    target.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.push(e.code + (e.shiftKey ? "+S" : ""));
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Space", "Tab"].includes(e.code)) e.preventDefault();
    });
    target.addEventListener("keyup", (e) => this.down.delete(e.code));
    target.addEventListener("blur", () => this.down.clear());
  }

  isDown(code: string) {
    return this.down.has(code);
  }

  /** Hands off the flight controls (crew member away from a pilot seat). */
  neutral(c: Controls, dt: number) {
    const back = (v: number) => v - Math.sign(v) * Math.min(Math.abs(v), 3 * dt);
    c.elevator = back(c.elevator);
    c.aileron = back(c.aileron);
    c.rudder = back(c.rudder);
    c.brakes = 0;
    this.mouseYoke = false;
  }

  /** Key presses since the last call, in order, repeats kept ("+S" suffix when Shift held). */
  takePressed(): string[] {
    const p = this.pressed;
    this.pressed = [];
    return p;
  }

  private axis(neg: string[], pos: string[]) {
    const n = neg.some((k) => this.down.has(k));
    const p = pos.some((k) => this.down.has(k));
    return (p ? 1 : 0) - (n ? 1 : 0);
  }

  apply(c: Controls, dt: number, pressedList: string[]) {
    const pressed = new Set(pressedList);
    const ramp = (cur: number, target: number, rate: number) => {
      const r = (target === 0 ? 3.0 : rate) * dt;
      return cur + Math.max(-r, Math.min(r, target - cur));
    };
    if (this.mouseYoke) {
      c.elevator = -this.mouseYokeXY.y;
      c.aileron = this.mouseYokeXY.x;
    } else {
      c.elevator = ramp(c.elevator, this.axis(["KeyW", "ArrowUp"], ["KeyS", "ArrowDown"]), 1.2);
      c.aileron = ramp(c.aileron, this.axis(["KeyA", "ArrowLeft"], ["KeyD", "ArrowRight"]), 1.5);
    }
    c.rudder = ramp(c.rudder, this.axis(["KeyQ"], ["KeyE"]), 1.2);
    c.brakes = this.down.has("KeyB") ? 1 : 0;

    // Held keys move throttles and trim continuously (full travel in ~2.5 s), independent of key repeat.
    const shift = this.down.has("ShiftLeft") || this.down.has("ShiftRight");
    const thr = this.axis(["PageDown", "Minus", "NumpadSubtract"], ["PageUp", "Equal", "NumpadAdd"]);
    if (thr && shift) c.jetThrottle = c.jetThrottle.map((t) => clamp01(t + 0.4 * thr * dt));
    else if (thr) c.throttle = c.throttle.map((t) => clamp01(t + 0.4 * thr * dt));
    const trim = this.axis(["End"], ["Home"]);
    if (trim) c.trim = Math.max(-1, Math.min(1, c.trim + 0.25 * trim * dt));
    if (pressed.has("KeyG")) c.gearDown = !c.gearDown;
    if (pressed.has("KeyF")) c.flaps = clamp01(Math.round((c.flaps + 0.25) * 4) / 4);
    if (pressed.has("KeyF+S")) c.flaps = clamp01(Math.round((c.flaps - 0.25) * 4) / 4);
    if (pressed.has("KeyP")) c.parkingBrake = !c.parkingBrake;
    if (pressed.has("KeyY")) this.mouseYoke = !this.mouseYoke;
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
