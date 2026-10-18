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
python3 -I ../tools/glb2json.py public/models/b36.gltf "$OUT/models/b36.json"
python3 -I ../tools/glb2json.py public/models/b36_interior.glb "$OUT/models/b36_interior.json" --images interior_images
cp -r public/models/textures "$OUT/models/textures"
cp public/models/b36_nav.json "$OUT/models/b36_nav.json"
echo "built $OUT"
