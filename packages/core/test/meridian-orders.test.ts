// Ported from app/src/lib/orders.test.ts (main @ 0ba1664).
import { describe, expect, it } from "vitest";
import { closeOrder, lotsForSize, marketLimitTick, priceToTick, tickToPrice } from "../src/meridian/orders";
const WAD = 10n ** 18n;
// MON-PERP tick 1e-6 AUSD, lot 100 MON (app/src/lib/units.ts, ARCHITECTURE §0.1): test inputs here, read from OrderBook onchain in the app
const PERP_TICK_SIZE_WAD = 10n ** 12n;
const PERP_LOT_SIZE_WAD = 100n * WAD;

describe("ticks (price = tick · 1e-6 AUSD)", () => {
  it("tick ↔ price", () => {
    expect(tickToPrice(29_000, PERP_TICK_SIZE_WAD)).toBe(29n * 10n ** 15n);
    expect(priceToTick(29n * 10n ** 15n, PERP_TICK_SIZE_WAD, "bid")).toBe(29_000);
  });
  it("a bid rounds down and an ask rounds up to the tick grid (never a worse price than asked)", () => {
    const p = 29n * 10n ** 15n + 5n * 10n ** 11n; // 0.0290005
    expect(priceToTick(p, PERP_TICK_SIZE_WAD, "bid")).toBe(29_000);
    expect(priceToTick(p, PERP_TICK_SIZE_WAD, "ask")).toBe(29_001);
  });
  it("rejects prices below one tick", () => {
    expect(() => priceToTick(10n ** 11n, PERP_TICK_SIZE_WAD, "bid")).toThrow();
  });
});

describe("lots (lot = 100 MON)", () => {
  it("size in MON (WAD) → whole lots, rounding down", () => {
    expect(lotsForSize(10_000n * WAD, PERP_LOT_SIZE_WAD)).toBe(100n);
    expect(lotsForSize(150n * WAD, PERP_LOT_SIZE_WAD)).toBe(1n);
    expect(lotsForSize(99n * WAD, PERP_LOT_SIZE_WAD)).toBe(0n);
  });
});

describe("market order worst-price limit", () => {
  it("a buy accepts up to mark + slippage (tick rounded up), a sell down to mark − slippage (rounded down)", () => {
    const mark = 29n * 10n ** 15n;
    expect(marketLimitTick(mark, PERP_TICK_SIZE_WAD, true, 50)).toBe(29_145); // +0.5%
    expect(marketLimitTick(mark, PERP_TICK_SIZE_WAD, false, 50)).toBe(28_855); // −0.5%
  });
});

describe("close position", () => {
  it("is a reduce-only market order on the opposite side for the whole size", () => {
    expect(closeOrder(10_000n * WAD, PERP_LOT_SIZE_WAD)).toEqual({ isBid: false, lots: 100n, reduceOnly: true });
    expect(closeOrder(-2_500n * WAD, PERP_LOT_SIZE_WAD)).toEqual({ isBid: true, lots: 25n, reduceOnly: true });
    expect(closeOrder(0n, PERP_LOT_SIZE_WAD)).toBeUndefined();
  });
});
