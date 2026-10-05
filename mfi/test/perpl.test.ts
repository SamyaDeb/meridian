import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PerplSchemaError,
  PerplUnavailableError,
  createPerplClient,
  fixtureTransport,
  httpTransport,
  parseContext,
  parseFundingSeries,
  parseMarketStateUpdate,
  perplOiNotionalWad,
  perplRateToAprWad,
  readPerplVenue,
  scaledToWad,
  type TransportResponse,
} from "../src/perpl";

// SYNTHETIC fixtures (fixtures/synthetic/README.md): shapes from Perpl's docs, values invented.
const fx = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/synthetic/${n}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
const ok = (body: unknown): TransportResponse => ({ status: 200, body });
const NOW = 1_791_234_600_000; // between the 41231000 and 41240000 events
const FUNDING_PATH = `/v1/market-data/9/funding/${NOW - 7_200_000}-${NOW + 3_600_000}`;
const noSleep = { sleep: async () => {}, random: () => 0 };
const routes = () => ({ "/v1/pub/context": ok(fx("context")), "/v1/market-data/9/ticker": ok(fx("ticker-9")), [FUNDING_PATH]: ok(fx("funding-9")) });

describe("units → WAD", () => {
  it("micros per interval → APR WAD (MFI.md §8 A and C)", () => {
    expect(perplRateToAprWad(12, 3600)).toBe(105_120_000_000_000_000n);
    expect(perplRateToAprWad(-7, 2571)).toBe(-85_862_310_385_064_177n);
    expect(perplRateToAprWad(0, 3600)).toBe(0n);
  });
  it("rounds toward zero for both signs (neutral)", () => {
    const pos = perplRateToAprWad(7, 2571);
    const neg = perplRateToAprWad(-7, 2571);
    expect(neg).toBe(-pos);
    expect(pos * 2571n <= 7n * 10n ** 12n * 31_536_000n).toBe(true);
    expect((pos + 1n) * 2571n > 7n * 10n ** 12n * 31_536_000n).toBe(true);
  });
  it("rejects bad intervals and unsafe numbers", () => {
    expect(() => perplRateToAprWad(1, 0)).toThrow(RangeError);
    expect(() => perplRateToAprWad(2 ** 60, 3600)).toThrow(RangeError);
    expect(() => scaledToWad(1, 19)).toThrow(RangeError);
  });
  it("scaled → WAD is exact; OI notional = oi × mark", () => {
    expect(scaledToWad(296_000, 7)).toBe(29_600_000_000_000_000n);
    expect(perplOiNotionalWad(4_000_000_000, 2, 296_000, 7)).toBe(1_184_000n * 10n ** 18n);
  });
});

describe("schema validation", () => {
  it("parses the documented shapes and ignores unknown keys", () => {
    const c = parseContext(fx("context"));
    expect(c.markets.map((m) => m.symbol)).toEqual(["BTC", "MON"]);
    expect(c.markets[1]?.config).toEqual({ is_open: true, price_decimals: 7, size_decimals: 2 });
    expect(parseMarketStateUpdate(fx("ticker-9")).d["9"]?.oi).toBe(4_000_000_000);
    expect(parseFundingSeries(fx("funding-9")).d).toHaveLength(4);
  });
  it("rejects malformed payloads with the failing path", () => {
    expect(() => parseContext({ chain: { chain_id: 143 } })).toThrow(/context.markets: expected array/);
    expect(() => parseMarketStateUpdate({ mt: 9, sn: 1, d: { "9": { at: {}, mrk: "296000" } } })).toThrow(PerplSchemaError);
    expect(() => parseMarketStateUpdate({ mt: 9, sn: 1, d: { abc: {} } })).toThrow(/integer/);
    expect(() => parseFundingSeries({ mt: 10, at: {}, m: 9, d: [{ at: {}, feb: 1, rate: 1.5, idx: 1, ppl: 0, sum: 0, div: 1 }] })).toThrow(/rate: expected safe integer/);
    expect(() => parseFundingSeries("<html>")).toThrow(/expected object/);
  });
  it("rejects partial payloads (missing fields) and unsafe integers", () => {
    const t = fx("ticker-9") as { d: Record<string, Record<string, unknown>> };
    const partial = structuredClone(t);
    delete partial.d["9"]!.oi;
    expect(() => parseMarketStateUpdate(partial)).toThrow(/oi/);
    const huge = structuredClone(t);
    huge.d["9"]!.mrk = 2 ** 60;
    expect(() => parseMarketStateUpdate(huge)).toThrow(/safe integer/);
    const ctx = structuredClone(fx("context")) as { markets: { config: { price_decimals: number } }[] };
    ctx.markets[0]!.config.price_decimals = 19;
    expect(() => parseContext(ctx)).toThrow(/decimals > 18/);
  });
});

describe("client", () => {
  it("resolves the market by symbol and reads the venue (rate in force, not the future event)", async () => {
    const t = fixtureTransport(routes());
    const c = createPerplClient({ transport: t, ...noSleep });
    const m = await c.findMarket("mon");
    expect(m.id).toBe(9);
    const v = await readPerplVenue(c, m, NOW);
    // the 41231000 interval was republished (rate 11 → 12); dedup by feb keeps the last; the -3 event applies after NOW
    expect(v.rateMicros).toBe(12);
    expect(v.fundingEventBlock).toBe(41_231_000);
    expect(v.aprWad).toBe(105_120_000_000_000_000n);
    expect(v.oiNotionalWad).toBe(1_184_000n * 10n ** 18n);
    expect(v.markWad).toBe(29_600_000_000_000_000n);
  });
  it("uses the newest event once it is in force", async () => {
    const later = NOW + 3_600_000;
    const t = fixtureTransport({ ...routes(), [`/v1/market-data/9/funding/${later - 7_200_000}-${later + 3_600_000}`]: ok(fx("funding-9")) });
    const c = createPerplClient({ transport: t, ...noSleep });
    const v = await readPerplVenue(c, await c.findMarket("MON"), later);
    expect(v.rateMicros).toBe(-3);
    expect(v.aprWad).toBe(perplRateToAprWad(-3, 3600));
  });
  it("unknown symbol → venue unavailable (unknown-market)", async () => {
    const c = createPerplClient({ transport: fixtureTransport(routes()), ...noSleep });
    await expect(c.findMarket("DOGE")).rejects.toMatchObject({ name: "PerplUnavailableError", kind: "unknown-market" });
  });
  it("funding series for another market is rejected", async () => {
    const wrong = { ...fx("funding-9"), m: 1 };
    const c = createPerplClient({ transport: fixtureTransport({ "/v1/market-data/9/funding/0-1": ok(wrong) }), ...noSleep });
    await expect(c.getFunding(9, 0, 1)).rejects.toThrow(/expected market 9/);
  });
});

describe("rate limits, retries, timeouts", () => {
  it("retries 429 with exponential backoff (honours Retry-After) then succeeds", async () => {
    const sleeps: number[] = [];
    const t = fixtureTransport({ "/v1/pub/context": (n) => (n < 3 ? { status: 429, body: {}, retryAfterMs: n === 2 ? 2000 : undefined } as TransportResponse : ok(fx("context"))) });
    const c = createPerplClient({ transport: t, backoffMs: 100, sleep: async (ms) => void sleeps.push(ms), random: () => 0 });
    expect((await c.getContext()).markets).toHaveLength(2);
    expect(t.calls).toHaveLength(3);
    expect(sleeps).toEqual([100, 2000]); // 100·2^0, then max(Retry-After 2 s, 100·2^1)
  });
  it("gives up after the attempts with a rate-limited error", async () => {
    const t = fixtureTransport({ "/v1/pub/context": { status: 429, body: {} } });
    const c = createPerplClient({ transport: t, attempts: 3, ...noSleep });
    await expect(c.getContext()).rejects.toMatchObject({ kind: "rate-limited", status: 429 });
    expect(t.calls).toHaveLength(3);
  });
  it("503 (state not ready) is retried; 400 (unknown market) is not", async () => {
    const t1 = fixtureTransport({ "/v1/market-data/9/ticker": (n) => (n === 1 ? { status: 503, body: {} } : ok(fx("ticker-9"))) });
    expect((await createPerplClient({ transport: t1, ...noSleep }).getMarketState(9)).oi).toBe(4_000_000_000);
    const t2 = fixtureTransport({ "/v1/market-data/77/ticker": { status: 400, body: {} } });
    await expect(createPerplClient({ transport: t2, ...noSleep }).getMarketState(77)).rejects.toMatchObject({ kind: "unknown-market" });
    expect(t2.calls).toHaveLength(1);
  });
  it("a hung request times out and is reported as venue unavailable", async () => {
    const hang = Object.assign(async () => new Promise<TransportResponse>(() => {}), { calls: [] });
    const c = createPerplClient({ transport: hang, timeoutMs: 20, attempts: 2, ...noSleep });
    const err = await c.getContext().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PerplUnavailableError);
    expect((err as PerplUnavailableError).kind).toBe("timeout");
  });
  it("network errors become PerplUnavailableError(network)", async () => {
    const boom = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(createPerplClient({ transport: boom, attempts: 2, ...noSleep }).getContext()).rejects.toMatchObject({ kind: "network" });
  });
});

describe("httpTransport", () => {
  it("joins the base URL, parses JSON and Retry-After; non-JSON bodies fail validation", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (url: string) => {
      seen.push(url);
      if (url.endsWith("/ticker")) return new Response("<html>busy</html>", { status: 429, headers: { "retry-after": "3" } });
      return new Response(JSON.stringify(fx("context")), { status: 200 });
    }) as typeof fetch;
    const t = httpTransport("https://example.invalid/api/", fakeFetch);
    const ctl = new AbortController();
    expect((await t("/v1/pub/context", ctl.signal)).status).toBe(200);
    expect(await t("/v1/market-data/9/ticker", ctl.signal)).toEqual({ status: 429, body: "<html>busy</html>", retryAfterMs: 3000 });
    expect(seen[0]).toBe("https://example.invalid/api/v1/pub/context");
    const c = createPerplClient({ transport: async () => ({ status: 200, body: "<html>" }), ...noSleep });
    await expect(c.getContext()).rejects.toBeInstanceOf(PerplSchemaError);
  });
});
