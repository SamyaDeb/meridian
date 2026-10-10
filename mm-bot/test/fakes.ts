// Deterministic clock + WebSocket fakes for the Perpl trading client tests.
import type { Clock, WsLike } from "../src/perpl/trading";

export class FakeClock implements Clock {
  t = 1_791_380_000_000;
  private q: { at: number; fn: () => void; id: number }[] = [];
  private id = 0;
  now = () => this.t;
  random = () => 0.5;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.id;
    this.q.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.q = this.q.filter((x) => x.id !== h);
  };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at);
      const next = this.q[0];
      if (!next || next.at > end) break;
      this.q.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

export class FakeWs implements WsLike {
  sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | undefined;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(d: string) {
    this.sent.push(JSON.parse(d) as Record<string, unknown>);
  }
  close(code?: number, reason?: string) {
    this.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
  }
  open() {
    this.onopen?.({});
  }
  msg(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  serverClose(code: number, reason = "") {
    this.onclose?.({ code, reason });
  }
}

/** Lets async work settle (Ed25519 signing via WebCrypto takes several turns of the event loop). */
export const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** Waits (real time, bounded) until the socket has sent `n` frames: the async sign-in can outlast flush() under load. */
export async function sentAtLeast(ws: FakeWs, n = 1, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (ws.sent.length < n) {
    if (Date.now() > end) throw new Error(`socket sent ${ws.sent.length} frames, expected ≥ ${n}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
