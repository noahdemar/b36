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
  (sim/perf, sim/stability, sim/engine, sim/gear, sim/autopilot, sim/instructor, sim/damage, flak, weapons/bomb,
  weapons/gunnery, weapons/fighters, crew).
- Hosted page: `web/artifact/build.sh`, then publish web/artifact/out.
- Multiplayer: `cd web && npm run serve` (session server on 8036, see MULTIPLAYER.md); tests
  `node --experimental-strip-types src/net/net_test.ts` and `server/server_test.ts`. The host's browser
  is authoritative; crew poses are always in the aircraft model frame (never world coordinates).
  Any new station control must go through `stationFrame` (keys) or `ctl` (pointer commands) so remote
  crew can use it, and any new visible state must be added to `net/replicate.ts`.
- Windows executable: `cd web && npm run exe` (Node single executable: server/exe.ts entry, game
  embedded as SEA assets, build script exe/build.mjs, output web/exe/out/, not committed).
