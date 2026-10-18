# B-36 project notes for Claude

See SPEC.md for decisions, plan and status.

## Standing constraints (from the user)
- The player camera must never go outside the aircraft or clip through it while inside
  (walking, climbing, tunnel, seated). Enforced by `Crew.clampToHull` (web/src/crew.ts) using the hull
  profile in b36_nav.json; checked in web/src/crew_test.ts. Keep new stations and eye points inside it.
- Every compartment must stay reachable on foot, including the crawl tunnel (crew_test covers the route).
- Python via uv only (uv run, uv pip). No emojis, no em dashes in text.
- Do not guess numbers: tag values SOURCED / MEASURED / DERIVED / ESTIMATED and measure where possible.

## Build and test
- Exterior: `cd tools/model && uv run python build_b36.py`; interior: `uv run python build_interior.py`
  (`--ao-res 0` skips the ~5.5 min AO bake for quick iterations).
- Web: `cd web && npm run build`; tests: `node --experimental-strip-types src/<name>_test.ts`
  (sim/perf, sim/stability, sim/engine, sim/autopilot, sim/instructor, sim/damage, flak, weapons/bomb,
  weapons/gunnery, weapons/fighters, crew).
- Hosted page: `web/artifact/build.sh`, then publish web/artifact/out.
