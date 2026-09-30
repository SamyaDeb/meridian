import { describe, expect, it } from "vitest";
import {
  RateWindow,
  backoffDelayMs,
  burnPerHourWei,
  createCountingFetch,
  isRetryableStatus,
  mayRetry,
  newRpcStats,
  pruneSamples,
  rpcMethods,
} from "../src/index.js";

const body = (method: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] });

describe("backoffDelayMs (capped exponential, equal jitter)", () => {
  const o = { baseMs: 200, capMs: 4_000 };
  it("doubles per attempt within [d/2, d]", () => {
    expect(backoffDelayMs(0, o, 0)).toBe(100);
    expect(backoffDelayMs(0, o, 1)).toBe(200);
    expect(backoffDelayMs(1, o, 0.5)).toBe(300); // d = 400
    expect(backoffDelayMs(3, o, 1)).toBe(1_600);
  });
  it("is capped and clamps rand", () => {
    expect(backoffDelayMs(10, o, 1)).toBe(4_000);
    expect(backoffDelayMs(10, o, 0)).toBe(2_000);
    expect(backoffDelayMs(2, o, 7)).toBe(800);
    expect(backoffDelayMs(-3, o, 0)).toBe(100);
  });
});

describe("retry policy", () => {
  it("retryable statuses", () => {
    expect([429, 502, 503, 504].map(isRetryableStatus)).toEqual([true, true, true, true]);
    expect([200, 400, 401, 500].map(isRetryableStatus)).toEqual([false, false, false, false]);
  });
  it("reads retry on anything; sends only on 429 (refused ⇒ never double-sent)", () => {
    expect(mayRetry(["eth_call"], null)).toBe(true);
    expect(mayRetry(["eth_call"], 503)).toBe(true);
    expect(mayRetry(["eth_sendRawTransaction"], 429)).toBe(true);
    expect(mayRetry(["eth_sendRawTransaction"], 503)).toBe(false);
    expect(mayRetry(["eth_sendRawTransaction"], null)).toBe(false);
  });
  it("rpcMethods parses single and batch bodies", () => {
    expect(rpcMethods(body("eth_blockNumber"))).toEqual(["eth_blockNumber"]);
    expect(rpcMethods(JSON.stringify([{ method: "eth_call" }, { method: "eth_getLogs" }]))).toEqual(["eth_call", "eth_getLogs"]);
    expect(rpcMethods("not json")).toEqual([]);
    expect(rpcMethods(undefined)).toEqual([]);
  });
});

describe("createCountingFetch", () => {
  function fake(statuses: Array<number | "throw">) {
    const seen: number[] = [];
    let i = 0;
    const fetch = (async () => {
      const s = statuses[Math.min(i++, statuses.length - 1)]!;
      if (s === "throw") throw new Error("socket hang up");
      seen.push(s);
      return new Response("{}", { status: s });
    }) as typeof globalThis.fetch;
    return { fetch, seen, calls: () => i };
  }
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);

  it("retries 429 with back-off, counts every attempt, returns the success", async () => {
    sleeps.length = 0;
    const stats = newRpcStats();
    const f = fake([429, 429, 200]);
    const res = await createCountingFetch({ stats, fetch: f.fetch, sleep, rand: () => 0 })("http://x", { method: "POST", body: body("eth_call") });
    expect(res.status).toBe(200);
    expect(stats).toMatchObject({ calls: 3, rateLimited: 2, retries: 2, errors: 0, byMethod: { eth_call: 3 } });
    expect(sleeps).toEqual([100, 200]);
  });
  it("gives up after maxRetries and reports an error", async () => {
    const stats = newRpcStats();
    const f = fake([429]);
    const res = await createCountingFetch({ stats, fetch: f.fetch, sleep, maxRetries: 2 })("http://x", { body: body("eth_getLogs") });
    expect(res.status).toBe(429);
    expect(f.calls()).toBe(3);
    expect(stats.errors).toBe(1);
  });
  it("never retries a send after a network error (it may have been accepted)", async () => {
    const stats = newRpcStats();
    const f = fake(["throw", 200]);
    await expect(createCountingFetch({ stats, fetch: f.fetch, sleep })("http://x", { body: body("eth_sendRawTransaction") })).rejects.toThrow(/hang up/);
    expect(f.calls()).toBe(1);
    expect(stats.errors).toBe(1);
  });
  it("retries a read after a network error", async () => {
    const stats = newRpcStats();
    const f = fake(["throw", 200]);
    const res = await createCountingFetch({ stats, fetch: f.fetch, sleep })("http://x", { body: body("eth_call") });
    expect(res.status).toBe(200);
    expect(stats.retries).toBe(1);
  });
  it("feeds onCall once per attempt with the batch's methods", async () => {
    const got: string[][] = [];
    const f = fake([200]);
    await createCountingFetch({ stats: newRpcStats(), fetch: f.fetch, sleep, onCall: (m) => got.push([...m]) })("http://x", {
      body: JSON.stringify([{ method: "eth_call" }, { method: "eth_call" }]),
    });
    expect(got).toEqual([["eth_call", "eth_call"]]);
  });
});

describe("RateWindow", () => {
  it("counts per minute over a sliding window", () => {
    const w = new RateWindow(60_000);
    w.add(0, 30);
    w.add(30_000, 30);
    expect(w.perMinute(59_999)).toBe(60);
    expect(w.perMinute(60_000)).toBe(30); // the first 30 fell out
    expect(w.perMinute(200_000)).toBe(0);
  });
  it("scales a shorter window to per-minute", () => {
    const w = new RateWindow(10_000);
    w.add(0, 5);
    expect(w.perMinute(1)).toBe(30);
  });
});

describe("burnPerHourWei (monPerHour in /health)", () => {
  const E = 10n ** 18n;
  it("sums decreases and scales to an hour", () => {
    expect(burnPerHourWei([{ tMs: 0, wei: 10n * E }, { tMs: 1_800_000, wei: 9n * E }])).toBe(2n * E);
  });
  it("ignores top-ups (not negative spending)", () => {
    const s = [
      { tMs: 0, wei: 10n * E },
      { tMs: 900_000, wei: 9n * E },
      { tMs: 1_000_000, wei: 20n * E }, // funded
      { tMs: 1_800_000, wei: 19n * E },
    ];
    expect(burnPerHourWei(s)).toBe(4n * E);
  });
  it("null until two samples ≥ 1 s apart", () => {
    expect(burnPerHourWei([])).toBeNull();
    expect(burnPerHourWei([{ tMs: 0, wei: 1n }])).toBeNull();
    expect(burnPerHourWei([{ tMs: 0, wei: 2n }, { tMs: 999, wei: 1n }])).toBeNull();
  });
  it("pruneSamples keeps the window covered", () => {
    const s = [0, 10, 20, 30].map((t) => ({ tMs: t, wei: 0n }));
    expect(pruneSamples(s, 30, 15).map((x) => x.tMs)).toEqual([10, 20, 30]);
    expect(pruneSamples(s, 30, 100).map((x) => x.tMs)).toEqual([0, 10, 20, 30]);
    expect(pruneSamples(s.slice(0, 1), 1_000, 15).map((x) => x.tMs)).toEqual([0]);
  });
});
