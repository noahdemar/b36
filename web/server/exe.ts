// Entry point of the packaged executable (Node single executable application, see exe/build.mjs):
// the built game is embedded as SEA assets and served from memory.
import { spawn } from "node:child_process";
import { getAsset, isSea } from "node:sea";
import { DEFAULT_PORT, printBanner, startServer } from "./server.ts";

const cache = new Map<string, Buffer | null>();
const files = (path: string) => {
  if (!cache.has(path)) {
    let b: Buffer | null = null;
    try { b = Buffer.from(getAsset(path)); } catch { b = null; }
    cache.set(path, b);
  }
  return cache.get(path)!;
};

function openBrowser(url: string) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* no browser launcher */ }
}

function waitAndExit(code: number) {
  console.log("Press Enter to close.");
  process.stdin.once("data", () => process.exit(code));
}

if (!isSea()) {
  console.log("exe.ts runs inside the packaged executable; use `npm run serve` from source.");
  process.exit(1);
}
const port = Number(process.argv[2] ?? process.env.PORT ?? DEFAULT_PORT);
startServer({ port, root: "/game", files }).then(({ port: p }) => {
  printBanner(p);
  console.log("Keep this window open while you play; close it (or Ctrl+C) to end the session.");
  if (!process.env.B36_NO_BROWSER) openBrowser(`http://localhost:${p}`);
}).catch((e: NodeJS.ErrnoException) => {
  console.log(e.code === "EADDRINUSE" ? `Port ${port} is already in use (is another session running?). Start with another port: B36 ${port + 1}` : `Could not start: ${e.message}`);
  waitAndExit(1);
});
