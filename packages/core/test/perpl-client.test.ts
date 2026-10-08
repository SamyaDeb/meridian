// Ported from mfi/test/{perpl,recorded}.test.ts (main @ 0ba1664) onto the RN-safe client (+ fundingInForce, getBook).
import { describe, expect, it } from "vitest";
import {
  PerplSchemaError,
  PerplUnavailableError,
  createPerplClient,
  fixtureTransport,
  fundingInForce,
  httpTransport,
  matchMarket,
  parseContext,
  parseFundingSeries,
  parseL2Book,
  parseMarketStateUpdate,
  perplOiNotionalWad,
  perplRateToAprWad,
  pnsToWad,
  type TransportResponse,
} from "../src/perpl";
import { fakeFetch, fixtureJson } from "./helpers";

// SYNTHETIC fixtures (fixtures/perpl/synthetic/README.md): shapes from Perpl's docs, values invented.
const fx = (n: string) => fixtureJson(`perpl/synthetic/${n}.json`);
const ok = (body: unknown): TransportResponse => ({ status: 200, body });
const noSleep = { sleep: async () => {} };
const NOW = 1_791_234_600_000;
const FUNDING_PATH = `/v1/market-data/9/funding/${NOW - 7_200_000}-${NOW + 3_600_000}`;
const routes = () => ({ "/v1/pub/context": ok(fx("context")), "/v1/market-data/9/ticker": ok(fx("ticker-9")), [FUNDING_PATH]: ok(fx("funding-9")) });

describe("units → WAD (MFI.md §3)", () => {
  it("micros per interval → APR WAD (MFI.md §8 A and C)", () => {
    expect(perplRateToAprWad(12, 3600)).toBe(105_120_000_000_000_000n);
    expect(perplRateToAprWad(-7, 2571)).toBe(-85_862_310_385_064_177n);
    expect(perplRateToAprWad(0, 3600)).toBe(0n);
  });
  it("rounds toward zero for both signs (neutral)", () => {
    const pos = perplRateToAprWad(7, 2571);
    expect(perplRateToAprWad(-7, 2571)).toBe(-pos);
    expect(pos * 2571n <= 7n * 10n ** 12n * 31_536_000n).toBe(true);
    expect((pos + 1n) * 2571n > 7n * 10n ** 12n * 31_536_000n).toBe(true);
  });
  it("rejects bad intervals and unsafe numbers", () => {
    expect(() => perplRateToAprWad(1, 0)).toThrow(RangeError);
    expect(() => perplRateToAprWad(2 ** 60, 3600)).toThrow(RangeError);
  });
  it("OI notional = oi × mark", () => {
    expect(pnsToWad(296_000, 7)).toBe(29_600_000_000_000_000n);
    expect(perplOiNotionalWad(4_000_000_000, 2, 296_000, 7)).toBe(1_184_000n * 10n ** 18n);
  });
});

describe("schema validation", () => {
  it("parses the documented shapes and ignores unknown keys", () => {
    const c = parseContext(fx("context"));
    expect(c.markets.map((m) => m.symbol)).toEqual(["BTC", "MON"]);
    expect(c.markets[1]?.config).toMatchObject({ is_open: true, price_decimals: 7, size_decimals: 2 });
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
  it("L2 book: snapshot / update shapes; bad mt or level rejected", () => {
    expect(parseL2Book({ mt: 15, sn: 5, at: { b: 5 }, bid: [{ p: 10, s: 2, o: 1 }], ask: [] })).toEqual({ mt: 15, sn: 5, at: { b: 5 }, bid: [{ p: 10, s: 2, o: 1 }], ask: [] });
    expect(() => parseL2Book({ mt: 9, bid: [], ask: [] })).toThrow(/15 \(snapshot\)/);
    expect(() => parseL2Book({ mt: 16, bid: [{ p: -1, s: 1, o: 1 }], ask: [] })).toThrow(/>= 0/);
  });
});

describe("client", () => {
  it("resolves the market by symbol and reads funding in force (dedup by feb, future event skipped)", async () => {
    const c = createPerplClient({ transport: fixtureTransport(routes()), ...noSleep });
    const m = await c.findMarket("mon");
    expect(m.id).toBe(9);
    const events = await c.getFunding(9, NOW - 7_200_000, NOW + 3_600_000);
    const e = fundingInForce(events, NOW)!;
    expect(e.rate).toBe(12); // the 41231000 interval was republished (11 → 12); the -3 event applies after NOW
    expect(e.feb).toBe(41_231_000);
    expect(fundingInForce(events, NOW + 3_600_000)!.rate).toBe(-3);
    expect((await c.getMarketState(9)).mrk).toBe(296_000);
  });
  it("unknown symbol → unavailable (unknown-market); funding for another market rejected", async () => {
    const c = createPerplClient({ transport: fixtureTransport(routes()), ...noSleep });
    await expect(c.findMarket("DOGE")).rejects.toMatchObject({ name: "PerplUnavailableError", kind: "unknown-market" });
    const c2 = createPerplClient({ transport: fixtureTransport({ "/v1/market-data/9/funding/0-1": ok({ ...fx("funding-9"), m: 1 }) }), ...noSleep });
    await expect(c2.getFunding(9, 0, 1)).rejects.toThrow(/expected market 9/);
  });
  it("getBook: REST snapshot only, levels 1–100", async () => {
    const book = { mt: 15, sn: 7, at: { b: 7 }, bid: [{ p: 2574, s: 10, o: 1 }], ask: [{ p: 2578, s: 5, o: 2 }] };
    const c = createPerplClient({ transport: fixtureTransport({ "/v1/market-data/64/book?levels=10": ok(book) }), ...noSleep });
    expect((await c.getBook(64, 10)).ask[0]).toEqual({ p: 2578, s: 5, o: 2 });
    await expect(c.getBook(64, 101)).rejects.toThrow(RangeError);
  });
});

describe("rate limits, retries, timeouts", () => {
  it("retries 429 with exponential backoff (honours Retry-After) then succeeds", async () => {
    const sleeps: number[] = [];
    const t = fixtureTransport({ "/v1/pub/context": (n) => (n < 3 ? ({ status: 429, body: {}, ...(n === 2 ? { retryAfterMs: 2000 } : {}) } as TransportResponse) : ok(fx("context"))) });
    const c = createPerplClient({ transport: t, backoffMs: 100, sleep: async (ms) => void sleeps.push(ms), clock: { now: () => 0, random: () => 0, setTimeout: () => 0, clearTimeout: () => {} } });
    expect((await c.getContext()).markets).toHaveLength(2);
    expect(t.calls).toHaveLength(3);
    expect(sleeps).toEqual([100, 2000]);
  });
  it("gives up after the attempts; 503 retried; 400 not", async () => {
    const t = fixtureTransport({ "/v1/pub/context": { status: 429, body: {} } });
    await expect(createPerplClient({ transport: t, attempts: 3, ...noSleep }).getContext()).rejects.toMatchObject({ kind: "rate-limited", status: 429 });
    expect(t.calls).toHaveLength(3);
    const t1 = fixtureTransport({ "/v1/market-data/9/ticker": (n) => (n === 1 ? { status: 503, body: {} } : ok(fx("ticker-9"))) });
    expect((await createPerplClient({ transport: t1, ...noSleep }).getMarketState(9)).oi).toBe(4_000_000_000);
    const t2 = fixtureTransport({ "/v1/market-data/77/ticker": { status: 400, body: {} } });
    await expect(createPerplClient({ transport: t2, ...noSleep }).getMarketState(77)).rejects.toMatchObject({ kind: "unknown-market" });
    expect(t2.calls).toHaveLength(1);
  });
  it("a hung request times out; network errors become unavailable(network)", async () => {
    const hang = async () => new Promise<TransportResponse>(() => {});
    const err = await createPerplClient({ transport: hang, timeoutMs: 20, attempts: 2, ...noSleep }).getContext().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PerplUnavailableError);
    expect((err as PerplUnavailableError).kind).toBe("timeout");
    const boom = async (): Promise<TransportResponse> => {
      throw new TypeError("fetch failed");
    };
    await expect(createPerplClient({ transport: boom, attempts: 2, ...noSleep }).getContext()).rejects.toMatchObject({ kind: "network" });
  });
});

describe("httpTransport", () => {
  it("joins the base URL, parses JSON and Retry-After; non-JSON bodies fail validation", async () => {
    const f = fakeFetch((url) => (url.endsWith("/ticker") ? { status: 429, body: "<html>busy</html>", headers: { "retry-after": "3" } } : { status: 200, body: fx("context") }));
    const t = httpTransport("https://example.invalid/api/", f);
    expect((await t("/v1/pub/context")).status).toBe(200);
    expect(await t("/v1/market-data/9/ticker")).toEqual({ status: 429, body: "<html>busy</html>", retryAfterMs: 3000 });
    expect(f.calls[0]!.url).toBe("https://example.invalid/api/v1/pub/context");
    await expect(createPerplClient({ transport: async () => ({ status: 200, body: "<html>" }), ...noSleep }).getContext()).rejects.toBeInstanceOf(PerplSchemaError);
  });
});

// REAL Perpl responses recorded 5 Oct 2026 (mfi record:perpl), copied to fixtures/perpl/{testnet,mainnet}.
describe.each([
  { net: "testnet", id: 64, priceDecimals: 5 },
  { net: "mainnet", id: 10, priceDecimals: 6 },
])("recorded Perpl $net (MON market $id)", ({ net, id, priceDecimals }) => {
  const ctx = fixtureJson(`perpl/${net}/context.json`);
  const funding = fixtureJson(`perpl/${net}/funding-${id}.json`);
  it("MON resolves by symbol (testnet) or by name with an empty symbol (mainnet); decimals and 43 min interval", () => {
    const m = matchMarket(parseContext(ctx).markets, "MON")!;
    expect(m.id).toBe(id);
    expect(m.config.price_decimals).toBe(priceDecimals);
    expect(m.config.size_decimals).toBe(0);
    expect(m.funding_interval_sec).toBe(2580);
  });
  it("rate is micros of notional per interval: ppl = trunc(rate · idx / 10^(6 − funding_sum_scaling_exp)), Δsum = ppl", () => {
    const raw = funding.d as { rate: number; idx: number; ppl: number; sum: number }[];
    const exp = (ctx.markets as { id: number; config: { funding_sum_scaling_exp: number } }[]).find((x) => x.id === id)!.config.funding_sum_scaling_exp;
    expect(raw.length).toBeGreaterThan(20);
    for (const e of raw) expect(e.ppl).toBe(Math.trunc((e.rate * e.idx) / 10 ** (6 - exp)));
    for (let i = 1; i < raw.length; i++) expect(raw[i]!.sum - raw[i - 1]!.sum).toBe(raw[i]!.ppl);
    expect(parseFundingSeries(funding).d).toHaveLength(raw.length);
  });
});

describe("matchMarket", () => {
  const mk = (id: number, symbol: string, name: string) => ({ id, symbol, name, funding_interval_sec: 1, funding_interval_blocks: 1, config: { is_open: true, price_decimals: 0, size_decimals: 0 } });
  it("symbol wins over name; ambiguous ⇒ undefined (never guess)", () => {
    expect(matchMarket([mk(1, "", "MON"), mk(2, "MON", "MON Perp")], "mon")?.id).toBe(2);
    expect(matchMarket([mk(1, "", "MON"), mk(2, "", "MON")], "MON")).toBeUndefined();
    expect(matchMarket([mk(1, "XMON", "MON")], "MON")).toBeUndefined();
  });
});
