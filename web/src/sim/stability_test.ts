// Dynamic checks: hands-off stability and control response.
// Run: node --experimental-strip-types src/sim/stability_test.ts
import { FlightModel } from "./flightmodel.ts";

function fly(label: string, setup: (fm: FlightModel) => void, control: (fm: FlightModel, t: number) => void, seconds: number, every = 5) {
  const fm = new FlightModel();
  fm.placeInFlight(3000, 95, 0);
  fm.controls.throttle.fill(0.62);
  setup(fm);
  console.log(`-- ${label}`);
  for (let t = 0; t <= seconds; t += 1 / 60) {
    control(fm, t);
    fm.step(1 / 60);
    const r = fm.readout;
    if (Math.abs(t % every) < 1 / 120 || t + 1 / 60 > seconds) {
      console.log(`t=${t.toFixed(0).padStart(3)}s ias=${r.ias_mph.toFixed(0).padStart(4)} alt=${r.alt_ft.toFixed(0).padStart(6)} vs=${r.vs_fpm.toFixed(0).padStart(6)} pitch=${r.pitch_deg.toFixed(1).padStart(6)} roll=${r.roll_deg.toFixed(1).padStart(6)} hdg=${r.heading_deg.toFixed(0).padStart(4)} aoa=${r.alpha_deg.toFixed(1)}`);
    }
  }
  return fm;
}

const probe = new FlightModel();
const t0 = probe.trimFor(3000, 95);
console.log(`trim: alpha ${(t0.alpha * 57.3).toFixed(2)} deg, CL ${t0.cl.toFixed(3)}, trim ${t0.trim.toFixed(3)}`);
const trimElev = 0;
fly("hands-off from trim", (fm) => { fm.controls.elevator = trimElev; }, () => {}, 60, 10);
fly("full right aileron 3 s then neutral", (fm) => { fm.controls.elevator = trimElev; },
  (fm, t) => { fm.controls.aileron = t < 3 ? 1 : 0; }, 20, 1);
fly("pull 50% for 4 s", (fm) => { fm.controls.elevator = trimElev; },
  (fm, t) => { fm.controls.elevator = trimElev + (t < 4 ? 0.5 : 0); }, 20, 2);
