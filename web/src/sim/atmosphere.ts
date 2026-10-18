// International Standard Atmosphere, troposphere + lower stratosphere (to 20 km).
export const G0 = 9.80665;
const R = 287.053;
const T0 = 288.15;
const P0 = 101_325;
const L = 0.0065;

export interface Air {
  temperature: number; // K
  pressure: number; // Pa
  density: number; // kg/m^3
  sigma: number; // density ratio
  soundSpeed: number; // m/s
}

export function atmosphere(altitudeM: number): Air {
  const h = Math.max(-500, Math.min(altitudeM, 20_000));
  let T: number;
  let p: number;
  if (h <= 11_000) {
    T = T0 - L * h;
    p = P0 * Math.pow(T / T0, G0 / (L * R));
  } else {
    T = 216.65;
    const p11 = P0 * Math.pow(216.65 / T0, G0 / (L * R));
    p = p11 * Math.exp((-G0 * (h - 11_000)) / (R * T));
  }
  const rho = p / (R * T);
  return { temperature: T, pressure: p, density: rho, sigma: rho / 1.225, soundSpeed: Math.sqrt(1.4 * R * T) };
}
