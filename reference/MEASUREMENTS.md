# Three-view measurements (raw/ref04.png, 781x594 px)

Calibration (drawing is slightly anisotropic):
- Horizontal: span 70.10 m = cols 4..659 (655 px) -> 0.10702 m/px. Cross-check: ground-to-fin height 14.1 m vs 14.25 published.
- Vertical: length 49.40 m = nose row 493 to tail-turret row 20 (473 px) -> 0.1044 m/px.
- Plan view centerline col 331.5. Side view (rotated: up = -col) fuselage axis col 700.5, static ground line col ~740.
- `d` = distance aft of nose = (493 - row) * 0.1044.

Results (in tools/model/params.py, tagged MEASURED):
- Fuselage diameter 3.75 m (plan width 36.5 px, side height 35 px). Text source said 3.5 m.
- Top line straight to tail; belly sweeps up from d=33.7 to the tail turret.
- Nose very bluff (r = 1.23 m at d = 1.36). Canopy hump d = 2.3..5.6, 0.54 m above fuselage, 2.8 m wide.
- Wing LE at centerline d = 16.55, sweep 14.6 deg. TE d = 26.29, sweep 2.9 deg. Chord 9.74 m (centerline) to 2.39 m (tip, before rounding).
- Engine stations 7.69 / 13.57 / 19.64 m. Prop disc ~1.0 m aft of TE. Nacelle max width 1.9 m.
- Jet pod station 25.8 m, front at d = 20.2, centerline ~2.4 m below chord line.
- Horizontal tail: LE d = 41.2 (centerline), LE sweep 11.9 deg, TE swept forward 8.3 deg, semispan 11.2 m, rounded tips.
- Vertical tail: LE contour incl. dorsal fillet from d = 34.2, top z = 9.95 m above fuselage axis, rudder hinge d = 45.1.

Measurement precision is about +-1 px: +-0.11 m. Verification: tools/model/compare_blueprint.py renders overlays.
