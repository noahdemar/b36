// Browser side of a multicrew session (see web/server/server.ts). The page connects back to the
// server it was loaded from; if there is no session server (vite preview, the hosted page), the game
// runs single player.
import { ClockSync } from "./interp.ts";

export interface RosterEntry { id: number; name: string; host: boolean }
export type NetMsg = Record<string, unknown> & { type: string; from?: number };

export class NetSession {
  id = 0;
  hostId = 0;
  isHost = false;
  connected = false;
  roster: RosterEntry[] = [];
  readonly clock = new ClockSync();
  /** Round-trip time to the server (s), from pings. */
  rtt = 0;
  onMessage: ((m: NetMsg) => void) | null = null;
  onStatus: ((text: string) => void) | null = null;
  private ws: WebSocket | null = null;
  private pingT = 0;
  bytesIn = 0;
  bytesOut = 0;

  static url() {
    const loc = window.location;
    if (loc.protocol !== "http:" && loc.protocol !== "https:") return null;
    if ((window as unknown as { B36_MODELS?: unknown }).B36_MODELS) return null; // hosted page: single player
    return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/ws`;
  }

  /** Resolves true when welcomed by a session server, false if there is none. */
  connect(url: string, name: string, timeoutMs = 2500): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { finish(false); return; }
      this.ws = ws;
      const timer = setTimeout(() => { if (!this.connected) { ws.close(); finish(false); } }, timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify({ type: "hello", name }));
      ws.onerror = () => finish(false);
      ws.onclose = (e) => {
        clearTimeout(timer);
        if (this.connected) this.onStatus?.(e.reason ? `Disconnected: ${e.reason}` : "Disconnected from the session server");
        this.connected = false;
        finish(false);
      };
      ws.onmessage = (e) => {
        const text = String(e.data);
        this.bytesIn += text.length;
        let m: NetMsg;
        try { m = JSON.parse(text); } catch { return; }
        if (m.type === "welcome") {
          this.id = m.id as number;
          this.isHost = !!m.host;
          this.hostId = m.hostId as number;
          this.connected = true;
          clearTimeout(timer);
          finish(true);
          return;
        }
        if (m.type === "roster") { this.roster = m.players as RosterEntry[]; this.hostId = m.hostId as number; }
        if (m.type === "pong") { this.rtt = performance.now() / 1000 - (m.t as number); return; }
        if (m.type === "hostLeft") this.onStatus?.("The host has left the session");
        this.onMessage?.(m);
      };
    });
  }

  send(m: NetMsg) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const text = JSON.stringify(m);
    this.bytesOut += text.length;
    this.ws.send(text);
  }

  /** Once per frame: keep the RTT estimate fresh. */
  tick(nowS: number) {
    if (!this.isHost && nowS - this.pingT > 2) {
      this.pingT = nowS;
      this.send({ type: "ping", t: nowS });
    }
  }
}
