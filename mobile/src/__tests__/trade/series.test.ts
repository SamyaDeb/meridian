import candles1h from "../../../../packages/core/fixtures/perpl/testnet/candles-64-3600.json";
import { parseCandleSeries } from "@meridian/core/perpl";
import { appendLive, candlesToPoints, change24hBps, MAX_POINTS, placeLine, priceDomain, refPriceAt, scrubIndex, type Point } from "../../features/trade/chart/series";

const WAD = 10n ** 18n;
const PD = 5; // testnet MON priceDecimals (deployments/perpl.json chains.10143.markets.64)
const H = 3_600_000;

describe("candles → points", () => {
  it("one point per candle at its close, exact PNS → WAD (recorded testnet 1h series)", () => {
    const s = parseCandleSeries(candles1h);
    const pts = candlesToPoints(s.d, PD, 3600);
    expect(pts).toHaveLength(7);
    expect(pts[0]).toEqual({ t: 1791496800000, priceWad: 2406n * 10n ** 13n });
    expect(pts.at(-1)!.priceWad).toBe(BigInt(s.d.at(-1)!.c) * 10n ** 13n);
    expect(pts.every((p) => p.gap === undefined)).toBe(true);
  });
  it("a missing bucket is carried from the previous close and flagged gap (no trade invented)", () => {
    const c = (t: number, close: number) => ({ t, o: close, c: close, h: close, l: close, v: "1", n: 1 });
    const pts = candlesToPoints([c(0, 100), c(3 * H, 130)], PD, 3600);
    expect(pts.map((p) => [p.t / H, p.priceWad / 10n ** 13n, p.gap ?? false])).toEqual([
      [0, 100n, false],
      [1, 100n, true],
      [2, 100n, true],
      [3, 130n, false],
    ]);
  });
  it("keeps only the newest MAX_POINTS points", () => {
    const many = Array.from({ length: MAX_POINTS + 50 }, (_, i) => ({ t: i * 60_000, o: 1, c: 1 + i, h: 1 + i, l: 1, v: "0", n: 1 }));
    const pts = candlesToPoints(many, PD, 60);
    expect(pts).toHaveLength(MAX_POINTS);
    expect(pts.at(-1)!.t).toBe((MAX_POINTS + 49) * 60_000);
  });
});

describe("per-block append", () => {
  const base: Point[] = [
    { t: 0, priceWad: 100n },
    { t: H, priceWad: 110n },
  ];
  it("same bucket ⇒ the last point's price follows the live price (no new point)", () => {
    const next = appendLive(base, 3600, H + 1_234, 115n);
    expect(next).toHaveLength(2);
    expect(next.at(-1)).toEqual({ t: H, priceWad: 115n });
    expect(base.at(-1)!.priceWad).toBe(110n); // input untouched
  });
  it("unchanged price ⇒ the same array (no re-render)", () => {
    expect(appendLive(base, 3600, H + 5, 110n)).toBe(base);
  });
  it("next bucket ⇒ a new point; skipped buckets carried as gaps", () => {
    const next = appendLive(base, 3600, 3 * H + 10, 120n);
    expect(next.map((p) => [p.t / H, p.priceWad, p.gap ?? false])).toEqual([
      [0, 100n, false],
      [1, 110n, false],
      [2, 110n, true],
      [3, 120n, false],
    ]);
  });
  it("a late block for an older bucket is ignored; empty series starts with the live point", () => {
    expect(appendLive(base, 3600, 10, 1n)).toBe(base);
    expect(appendLive([], 60, 61_000, 5n)).toEqual([{ t: 60_000, priceWad: 5n }]);
  });
  it("a gap point that gets a live price becomes real", () => {
    const g: Point[] = [{ t: 0, priceWad: 1n }, { t: H, priceWad: 1n, gap: true }];
    expect(appendLive(g, 3600, H + 1, 2n).at(-1)).toEqual({ t: H, priceWad: 2n });
  });
});

describe("24 h change", () => {
  const pts: Point[] = Array.from({ length: 30 }, (_, i) => ({ t: i * H, priceWad: (100n + BigInt(i)) * WAD }));
  it("reference = the close of the last candle at or before now − 24 h", () => {
    expect(refPriceAt(pts, 29 * H + 10 - 24 * H)).toBe(105n * WAD);
  });
  it("change in bps toward zero; unknown when there is no reference", () => {
    expect(change24hBps(pts, 29 * H + 10, 126n * WAD)).toBe(2000n); // 105 → 126 = +20 %
    expect(change24hBps(pts, 29 * H + 10, 100n * WAD)).toBe(-476n); // −4.76… % truncated
    expect(change24hBps(pts.slice(10), 29 * H + 10, 1n)).toBeUndefined();
    expect(change24hBps(pts, 29 * H, undefined)).toBeUndefined();
  });
});

describe("scrub + lines", () => {
  it("scrub index = nearest point to the finger, clamped to the series", () => {
    expect(scrubIndex(0, 300, 31)).toBe(0);
    expect(scrubIndex(300, 300, 31)).toBe(30);
    expect(scrubIndex(149, 300, 31)).toBe(15); // 14.9 → 15
    expect(scrubIndex(-20, 300, 31)).toBe(0);
    expect(scrubIndex(999, 300, 31)).toBe(30);
    expect(scrubIndex(50, 300, 1)).toBe(0);
    expect(scrubIndex(50, 0, 10)).toBe(0);
  });
  it("domain covers the prices and the mark/entry, pads 8 %, never zero height", () => {
    const d = priceDomain([1, 2, 3], [2.5]);
    expect(d.lo).toBeLessThan(1);
    expect(d.hi).toBeGreaterThan(3);
    const flat = priceDomain([2, 2], []);
    expect(flat.hi).toBeGreaterThan(flat.lo);
  });
  it("a line outside the domain is pinned to the edge and says which side (the liq line never flattens the chart)", () => {
    const d = { lo: 10, hi: 20 };
    expect(placeLine(15, d, 100)).toEqual({ y: 50, off: undefined });
    expect(placeLine(5, d, 100)).toEqual({ y: 100, off: "below" });
    expect(placeLine(25, d, 100)).toEqual({ y: 0, off: "above" });
  });
});

describe("header 24 h change display", () => {
  it("bps → WAD fraction (bps · 1e14) formats as a percent: 2,000 bps = +20.00 %", () => {
    const { formatValue } = jest.requireActual("../../ui/format") as typeof import("../../ui/format");
    expect(formatValue(2000n * 10n ** 14n, "apr", { signed: true })).toBe("+20.00%");
    expect(formatValue(-476n * 10n ** 14n, "apr", { signed: true })).toBe("−4.76%");
  });
});
