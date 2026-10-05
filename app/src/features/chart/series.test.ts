import { describe, expect, it } from "vitest";
import { estimateBlockTimeSec, heikinAshi, numToWad, wadToNum } from "./series";
import type { Bar } from "./datafeed/types";

const bar = (o: number, h: number, l: number, c: number, time = 0): Bar => ({ time, open: BigInt(o), high: BigInt(h), low: BigInt(l), close: BigInt(c), volumeBaseWad: 0n, volumeQuoteWad: 0n, trades: 0 });

describe("display conversions", () => {
  it("WAD ↔ number round-trips at tick precision (1e-6)", () => {
    for (const ticks of [1n, 27_046n, 29_010n, 999_999n, 16_777_215n]) {
      const wad = ticks * 10n ** 12n;
      expect(numToWad(wadToNum(wad))).toBe(wad);
    }
    expect(wadToNum(27_046_000_000_000_000n)).toBeCloseTo(0.027046, 12);
    expect(numToWad(-1)).toBe(0n);
    expect(numToWad(Number.NaN)).toBe(0n);
  });
  it("block time estimate: head maps to its own time, older blocks earlier by blockTime", () => {
    expect(estimateBlockTimeSec(100n, 100n, 1_700_000_000_000, 300)).toBe(1_700_000_000);
    expect(estimateBlockTimeSec(90n, 100n, 1_700_000_000_000, 300)).toBe(1_699_999_997);
  });
});

describe("heikinAshi (hand-computed)", () => {
  it("matches the textbook recurrence", () => {
    const ha = heikinAshi([bar(10, 14, 8, 12), bar(12, 16, 11, 15)]);
    // bar 1: close = 44/4 = 11, open = (10+12)/2 = 11, high = 14, low = 8
    expect(ha[0]).toMatchObject({ open: 11n, close: 11n, high: 14n, low: 8n });
    // bar 2: close = 54/4 = 13 (13.5 floored), open = (11+11)/2 = 11, high = 16, low = 11
    expect(ha[1]).toMatchObject({ open: 11n, close: 13n, high: 16n, low: 11n });
  });
  it("keeps OHLC invariants", () => {
    const ha = heikinAshi([bar(5, 9, 1, 2), bar(2, 3, 1, 3), bar(3, 10, 3, 9)]);
    for (const b of ha) expect(b.low <= b.open && b.open <= b.high && b.low <= b.close && b.close <= b.high).toBe(true);
  });
});
