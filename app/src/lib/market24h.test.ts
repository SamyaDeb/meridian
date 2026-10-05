import { describe, expect, it } from "vitest";
import type { Candle } from "@/data/types";
import { stats24h } from "./market24h";
import { WAD } from "./units";

const c = (h: number, o: number, hi: number, lo: number, cl: number, vol = 1): Candle => ({
  id: String(h),
  market: "0x0000000000000000000000000000000000000001",
  bucketStart: BigInt(h * 3_600),
  open: BigInt(o) * WAD,
  high: BigInt(hi) * WAD,
  low: BigInt(lo) * WAD,
  close: BigInt(cl) * WAD,
  volumeBaseWad: BigInt(vol) * WAD,
  volumeQuoteWad: BigInt(vol * cl) * WAD,
  trades: 1,
});

describe("stats24h", () => {
  const now = BigInt(48 * 3_600 + 1_800); // 48.5 h
  it("uses only candles overlapping the last 24 h; change from first open to last close", () => {
    const s = stats24h([c(10, 1, 9, 1, 2), c(24, 100, 120, 90, 110), c(30, 110, 130, 80, 105), c(48, 105, 106, 104, 104, 3)], now)!;
    expect(s.open).toBe(100n * WAD);
    expect(s.last).toBe(104n * WAD);
    expect(s.high).toBe(130n * WAD);
    expect(s.low).toBe(80n * WAD);
    expect(s.change).toBe(4n * WAD);
    expect(s.changeWad).toBe(WAD / 25n); // +4%
    expect(s.volumeBaseWad).toBe(5n * WAD);
    expect(s.fromSec).toBe(24n * 3_600n);
  });
  it("negative change rounds toward zero", () => {
    const s = stats24h([c(40, 3, 3, 1, 1)], now)!;
    expect(s.changeWad).toBe((-2n * WAD) / 3n);
    expect(s.changeWad * 3n).toBeGreaterThanOrEqual(-2n * WAD);
  });
  it("undefined with no candle in the window; zero open does not divide", () => {
    expect(stats24h([c(1, 1, 1, 1, 1)], now)).toBeUndefined();
    expect(stats24h([], now)).toBeUndefined();
    expect(stats24h([c(40, 0, 5, 0, 5)], now)!.changeWad).toBe(0n);
  });
  it("ignores future buckets and order of input", () => {
    const s = stats24h([c(49, 1, 999, 1, 1), c(47, 10, 11, 9, 10), c(30, 5, 6, 4, 5)], now)!;
    expect(s.high).toBe(11n * WAD);
    expect(s.open).toBe(5n * WAD);
  });
});
