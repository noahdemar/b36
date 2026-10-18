// B-36 flight model parameters. SI units.
// Tags: SOURCED (published spec), DERIVED (computed from sourced values),
// ESTIMATED (typical values for the class; tuned by sim/perf_test.ts against published performance).

const LB = 0.45359237;
const HP = 745.7;
const LBF = 4.44822;

export const AIRCRAFT = {
  massEmpty: 166_165 * LB, // SOURCED
  massMaxTakeoff: 410_000 * LB, // SOURCED
  massDefault: 262_500 * LB, // SOURCED "loaded (combat) weight"

  wingArea: 443.3, // SOURCED
  span: 70.1, // SOURCED
  get aspectRatio() {
    return (this.span * this.span) / this.wingArea; // DERIVED 11.08
  },
  mac: 6.81, // DERIVED from measured planform (taper 0.245)

  // Lift. CLalpha from finite-wing formula 2*pi*AR / (2 + sqrt(AR^2 + 4)) (DERIVED).
  clAlpha: 5.25,
  cl0: 0.22, // ESTIMATED: camber + 3 deg incidence, at fuselage-reference alpha 0
  clMaxClean: 1.45, // ESTIMATED
  clMaxFlaps: 2.0, // ESTIMATED (full flap)
  clFlaps: 0.55, // ESTIMATED CL increment at full flap
  alphaStallDeg: 13, // ESTIMATED (clean, body reference)

  // Drag
  cd0: 0.026, // ESTIMATED; fitted so vmax = 434 mph (pub 435) and ceiling = 44,300 ft (pub 43,600)
  oswald: 0.78, // ESTIMATED
  cdFlaps: 0.045, // ESTIMATED at full flap
  cdGear: 0.018, // ESTIMATED gear down
  cdBombDoors: 0.008, // ESTIMATED

  // Pitch (per rad / normalized rates)
  cm0: 0.02, // ESTIMATED
  cmAlpha: -1.1, // ESTIMATED
  cmQ: -22, // ESTIMATED
  cmElevator: -1.4, // ESTIMATED per rad of elevator
  cmFlaps: -0.08, // ESTIMATED nose-down from flaps
  elevatorMax: (25 * Math.PI) / 180,
  trimMax: (8 * Math.PI) / 180, // equivalent elevator from trim tab

  // Lateral / directional
  cyBeta: -0.65,
  clBeta: -0.09,
  clP: -0.55,
  clR: 0.12,
  clAileron: 0.13,
  aileronMax: (20 * Math.PI) / 180,
  cnBeta: 0.085,
  cnR: -0.13,
  cnP: -0.03,
  cnRudder: -0.075,
  cnAileron: -0.008, // adverse yaw
  rudderMax: (25 * Math.PI) / 180,

  // Inertia: radii of gyration as fractions of span/length (ESTIMATED, typical for transports)
  rgRoll: 0.16 * 70.1,
  rgPitch: 0.19 * 49.4,
  rgYaw: 0.25 * 70.1,

  // Centre of gravity, body coordinates relative to the model origin (mid-length).
  // three.js body axes: +x right, +y up, +z aft. CG at ~30% MAC (DERIVED from planform).
  cg: [0, 0.2, -2.4] as const,

  // Landing gear contact points (model coords, wheel bottom). From tools/model/params.py.
  gear: [
    { name: "nose", pos: [0, -4.2 + 0.0, 5.6 - 24.7] as const, steer: true },
    { name: "mainL", pos: [-5.2, -4.2, 25.6 - 24.7] as const, steer: false },
    { name: "mainR", pos: [5.2, -4.2, 25.6 - 24.7] as const, steer: false },
  ],
  gearK: 2.2e6, // N/m per leg, ESTIMATED
  gearC: 3.6e5, // N s/m per leg, ESTIMATED
  rollFriction: 0.02,
  brakeFriction: 0.45,
  lateralFriction: 0.7,
  noseSteerMax: (45 * Math.PI) / 180, // via tiller; rudder pedals give a smaller range
  pedalSteerMax: (8 * Math.PI) / 180,

  // Engines
  piston: {
    count: 6,
    powerTakeoff: 3800 * HP, // SOURCED R-4360-53 takeoff
    criticalAltitude: 10_700, // ESTIMATED turbosupercharged critical altitude (m)
    propDiameter: 19 * 0.3048, // SOURCED
    propEtaMax: 0.78, // ESTIMATED; fitted with cd0 (see perf_test)
    staticFigureOfMerit: 0.72, // ESTIMATED
    rpmIdle: 700,
    rpmMax: 2700, // R-4360 takeoff rpm (ESTIMATED from type data)
    spoolTau: 1.5,
    // x positions of engines 1..6 (left outboard to right outboard), body coords
    x: [-19.64, -13.57, -7.69, 7.69, 13.57, 19.64],
  },
  jet: {
    count: 4,
    thrustMax: 5_200 * LBF, // SOURCED J47-GE-19
    spoolUpTau: 3.5, // ESTIMATED
    spoolDownTau: 2.0,
    x: [-26.33, -25.27, 25.27, 26.33],
  },
};

export type AircraftParams = typeof AIRCRAFT;
