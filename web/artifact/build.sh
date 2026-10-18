#!/usr/bin/env bash
# Build the self-contained page published as the claude.ai artifact (glTF as embedded JSON,
# since .glb is not a served type there). Output: web/artifact/out/
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
OUT=artifact/out
rm -rf "$OUT" && mkdir -p "$OUT/assets" "$OUT/models"
cp artifact/index.html "$OUT/index.html"
cp dist/assets/index-*.js "$OUT/assets/game.js"
for m in b36 b36_interior; do python3 -I ../tools/glb2json.py "public/models/$m.glb" "$OUT/models/$m.json"; done
echo "built $OUT"
