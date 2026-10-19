// B-36 multicrew session server, run by the host on their own machine:
//   cd web && npm run serve        (builds the game, then serves it on port 8036)
// Friends open http://<host-ip>:8036 in a browser. The first browser on the host machine itself
// (a loopback address) runs the simulation; everyone else is crew. This process only serves files
// and relays messages: player input to the host, the host's snapshots to the crew.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

export const DEFAULT_PORT = 8036;
const MAX_PLAYERS = 13; // one per crew station
const MAX_CLIENT_MSG = 64 * 1024; // input packets are small; anything larger is dropped
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream", ".wasm": "application/wasm",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

interface Peer { id: number; ws: WebSocket; name: string; host: boolean; addr: string; alive: boolean }

const isLoopback = (a: string) => { const v4 = a.replace(/^::ffff:/, ""); return v4 === "::1" || v4.startsWith("127."); };

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) out.push(i.address);
  }
  return out;
}

export function startServer(opts: { port?: number; root: string; log?: (s: string) => void }) {
  const log = opts.log ?? ((s: string) => console.log(s));
  const root = resolve(opts.root);
  const peers = new Map<number, Peer>();
  let nextId = 1;
  let host: Peer | null = null;

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/session") {
        // lets the page know it was served by a session server (and whether this browser will host)
        const addr = req.socket.remoteAddress ?? "";
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ session: true, players: roster(), willHost: !host && isLoopback(addr) }));
        return;
      }
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith("/")) path += "index.html";
      const file = normalize(join(root, path));
      if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; } // no path traversal
      const st = await stat(file).catch(() => null);
      if (!st || !st.isFile()) { res.writeHead(404).end("not found"); return; }
      res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(await readFile(file));
    } catch {
      res.writeHead(500).end();
    }
  });

  const wss = new WebSocketServer({ server: http, path: "/ws", perMessageDeflate: { threshold: 256 }, maxPayload: 4 * 1024 * 1024 });

  const send = (p: Peer, msg: unknown) => { if (p.ws.readyState === 1) p.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg)); };
  const roster = () => [...peers.values()].map((p) => ({ id: p.id, name: p.name, host: p.host }));
  const broadcastRoster = () => { for (const p of peers.values()) send(p, { type: "roster", players: roster(), hostId: host?.id ?? 0 }); };

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const addr = req.socket.remoteAddress ?? "";
    if (peers.size >= MAX_PLAYERS) { ws.close(4001, "crew is full"); return; }
    const peer: Peer = { id: nextId++, ws, name: `Crew ${nextId - 1}`, host: false, addr, alive: true };
    peers.set(peer.id, peer);
    ws.on("pong", () => { peer.alive = true; });
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      if (!peer.host && data.length > MAX_CLIENT_MSG) return;
      let msg: { type?: string; to?: number; name?: string };
      const text = data.toString();
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.type === "hello") {
        peer.name = String(msg.name ?? peer.name).replace(/[^\w .'-]/g, "").slice(0, 24) || peer.name;
        // the first browser on the host's own machine runs the simulation
        if (!host && isLoopback(addr)) { peer.host = true; host = peer; }
        send(peer, { type: "welcome", id: peer.id, host: peer.host, hostId: host?.id ?? 0 });
        if (host && !peer.host) send(host, { type: "join", id: peer.id, name: peer.name });
        log(`${peer.name} (${addr}) joined${peer.host ? " as host" : ""}; ${peers.size} aboard`);
        broadcastRoster();
        return;
      }
      if (peer.host) {
        // host -> everyone (snapshots, events) or one player (`to`)
        if (msg.to) { const p = peers.get(msg.to); if (p) send(p, text); }
        else for (const p of peers.values()) if (p !== peer) send(p, text);
      } else if (host) {
        // crew -> host, stamped with the sender (clients cannot speak for each other)
        if (msg.type === "ping") { send(peer, { type: "pong", t: (msg as { t?: number }).t }); return; }
        (msg as { from?: number }).from = peer.id; // overwrite any sender the client claimed
        send(host, msg);
      }
    });
    ws.on("close", () => {
      peers.delete(peer.id);
      log(`${peer.name} left; ${peers.size} aboard`);
      if (peer === host) {
        host = null;
        for (const p of peers.values()) send(p, { type: "hostLeft" });
      } else if (host) send(host, { type: "leave", id: peer.id });
      broadcastRoster();
    });
  });

  // drop dead connections
  const beat = setInterval(() => {
    for (const p of peers.values()) {
      if (!p.alive) { p.ws.terminate(); continue; }
      p.alive = false;
      p.ws.ping();
    }
  }, 5000);

  const port = opts.port ?? DEFAULT_PORT;
  return new Promise<{ port: number; close: () => Promise<void> }>((res) => {
    http.listen(port, () => { // all interfaces, IPv4 and IPv6
      const addr = http.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      res({
        port: actual,
        close: () => new Promise<void>((r) => { clearInterval(beat); for (const p of peers.values()) p.ws.terminate(); wss.close(); http.close(() => r()); }),
      });
    });
  });
}

// run directly: node --experimental-strip-types server/server.ts [port]
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? DEFAULT_PORT);
  const root = resolve(fileURLToPath(new URL("../dist", import.meta.url)));
  startServer({ port, root }).then(({ port: p }) => {
    console.log(`B-36 multicrew server on port ${p}`);
    console.log(`  You (host): http://localhost:${p}`);
    for (const a of lanAddresses()) console.log(`  Crew on your network: http://${a}:${p}`);
    console.log("  Crew over the internet: forward TCP port " + p + " on your router to this machine, then share http://<your public IP>:" + p);
  });
}
