// Flight engineer station: keyboard controls and status text.
import type { KeyboardInput } from "./input";
import type { FlightModel } from "./sim/flightmodel";
import { CHT_LIMIT, MIXTURE_NAMES, RPM_LEVER } from "./sim/powerplant";

export const FE_HELP =
  "1-6 select engine, 0 all   Up/Down throttle   PgUp/PgDn rpm   Home/End turbo boost   [ ] cowl flaps\n" +
  "M / Shift+M mixture richer / leaner   I ignition   Enter (hold) starter   F feather\n" +
  ", / . left / right tank   / crossfeed   J automatic engineer";

export class Engineer {
  selected = [0, 1, 2, 3, 4, 5];

  /** Applies the FE seat's keys; returns a message for the crew line, if any. */
  update(fm: FlightModel, input: KeyboardInput, pressed: string[], dt: number): string | null {
    let msg: string | null = null;
    const sel = this.selected.map((i) => fm.pistons[i]);
    for (const k of pressed) {
      const m = /^Digit(\d)/.exec(k);
      if (m) {
        const n = Number(m[1]);
        if (n === 0) this.selected = [0, 1, 2, 3, 4, 5];
        else if (n <= 6) this.selected = [n - 1];
        msg = `ENGINE ${n === 0 ? "ALL" : n} SELECTED`;
      }
      const base = k.replace("+S", "");
      const shift = k.endsWith("+S");
      if (base === "KeyM") {
        for (const e of sel) e.mixture = Math.max(0, Math.min(2, e.mixture + (shift ? -1 : 1))) as 0 | 1 | 2;
        msg = `MIXTURE ${MIXTURE_NAMES[sel[0].mixture]}`;
      }
      if (base === "KeyI") {
        const on = !sel.every((e) => e.ignition);
        for (const e of sel) e.ignition = on;
        msg = `IGNITION ${on ? "ON" : "OFF"}`;
      }
      if (base === "KeyF") {
        const on = !sel.every((e) => e.feather);
        for (const e of sel) e.feather = on;
        msg = on ? "FEATHER (engine shuts down)" : "UNFEATHER";
      }
      if (base === "Comma") { fm.fuel.cycle("L"); msg = `LEFT MANIFOLD: ${fm.fuel.tanks[fm.fuel.selected.L].name}`; }
      if (base === "Period") { fm.fuel.cycle("R"); msg = `RIGHT MANIFOLD: ${fm.fuel.tanks[fm.fuel.selected.R].name}`; }
      if (base === "Slash") { fm.fuel.crossfeed = !fm.fuel.crossfeed; msg = `CROSSFEED ${fm.fuel.crossfeed ? "OPEN" : "CLOSED"}`; }
      if (base === "KeyJ") {
        fm.feAuto = !fm.feAuto;
        fm.fuel.auto = fm.feAuto;
        msg = fm.feAuto ? "AUTOMATIC ENGINEER ON (cowl flaps, tank sequencing)" : "AUTOMATIC ENGINEER OFF";
      }
    }
    const axis = (neg: string, pos: string) => (input.isDown(pos) ? 1 : 0) - (input.isDown(neg) ? 1 : 0);
    const thr = axis("ArrowDown", "ArrowUp");
    const rpm = axis("PageDown", "PageUp");
    const boost = axis("End", "Home");
    const cowl = axis("BracketLeft", "BracketRight");
    const c = fm.controls;
    for (const i of this.selected) {
      const e = fm.pistons[i];
      if (thr) c.throttle[i] = clamp01(c.throttle[i] + thr * 0.4 * dt);
      if (rpm) e.rpmLever = clamp01(e.rpmLever + rpm * 0.4 * dt);
      if (boost) e.boost = clamp01(e.boost + boost * 0.4 * dt);
      if (cowl) e.cowl = clamp01(e.cowl + cowl * 0.5 * dt);
      e.starter = input.isDown("Enter") || input.isDown("NumpadEnter");
    }
    for (let i = 0; i < 6; i++) if (!this.selected.includes(i)) fm.pistons[i].starter = false;
    return msg;
  }

  release(fm: FlightModel) {
    for (const e of fm.pistons) e.starter = false;
  }

  status(fm: FlightModel): string {
    const c = fm.controls;
    const col = (s: string) => s.padStart(6);
    const row = (name: string, f: (i: number) => string) => name.padEnd(9) + fm.pistons.map((_, i) => col(f(i))).join("");
    const p = fm.pistons;
    const state = (i: number) => p[i].failed ? "FAIL" : p[i].running ? "RUN" : p[i].crank > 0 ? "FIRE" : p[i].starter ? "CRANK" : p[i].feather ? "FEATH" : "OFF";
    const lines = [
      row("ENGINE", (i) => (this.selected.includes(i) ? `>${i + 1}` : `${i + 1}`)),
      row("STATE", state),
      row("THROT %", (i) => (c.throttle[i] * 100).toFixed(0)),
      row("RPM", (i) => p[i].rpm.toFixed(0)),
      row("RPM LEV", (i) => (RPM_LEVER[0] + (RPM_LEVER[1] - RPM_LEVER[0]) * p[i].rpmLever).toFixed(0)),
      row("MAP", (i) => p[i].map.toFixed(1)),
      row("BOOST %", (i) => (p[i].boost * 100).toFixed(0)),
      row("MIXTURE", (i) => ["CUT", "LEAN", "RICH"][p[i].mixture]),
      row("IGN", (i) => (p[i].ignition ? "ON" : "OFF")),
      row("COWL %", (i) => (p[i].cowl * 100).toFixed(0)),
      row("CHT C", (i) => p[i].cht.toFixed(0) + (p[i].cht > CHT_LIMIT ? "!" : "")),
      row("OIL C", (i) => p[i].oilT.toFixed(0)),
      row("FF LB/H", (i) => p[i].ff.toFixed(0)),
    ];
    const f = fm.fuel;
    const totalFf = p.reduce((a, e) => a + e.ff, 0);
    lines.push(`FUEL ${f.total.toFixed(0)} lb (L ${f.side("L").toFixed(0)} / R ${f.side("R").toFixed(0)})   ` +
      `L: ${f.tanks[f.selected.L].name}  R: ${f.tanks[f.selected.R].name}   CROSSFEED ${f.crossfeed ? "OPEN" : "CLOSED"}   ` +
      `${totalFf > 0 ? `ENDURANCE ${(f.total / totalFf).toFixed(1)} h` : ""}   AUTO ENGINEER ${fm.feAuto ? "ON" : "OFF"}`);
    return "\n" + lines.join("\n") + "\n" + FE_HELP;
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** One-line engine warning for the pilots. */
export function engineWarnings(fm: FlightModel): string {
  const w: string[] = [];
  fm.pistons.forEach((e, i) => {
    if (e.failed) w.push(`ENG ${i + 1} FAILED`);
    else if (!e.running) w.push(`ENG ${i + 1} OUT`);
    else if (e.cht > CHT_LIMIT) w.push(`ENG ${i + 1} CHT HIGH`);
  });
  if (fm.fuel.total < 5000) w.push(`FUEL LOW ${fm.fuel.total.toFixed(0)} lb`);
  return w.length ? `\nWARNING: ${w.join("  ")}` : "";
}
