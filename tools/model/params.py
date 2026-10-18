"""B-36 dimensions in meters. Blender axes: +Y forward, +X right, +Z up.

Tags: SOURCED (published spec), MEASURED (pixel-measured from the General Dynamics three-view,
reference/raw/ref04.png, see reference/MEASUREMENTS.md), DERIVED, ESTIMATED (no reference yet).
Longitudinal positions are given as `d` = distance aft of the nose tip.
"""
import math

FT = 0.3048

# --- overall ---
LENGTH = 49.40            # SOURCED
SPAN = 70.10              # SOURCED
HEIGHT = 14.25            # SOURCED

NOSE_Y = LENGTH / 2       # origin at mid-length

# --- fuselage ---
FUS_R = 1.87              # MEASURED (3.75 m dia; single text source said 3.5 m)
GROUND_Z = -4.2           # MEASURED static ground line

# Fuselage stations (d, radius, center z). MEASURED from side + plan views.
# Top line stays straight to the tail; the belly sweeps up.
FUS_STATIONS = [
    (0.00, 0.05, 0.32),
    (0.31, 0.24, 0.26),
    (0.52, 0.64, 0.16),
    (0.73, 0.86, 0.13),
    (0.94, 1.04, 0.06),
    (1.36, 1.23, 0.00),
    (1.77, 1.44, 0.00),
    (2.19, 1.55, 0.00),
    (2.61, 1.68, 0.00),
    (3.45, 1.80, 0.00),
    (4.20, 1.87, 0.00),
    (33.7, 1.87, 0.00),
    (35.8, 1.82, 0.05),
    (36.85, 1.72, 0.15),
    (37.9, 1.655, 0.215),
    (38.9, 1.60, 0.27),
    (40.6, 1.445, 0.425),
    (42.3, 1.285, 0.585),
    (44.0, 1.12, 0.75),
    (45.6, 0.96, 0.91),
    (46.5, 0.85, 1.00),
    (47.3, 0.74, 1.01),
    (48.3, 0.52, 1.02),
]
FUS_SEGMENTS = 96

# --- wing --- planform MEASURED; section data SOURCED
WING_LE_D0 = 16.55        # LE at centerline (extrapolated)
WING_LE_SWEEP = 0.2605    # dd/dx, 14.6 deg
WING_TE_D0 = 26.29
WING_TE_SWEEP = 0.0507    # 2.9 deg
WING_TIP_ROUND_X = 33.6   # tip rounding starts here
ROOT_TC = 0.22            # SOURCED 63(420)-422
TIP_TC = 0.17             # SOURCED 63(420)-517
SEMISPAN = SPAN / 2
DIHEDRAL = math.radians(2.0)   # SOURCED (front view measures ~1.7)
INCIDENCE = math.radians(3.0)  # SOURCED
WASHOUT = math.radians(2.0)    # SOURCED
WING_Z = 0.55             # MEASURED (side view root section)
CAMBER = 0.022            # ESTIMATED visual stand-in for a=0.4 camber line

HINGE_FRAC = 0.74         # ESTIMATED
FLAP_SPANS = [(2.2, 6.6), (8.75, 12.5), (14.65, 18.55), (20.75, 23.5)]  # ESTIMATED (between nacelles)
AILERON_SPAN = (23.7, 33.4)  # ESTIMATED

# --- engines ---
ENGINE_X = [7.69, 13.57, 19.64]  # MEASURED
PROP_DIAM = 19 * FT              # SOURCED
PROP_AFT_OF_TE = 1.0             # MEASURED
NACELLE_W = 1.9                  # MEASURED (engine templates)

JETPOD_X = 25.8                  # MEASURED
JETPOD_FRONT_D = 20.2            # MEASURED
JETPOD_DROP = 2.4                # MEASURED (pod centerline below wing chord line, +-0.3)
JET_R = 0.56                     # ESTIMATED
JET_LEN = 5.8                    # ESTIMATED: plan view shows 4.8 m (partly hidden); photos suggest ~prop diameter

# --- vertical tail --- MEASURED from side view
FIN_ROOT_Z = 1.2
# Leading edge (z, d) incl. dorsal fillet, and trailing edge/top contour (z, d)
FIN_LE = [(1.2, 33.4), (1.87, 34.2), (2.19, 36.85), (3.05, 38.94), (4.23, 40.6), (5.40, 41.86),
          (7.0, 42.7), (8.61, 43.53), (9.58, 44.37), (9.9, 45.2), (9.95, 45.6)]
FIN_TE = [(1.2, 48.37), (1.87, 48.30), (8.5, 47.64), (8.72, 47.3), (9.36, 46.9), (9.68, 46.5),
          (9.9, 45.9), (9.95, 45.6)]
FIN_MAX_THICK = 0.75      # ESTIMATED cap so the long fillet stays thin
RUDDER_HINGE_D = 45.1     # MEASURED
RUDDER_Z = (2.3, 9.55)    # MEASURED/ESTIMATED

# --- horizontal tail --- MEASURED from plan view
HT_LE_D0 = 41.2
HT_LE_SWEEP = 0.211       # 11.9 deg
HT_TE_D0 = 47.23
HT_TE_SWEEP = -0.146      # trailing edge swept forward 8.3 deg
HT_SEMISPAN = 11.2
HT_TIP_ROUND_X = 9.3
HT_Z = 1.0                # MEASURED (side view section)
ELEVATOR_FRAC = 0.70      # ESTIMATED

# --- gear --- (ESTIMATED)
MAIN_GEAR_X = 5.2
MAIN_GEAR_D = 25.6
MAIN_WHEEL_R = 0.70
NOSE_GEAR_D = 5.6
NOSE_WHEEL_R = 0.55

# --- bomb bays: (start d, end d). ESTIMATED ---
BOMB_BAYS = [(13.6, 17.9), (18.1, 22.4), (26.6, 30.0), (30.2, 33.6)]
BOMB_DOOR_HALF_ANGLE = math.radians(52)

# --- canopy --- MEASURED (side + plan). Built into the fuselage loft as a hump on the top line.
# (d, hump height above the circular section at the top centerline)
CANOPY_HUMP = [(2.19, 0.0), (2.40, 0.15), (2.61, 0.30), (2.82, 0.37), (3.03, 0.44), (3.35, 0.51),
               (3.85, 0.57), (4.49, 0.43), (5.0, 0.32), (5.32, 0.22), (5.53, 0.11), (5.74, 0.0)]
CANOPY_HALF_ANGLE = math.radians(55)  # hump fades to zero here (plan width 2.8 m)
CANOPY_D = 3.95
GLAZING_D = (2.42, 5.6)               # glazed hull region
WINDSHIELD_D = 1.95                   # crown glazing extends forward to here (front windshield panes)
WINDSHIELD_ANGLE = math.radians(46)   # ...within this angle from the top
GLAZING_SILL = math.radians(64)       # glazed above this angle from top (ESTIMATED from photos)
CANOPY_ARCHES_D = [1.95, 2.42, 2.95, 3.5, 4.1, 4.75, 5.6]   # ESTIMATED from flight deck photo
CANOPY_RIBS_DEG = [0, 20, 40, 64]                      # ESTIMATED

RADOME_D = 8.1                     # MEASURED (dashed outline in plan)

# --- sighting blisters and windows: (d, z above fuselage axis, size, role) ESTIMATED ---
# Glazed blisters protrude from the skin; the hull and cabin lining have openings under them.
BLISTERS = [
    (6.4, 0.55, 0.34, "window"), (8.3, 0.55, 0.30, "window"),
    (11.3, 1.15, 0.36, "upper_fwd"),    # forward upper turret sighting stations (upper deck)
    (36.8, 0.85, 0.45, "upper_aft"),    # aft compartment upper sighting stations
    (38.6, -0.25, 0.42, "lower_aft"),   # aft compartment lower sighting stations
]
BLISTER_PROTRUDE = 0.55   # fraction of size the blister stands out from the skin
BLISTER_HOLE = 0.85       # opening radius as a fraction of size

# --- defensive turrets (B-36H): stations aft of the aft compartment moved clear of the cabin ---
TURRET_D = {"upper_fwd": 10.6, "upper_aft": 40.4, "lower_aft": 40.8}

# --- crew compartments ---
AFT_COMP_D = (34.6, 39.6)  # aft pressurized compartment, bulkhead to bulkhead (ESTIMATED)
AFT_FLOOR_Z = -0.60
TUNNEL = {"x": -0.60, "z": 1.25, "r": 0.33, "d": (12.4, 34.6)}  # crew tunnel over the bomb bays (ESTIMATED)
