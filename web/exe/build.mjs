// Packages the session server and the built game into one executable (Node single executable
// application). Run from web/: `npm run exe` (Windows x64), or `node exe/build.mjs linux-x64`.
// Needs `npm run build` first (npm run exe does it). Output: exe/out/.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { build } from "esbuild";

const here = new URL(".", import.meta.url).pathname;
const web = join(here, "..");
const dist = join(web, "dist");
const work = join(here, "build");
const out = join(here, "out");
const cache = join(here, "cache");
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ["win-x64"];
const ver = process.version; // the blob must be made by the same Node version as the runtime it goes into
for (const d of [work, out, cache]) mkdirSync(d, { recursive: true });
if (!existsSync(join(dist, "index.html"))) throw new Error("no web/dist: run npm run build first");

// 1. server + entry as one CommonJS file
await build({ entryPoints: [join(web, "server/exe.ts")], bundle: true, platform: "node", format: "cjs",
  target: "node22", outfile: join(work, "main.cjs"), external: ["node:sea"], logLevel: "warning" });

// 2. SEA blob with every built file as an asset (key = path inside dist, forward slashes)
const assets = {};
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else assets[relative(dist, p).split("\\").join("/")] = p; } };
walk(dist);
const blob = join(work, "sea.blob");
writeFileSync(join(work, "sea-config.json"), JSON.stringify({ main: join(work, "main.cjs"), output: blob,
  disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets }, null, 1));
execFileSync(process.execPath, ["--experimental-sea-config", join(work, "sea-config.json")], { stdio: "inherit" });

// 3. inject into a Node runtime for each target
for (const t of targets) {
  const win = t.startsWith("win");
  let node;
  if (t === `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`) node = process.execPath;
  else if (win) {
    node = join(cache, `node-${ver}-${t}.exe`);
    if (!existsSync(node)) execFileSync("curl", ["-fsSL", "-o", node, `https://nodejs.org/dist/${ver}/${t}/node.exe`], { stdio: "inherit" });
  } else {
    node = join(cache, `node-${ver}-${t}`, "bin", "node");
    if (!existsSync(node)) execFileSync("sh", ["-c", `curl -fsSL https://nodejs.org/dist/${ver}/node-${ver}-${t}.tar.gz | tar -xz -C "${cache}" && mv "${cache}/node-${ver}-${t}" "${cache}/node-${ver}-${t}"`], { stdio: "inherit" });
  }
  const exe = join(out, win ? "B36-Multicrew.exe" : `b36-multicrew-${t}`);
  copyFileSync(node, exe);
  if (win) {
    // node.exe carries the Node.js publisher signature, which injection would leave corrupted; strip it
    // (osslsigncode on Linux/macOS, signtool on Windows) so the result is a plain unsigned executable
    const tmp = exe + ".unsigned";
    try {
      if (process.platform === "win32") execFileSync("signtool", ["remove", "/s", exe], { stdio: "inherit" });
      else { execFileSync("osslsigncode", ["remove-signature", "-in", exe, "-out", tmp], { stdio: "inherit" }); copyFileSync(tmp, exe); rmSync(tmp); }
    } catch { console.log("note: could not strip the Node.js signature (osslsigncode / signtool not found); the exe still runs"); }
  }
  execFileSync(process.execPath, [join(web, "node_modules/postject/dist/cli.js"), exe, "NODE_SEA_BLOB", blob,
    "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", ...(t.startsWith("darwin") ? ["--macho-segment-name", "NODE_SEA"] : [])], { stdio: "inherit" });
  console.log(`${exe}: ${(statSync(exe).size / 1e6).toFixed(1)} MB`);
}
