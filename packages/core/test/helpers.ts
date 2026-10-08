// Deterministic clock + WebSocket fakes and fixture loaders (ported from meridian-k3/mm-bot/test/fakes.ts).
import { readFileSync } from "node:fs";
import type { Clock, FetchLike, WsLike } from "../src/util/runtime";

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

/** Lets async work settle. */
export const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** Waits (real time, bounded) until the socket has sent `n` frames. */
export async function sentAtLeast(ws: FakeWs, n = 1, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (ws.sent.length < n) {
    if (Date.now() > end) throw new Error(`socket sent ${ws.sent.length} frames, expected ≥ ${n}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** A FetchLike that answers from a function and records every call. */
export function fakeFetch(reply: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => { status: number; body: unknown; headers?: Record<string, string> }) {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body?: string } }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = reply(url, init);
    const h = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: r.status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)), headers: { get: (n: string) => h[n.toLowerCase()] ?? null } };
  };
  return Object.assign(f, { calls });
}

const root = new URL("../fixtures/", import.meta.url);
export const fixtureText = (p: string) => readFileSync(new URL(p, root), "utf8");
export const fixtureJson = <T = Record<string, unknown>>(p: string) => JSON.parse(fixtureText(p)) as T;
export const fixtureLines = <T = { recvMs: number; frame: Record<string, unknown> }>(p: string) =>
  fixtureText(p)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);

/** Repo file (deployments/, abis/, indexer/abis/). */
export const repoJson = <T = unknown>(p: string) => JSON.parse(readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8")) as T;

/** Deterministic "random" bytes for nonces in tests. */
export const seqBytes = (n: number, start = 0) => Uint8Array.from({ length: n }, (_, i) => (i + start) % 256);

/** Seeded PRNG (mulberry32) for property tests; fast-check isn't in the repo. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** integer in [lo, hi] */
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const big = (lo: bigint, hi: bigint) => lo + (BigInt(Math.floor(next() * 2 ** 52)) * (hi - lo + 1n)) / 2n ** 52n;
  return { next, int, big };
}
