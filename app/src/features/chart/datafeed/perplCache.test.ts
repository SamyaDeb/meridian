import { describe, expect, it, vi } from "vitest";
import { BOOK_STALE_MAX_MS, BOOK_TTL_MS, CANDLES_TTL_MS, CONTEXT_TTL_MS, COOLDOWN_MS, UPSTREAM_PER_MIN, createPerplCache } from "./perplCache";

const CONTEXT = { chain: { chain_id: 143 }, markets: [{ id: 10, symbol: "", name: "MON", config: { price_decimals: 6, size_decimals: 0 } }], tokens: [{ secret: true }] };
const candles = (o: number) => ({ mt: 12, r: 60, at: { b: 1, t: 1 }, d: [{ t: 60_000, o, h: o, l: o, c: o, v: "1", n: 1 }] });
const book = (sn: number) => ({ mt: 15, sn, at: { b: sn, t: 5 }, bid: [{ p: 27_000, s: 10, o: 1 }], ask: [{ p: 27_100, s: 5, o: 1 }] });
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/** Routes each upstream URL to a handler; counts calls per kind. */
function setup(handlers: { context?: () => Response; candles?: () => Response; book?: () => Response }) {
  let t = 1_000_000_000;
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string) => {
    const kind = url.includes("/pub/context") ? "context" : url.includes("/candles/") ? "candles" : "book";
    calls.push(kind);
    const h = handlers[kind as keyof typeof handlers];
    if (!h) throw new Error("network down");
    return h();
  });
  const cache = createPerplCache(fetchFn as unknown as typeof fetch, () => t);
  return { cache, calls, advance: (ms: number) => (t += ms) };
}

describe("Perpl cache (unpublished REST limits shared by every viewer)", () => {
  it("resolves the market once and returns only our trimmed fields", async () => {
    const { cache, calls } = setup({ context: () => res(200, CONTEXT), candles: () => res(200, candles(27_000)), book: () => res(200, book(7)) });
    const c = await cache.candles(60);
    expect(c).toEqual({ status: 200, stale: false, body: { market: { id: 10, name: "MON", priceDecimals: 6, sizeDecimals: 0 }, r: 60, d: [{ t: 60_000, o: 27_000, h: 27_000, l: 27_000, c: 27_000 }] } });
    const b = await cache.book();
    expect(b).toMatchObject({ status: 200, body: { block: 7, timeMs: 5, bid: [{ p: 27_000, s: 10, o: 1 }] } });
    expect(JSON.stringify(b)).not.toContain("mt");
    expect(calls).toEqual(["context", "candles", "book"]);
  });
  it("one upstream call per key per TTL; concurrent misses share a fetch", async () => {
    const { cache, calls, advance } = setup({ context: () => res(200, CONTEXT), candles: () => res(200, candles(1)), book: () => res(200, book(1)) });
    await Promise.all([cache.book(), cache.book(), cache.book()]);
    advance(BOOK_TTL_MS - 1);
    await cache.book();
    expect(calls.filter((c) => c === "book")).toHaveLength(1);
    advance(1);
    await cache.book();
    expect(calls.filter((c) => c === "book")).toHaveLength(2);
    await cache.candles(60);
    advance(CANDLES_TTL_MS - 1);
    await cache.candles(60);
    expect(calls.filter((c) => c === "candles")).toHaveLength(1);
    await cache.candles(300); // a different resolution is its own key
    expect(calls.filter((c) => c === "candles")).toHaveLength(2);
    advance(CONTEXT_TTL_MS);
    await cache.book();
    expect(calls.filter((c) => c === "context")).toHaveLength(2);
  });
  it("429 ⇒ cooldown for every upstream call; serves the last good copy while it is fresh enough, else 503", async () => {
    let status = 200;
    const { cache, calls, advance } = setup({ context: () => res(200, CONTEXT), book: () => (status === 429 ? res(429, {}) : res(200, book(1))) });
    await cache.book();
    status = 429;
    advance(BOOK_TTL_MS);
    expect(await cache.book()).toMatchObject({ status: 200, stale: true });
    const n = calls.length;
    advance(BOOK_TTL_MS);
    expect(await cache.book()).toMatchObject({ status: 200, stale: true }); // in cooldown: no upstream call
    expect(calls.length).toBe(n);
    advance(BOOK_STALE_MAX_MS);
    expect(await cache.book()).toEqual({ status: 503, error: "rate limited" });
    advance(COOLDOWN_MS);
    status = 200;
    expect(await cache.book()).toMatchObject({ status: 200, stale: false });
  });
  it("outage or garbled body with nothing cached ⇒ 502 with our own message", async () => {
    const down = setup({ context: () => res(200, CONTEXT) });
    expect(await down.cache.book()).toEqual({ status: 502, error: "Perpl unreachable" });
    const garbled = setup({ context: () => res(200, CONTEXT), book: () => res(200, { hello: "world" }) });
    expect(await garbled.cache.book()).toEqual({ status: 502, error: "Perpl book: unexpected shape" });
    const notReady = setup({ context: () => res(200, CONTEXT), book: () => res(503, {}) });
    expect(await notReady.cache.book()).toEqual({ status: 503, error: "Perpl not ready" });
  });
  it("no single MON market ⇒ 502, never a guessed market", async () => {
    const { cache, calls } = setup({ context: () => res(200, { markets: [] }), book: () => res(200, book(1)) });
    expect(await cache.book()).toEqual({ status: 502, error: "no single Perpl market named MON" });
    expect(calls).not.toContain("book");
  });
  it("failures are not cached, so the per-minute budget caps upstream calls (then 503 until the window rolls)", async () => {
    const { cache, calls, advance } = setup({ context: () => res(200, CONTEXT), book: () => res(500, {}) });
    const last = [];
    for (let i = 0; i < 100; i++) last.push(await cache.book());
    expect(calls.length).toBe(UPSTREAM_PER_MIN);
    expect(last.at(-1)).toEqual({ status: 503, error: "rate limited" });
    advance(60_000);
    await cache.book();
    expect(calls.length).toBe(UPSTREAM_PER_MIN + 1);
  });
});
