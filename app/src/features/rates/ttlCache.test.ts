import { describe, expect, it } from "vitest";
import { createTtlCache, isRateLimited } from "./ttlCache";

describe("ttl cache for the Perpl routes", () => {
  it("serves a hit inside the TTL, re-reads after it; concurrent misses share one read", async () => {
    let t = 0;
    let reads = 0;
    const c = createTtlCache<number>({ ttlMs: 5_000, staleMaxMs: 30_000, now: () => t });
    const load = async () => ++reads;
    const [a, b] = await Promise.all([c.get("k", load), c.get("k", load)]);
    expect([a, b].map((x) => x.ok && x.value)).toEqual([1, 1]);
    t = 4_999;
    expect((await c.get("k", load)).ok && reads).toBe(1);
    t = 5_000;
    await c.get("k", load);
    expect(reads).toBe(2);
  });
  it("429 ⇒ exponential backoff per key, last good value served stale meanwhile, then the error", async () => {
    let t = 0;
    const c = createTtlCache<number>({ ttlMs: 1_000, staleMaxMs: 10_000, backoffBaseMs: 2_000, now: () => t });
    await c.get("k", async () => 7);
    t = 2_000;
    const limited = async () => {
      throw new Error("HTTP request failed. Status: 429");
    };
    const r1 = await c.get("k", limited);
    expect(r1).toMatchObject({ ok: true, value: 7, stale: true });
    t = 3_000; // inside the 2 s pause: no read at all
    let called = false;
    await c.get("k", async () => ((called = true), 8));
    expect(called).toBe(false);
    t = 4_000;
    await c.get("k", limited); // second 429 ⇒ 4 s pause
    t = 7_999;
    expect(await c.get("k", async () => 9)).toMatchObject({ ok: true, value: 7, stale: true });
    t = 20_000; // past the pause and past staleMaxMs
    expect(await c.get("k", limited)).toMatchObject({ ok: false, status: 429 });
  });
  it("other failures ⇒ 502 with the describer's message", async () => {
    const c = createTtlCache<number>({ ttlMs: 1, staleMaxMs: 0 });
    expect(await c.get("x", async () => Promise.reject(new Error("boom")), () => "RPC unreachable")).toEqual({ ok: false, status: 502, error: "RPC unreachable" });
  });
  it("recognises a 429 from viem's error text or status", () => {
    expect(isRateLimited(new Error("Status: 429"))).toBe(true);
    expect(isRateLimited(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
    expect(isRateLimited(new Error("fetch failed"))).toBe(false);
  });
});
