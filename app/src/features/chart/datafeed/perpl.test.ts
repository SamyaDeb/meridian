import { describe, expect, it } from "vitest";
import {
  PERPL_API,
  PERPL_MAX_CANDLES,
  PERPL_RESOLUTIONS,
  PERPL_RES_OF,
  parsePerplRes,
  perplBookUrl,
  perplCandlesUrl,
  perplToBars,
  perplToDepth,
  resolvePerplMarket,
  scaledToWad,
  trimBook,
  trimCandles,
  type PerplBookPayload,
  type PerplCandlesPayload,
} from "./perpl";
import { TIMEFRAMES, TIMEFRAME_SEC } from "./types";

// Recorded from Perpl mainnet's public API on 7 Oct 2026 (trimmed): /v1/pub/context, /v1/market-data/10/candles/60/…, /book?levels=5
const CONTEXT = {
  chain: { chain_id: 143 },
  markets: [
    { id: 1, symbol: "", name: "BTC", config: { price_decimals: 1, size_decimals: 5, is_open: true } },
    { id: 10, symbol: "", name: "MON", config: { price_decimals: 6, size_decimals: 0, is_open: true } },
    { id: 20, symbol: "ETH", name: "ETH", config: { price_decimals: 2, size_decimals: 3, is_open: true } },
  ],
};
const CANDLES = {
  mt: 12,
  r: 60,
  at: { b: 111245535, t: 1791352440000 },
  d: [
    { t: 1791351840000, o: 27039, c: 27036, h: 27039, l: 27036, v: "2568420", n: 1 },
    { t: 1791351900000, o: 27036, c: 27063, h: 27063, l: 27036, v: "2570985", n: 1 },
    { t: 1791351960000, o: 27063, c: 27045, h: 27101, l: 27045, v: "285816774", n: 3 },
    { t: 1791352020000, o: 27045, c: 27075, h: 27075, l: 27031, v: "700941155", n: 4 },
  ],
};
const BOOK = {
  mt: 15,
  sn: 111245634,
  at: { b: 111245634, t: 1791352470000 },
  bid: [
    { p: 27222, s: 3673, o: 1 },
    { p: 27218, s: 73379, o: 1 },
  ],
  ask: [
    { p: 27307, s: 3662, o: 1 },
    { p: 27316, s: 2685, o: 1 },
  ],
};
const MON = { id: 10, name: "MON", priceDecimals: 6, sizeDecimals: 0 };

describe("resolvePerplMarket (by name, never a hard-coded id)", () => {
  it("finds MON by name when its symbol is empty", () => {
    expect(resolvePerplMarket(CONTEXT)).toEqual(MON);
  });
  it("a symbol match wins over a name match", () => {
    const ctx = { markets: [...CONTEXT.markets, { id: 99, symbol: "MON", name: "Other", config: { price_decimals: 4, size_decimals: 1 } }] };
    expect(resolvePerplMarket(ctx)?.id).toBe(99);
  });
  it("ambiguous, missing, malformed or bad decimals ⇒ undefined (never guess)", () => {
    expect(resolvePerplMarket({ markets: [CONTEXT.markets[1], { ...CONTEXT.markets[1], id: 11 }] })).toBeUndefined();
    expect(resolvePerplMarket({ markets: [CONTEXT.markets[0]] })).toBeUndefined();
    expect(resolvePerplMarket(null)).toBeUndefined();
    expect(resolvePerplMarket({ markets: "x" })).toBeUndefined();
    expect(resolvePerplMarket({ markets: [{ ...CONTEXT.markets[1], config: { price_decimals: 19, size_decimals: 0 } }] })).toBeUndefined();
    expect(resolvePerplMarket({ markets: [{ ...CONTEXT.markets[1], id: "10" }] })).toBeUndefined();
  });
});

describe("scaling", () => {
  it("scaled integers → WAD exactly", () => {
    expect(scaledToWad(27222, 6)).toBe(27_222_000_000_000_000n); // 0.027222
    expect(scaledToWad(3673, 0)).toBe(3673n * 10n ** 18n); // 3,673 MON
    expect(scaledToWad(5, 18)).toBe(5n);
  });
});

describe("candles", () => {
  it("trimCandles keeps only OHLC + time and drops malformed rows", () => {
    const rows = trimCandles({ ...CANDLES, d: [...CANDLES.d, { t: 1, o: 0, h: 1, l: 1, c: 1 }, { t: 2, o: 2, h: 1, l: 3, c: 2 }, { t: 3, o: 1.5, h: 2, l: 1, c: 1 }, null] });
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ t: 1791351840000, o: 27039, h: 27039, l: 27036, c: 27036 });
    expect(Object.keys(rows[0]!)).not.toContain("v");
  });
  it("trimCandles throws on a garbled shape, [] on an empty list", () => {
    expect(() => trimCandles({})).toThrow();
    expect(() => trimCandles(null)).toThrow();
    expect(trimCandles({ d: [] })).toEqual([]);
  });
  it("perplToBars: ms → s, WAD prices, zero volume, ascending, 3m aggregated from 1m with gap fill", () => {
    const payload: PerplCandlesPayload = { market: MON, r: 60, d: trimCandles(CANDLES).reverse() };
    const bars = perplToBars(payload, "1m");
    expect(bars.map((b) => b.time)).toEqual([1791351840, 1791351900, 1791351960, 1791352020]);
    expect(bars[2]).toMatchObject({ open: 27_063_000_000_000_000n, high: 27_101_000_000_000_000n, low: 27_045_000_000_000_000n, close: 27_045_000_000_000_000n, volumeBaseWad: 0n, volumeQuoteWad: 0n });
    const three = perplToBars(payload, "3m");
    expect(three.every((b) => b.time % 180 === 0)).toBe(true);
    // 3m buckets: [..1720, ..1900) holds the 1840 candle alone; [..1900, ..2080) holds 1900, 1960, 2020
    expect(three.map((b) => b.time)).toEqual([1791351720, 1791351900]);
    expect(three[1]).toMatchObject({ open: 27_036_000_000_000_000n, high: 27_101_000_000_000_000n, low: 27_031_000_000_000_000n, close: 27_075_000_000_000_000n });
    const gappy: PerplCandlesPayload = { market: MON, r: 60, d: [CANDLES.d[0]!, CANDLES.d[3]!] };
    expect(perplToBars(gappy, "1m").filter((b) => b.gapFill)).toHaveLength(2);
  });
  it("every timeframe maps to a supported resolution that divides it", () => {
    for (const tf of TIMEFRAMES) {
      const r = PERPL_RES_OF[tf];
      expect(PERPL_RESOLUTIONS).toContain(r);
      expect(TIMEFRAME_SEC[tf] % r).toBe(0);
    }
  });
});

describe("book", () => {
  it("trimBook keeps block, time and valid levels", () => {
    const b = trimBook({ ...BOOK, bid: [...BOOK.bid, { p: 0, s: 1 }, { p: 1, s: -1 }, { p: 1.5, s: 1 }] });
    expect(b).toEqual({ block: 111245634, timeMs: 1791352470000, bid: BOOK.bid, ask: BOOK.ask });
  });
  it("trimBook throws on a garbled shape; empty sides are fine", () => {
    expect(() => trimBook({ bid: [], ask: [] })).toThrow();
    expect(() => trimBook({ sn: 1, bid: null, ask: [] })).toThrow();
    expect(trimBook({ sn: 1, bid: [], ask: [] })).toEqual({ block: 1, timeMs: 0, bid: [], ask: [] });
  });
  it("perplToDepth: WAD levels, best first on both sides whatever the upstream order", () => {
    const payload: PerplBookPayload = { market: MON, ...trimBook({ ...BOOK, bid: [...BOOK.bid].reverse(), ask: [...BOOK.ask].reverse() }) };
    const d = perplToDepth(payload);
    expect(d.bids.map((l) => l.priceWad)).toEqual([27_222_000_000_000_000n, 27_218_000_000_000_000n]);
    expect(d.asks.map((l) => l.priceWad)).toEqual([27_307_000_000_000_000n, 27_316_000_000_000_000n]);
    expect(d.bids[0]!.sizeWad).toBe(3673n * 10n ** 18n);
  });
});

describe("route queries and upstream URLs (fixed base + market, bounded window: not a general proxy)", () => {
  it("res is allow-listed", () => {
    expect(parsePerplRes(new URLSearchParams("res=60"))).toBe(60);
    for (const bad of ["res=120", "res=", "res=60.0x", "foo=60", "res=-60"]) expect(parsePerplRes(new URLSearchParams(bad))).toBeNull();
  });
  it("candles window never exceeds the documented 1024 candles", () => {
    const u = perplCandlesUrl(10, 3_600, 1_791_352_440_000);
    expect(u.startsWith(`${PERPL_API}/v1/market-data/10/candles/3600/`)).toBe(true);
    const [from, to] = u.split("/").pop()!.split("-").map(Number) as [number, number];
    expect((to - from) / 3_600_000).toBe(PERPL_MAX_CANDLES);
    expect(PERPL_MAX_CANDLES).toBeLessThan(1024);
    expect(perplBookUrl(10)).toBe(`${PERPL_API}/v1/market-data/10/book?levels=20`);
  });
});
