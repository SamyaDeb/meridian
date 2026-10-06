import { describe, expect, it, vi } from "vitest";
import { GECKO_QUERIES } from "./reference";
import { CACHE_TTL_MS, COOLDOWN_MS, STALE_MAX_MS, UPSTREAM_PER_MIN, createReferenceCache } from "./referenceCache";

const Q = { timeframe: "minute", aggregate: 1 } as const;
const okBody = (n: number) => ({ data: { id: "secret-id", attributes: { ohlcv_list: [[n, 1, 1, 1, 1, 1]] } }, meta: { base: {} } });
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function setup(responses: (() => Response | Promise<Response>)[]) {
  let t = 1_000_000;
  const fetchFn = vi.fn(async () => responses.shift()!());
  vi.spyOn(console, "info").mockImplementation(() => {});
  const cache = createReferenceCache(fetchFn as unknown as typeof fetch, () => t);
  return { cache, fetchFn, advance: (ms: number) => (t += ms) };
}

describe("reference cache (keyless GeckoTerminal budget is shared by every viewer)", () => {
  it("one upstream call per query per TTL; returns only the candle rows", async () => {
    const { cache, fetchFn, advance } = setup([() => res(200, okBody(1)), () => res(200, okBody(2))]);
    const a = await cache.get(Q);
    expect(a).toEqual({ status: 200, body: { data: { attributes: { ohlcv_list: [[1, 1, 1, 1, 1, 1]] } } }, stale: false });
    advance(CACHE_TTL_MS - 1);
    await cache.get(Q);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    advance(1);
    expect(await cache.get(Q)).toMatchObject({ status: 200, stale: false, body: { data: { attributes: { ohlcv_list: [[2, 1, 1, 1, 1, 1]] } } } });
    expect(cache.upstreamCalls).toBe(2);
  });
  it("concurrent misses share one fetch", async () => {
    const { cache, fetchFn } = setup([() => res(200, okBody(1))]);
    await Promise.all([cache.get(Q), cache.get(Q), cache.get(Q)]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("429 serves the cached copy (stale) if there is one, else 503 rate limited", async () => {
    const { cache, advance } = setup([() => res(429, { status: { error_message: "x" } }), () => res(200, okBody(1)), () => res(429, {})]);
    expect(await cache.get(Q)).toEqual({ status: 503, error: "rate limited" });
    advance(COOLDOWN_MS);
    await cache.get(Q);
    advance(CACHE_TTL_MS);
    expect(await cache.get(Q)).toMatchObject({ status: 200, stale: true });
  });
  it("after a 429 nothing goes upstream for COOLDOWN_MS, for any query", async () => {
    const { cache, fetchFn, advance } = setup([() => res(429, {}), () => res(200, okBody(1))]);
    expect(await cache.get(Q)).toEqual({ status: 503, error: "rate limited" });
    expect(await cache.get({ timeframe: "day", aggregate: 1 })).toEqual({ status: 503, error: "rate limited" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    advance(COOLDOWN_MS);
    expect(await cache.get(Q)).toMatchObject({ status: 200, stale: false });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("the whole server stays within UPSTREAM_PER_MIN calls per rolling minute", async () => {
    const { cache, fetchFn, advance } = setup(Array.from({ length: 20 }, (_, i) => () => res(200, okBody(i))));
    for (const q of GECKO_QUERIES.slice(0, UPSTREAM_PER_MIN)) await cache.get(q); // 6 distinct misses: the budget
    expect(await cache.get(GECKO_QUERIES[UPSTREAM_PER_MIN]!)).toEqual({ status: 503, error: "rate limited" });
    expect(fetchFn).toHaveBeenCalledTimes(UPSTREAM_PER_MIN);
    advance(CACHE_TTL_MS);
    expect(await cache.get(Q)).toMatchObject({ status: 200, stale: false }); // a minute later the window has room again
  });
  it("never echoes the upstream body on errors; a copy older than STALE_MAX is not served", async () => {
    const { cache, advance } = setup([() => res(200, okBody(1)), () => res(500, { leak: "body" }), () => Promise.reject(new Error("net")), () => res(200, { nope: 1 })]);
    await cache.get(Q);
    advance(STALE_MAX_MS + 1);
    expect(await cache.get(Q)).toEqual({ status: 502, error: "upstream 500" });
    expect(await cache.get(Q)).toEqual({ status: 502, error: "upstream unreachable" });
    expect(await cache.get(Q)).toEqual({ status: 502, error: "upstream returned an unexpected shape" });
  });
});
