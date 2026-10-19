// Session server: host assignment, relay both ways, sender stamping, host leaving, file serving.
// Run: node --experimental-strip-types server/server_test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.ts";

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };

const root = mkdtempSync(join(tmpdir(), "b36srv-"));
writeFileSync(join(root, "index.html"), "<html>b36</html>");
const srv = await startServer({ port: 0, root, log: () => {} });
const base = `http://127.0.0.1:${srv.port}`;

type Msg = Record<string, unknown>;
function connect(name: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
  const inbox: Msg[] = [];
  ws.addEventListener("message", (e) => inbox.push(JSON.parse(String(e.data))));
  const open = new Promise<void>((r) => ws.addEventListener("open", () => { ws.send(JSON.stringify({ type: "hello", name })); r(); }));
  const wait = async (pred: (m: Msg) => boolean, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      await new Promise((r) => setTimeout(r, 10));
    }
    return null;
  };
  return { ws, inbox, open, wait };
}

const page = await fetch(base + "/");
check(page.status === 200 && (await page.text()).includes("b36"), "serves the game page");
const trav = await fetch(base + "/..%2f..%2fetc%2fpasswd");
check(trav.status === 403 || trav.status === 404, `path traversal refused (${trav.status})`);

const h = connect("Host Pilot");
await h.open;
const hw = await h.wait((m) => m.type === "welcome");
check(!!hw && hw.host === true, "first loopback browser becomes the host");
const c = connect("Gunner<script>");
await c.open;
const cw = await c.wait((m) => m.type === "welcome");
check(!!cw && cw.host === false && cw.hostId === hw!.id, "second browser joins as crew");
const joinMsg = await h.wait((m) => m.type === "join");
check(!!joinMsg && joinMsg.id === cw!.id && joinMsg.name === "Gunnerscript", `host told about the join (name sanitised: ${joinMsg?.name})`);

c.ws.send(JSON.stringify({ type: "in", keys: ["KeyW"], from: 999 }));
const got = await h.wait((m) => m.type === "in");
check(!!got && got.from === cw!.id, "crew input relayed to the host, stamped with the real sender (not spoofable)");
h.ws.send(JSON.stringify({ type: "snap", t: 1.5 }));
const snap = await c.wait((m) => m.type === "snap");
check(!!snap && snap.t === 1.5, "host snapshot relayed to the crew");
h.ws.send(JSON.stringify({ type: "msg", to: cw!.id, text: "for you" }));
check(!!(await c.wait((m) => m.type === "msg")), "targeted host message delivered");
c.ws.send(JSON.stringify({ type: "ping", t: 42 }));
const pong = await c.wait((m) => m.type === "pong");
check(!!pong && pong.t === 42, "server answers pings");

h.ws.close();
check(!!(await c.wait((m) => m.type === "hostLeft")), "crew told when the host leaves");
c.ws.close();
await srv.close();
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
