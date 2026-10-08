// Ported from app/src/lib/book.test.ts (main @ 0ba1664).
import { describe, expect, it } from "vitest";
import { aggregateLevels, ladder, spread, totalSize } from "../src/meridian/book";
const WAD = 10n ** 18n;

const T = 10n ** 12n; // tick 1e-6
const L = (ticks: bigint, size: bigint) => ({ priceWad: ticks * T, sizeWad: size * WAD });

describe("aggregateLevels", () => {
  const bids = [L(27_049n, 1n), L(27_046n, 2n), L(27_040n, 3n), L(27_039n, 4n)];
  const asks = [L(27_051n, 1n), L(27_055n, 2n), L(27_060n, 3n), L(27_061n, 4n)];
  it("bids floor, asks ceil, best first", () => {
    expect(aggregateLevels(bids, T, 10n, "bid")).toEqual([L(27_040n, 6n), L(27_030n, 4n)]);
    expect(aggregateLevels(asks, T, 10n, "ask")).toEqual([L(27_060n, 6n), L(27_070n, 4n)]);
  });
  it("conserves total size for every grouping", () => {
    for (const g of [1n, 2n, 5n, 10n, 50n, 100n]) {
      expect(totalSize(aggregateLevels(bids, T, g, "bid"))).toBe(totalSize(bids));
      expect(totalSize(aggregateLevels(asks, T, g, "ask"))).toBe(totalSize(asks));
    }
  });
  it("never shows a bucket better than its orders", () => {
    for (const g of [3n, 7n, 10n]) {
      const best = (x: { priceWad: bigint }[]) => x[0]!.priceWad;
      expect(best(aggregateLevels(bids, T, g, "bid"))).toBeLessThanOrEqual(best(bids));
      expect(best(aggregateLevels(asks, T, g, "ask"))).toBeGreaterThanOrEqual(best(asks));
    }
  });
  it("grouping 1 is the identity; exact multiples stay put", () => {
    expect(aggregateLevels(bids, T, 1n, "bid")).toEqual(bids);
    expect(aggregateLevels([L(27_060n, 1n)], T, 10n, "ask")).toEqual([L(27_060n, 1n)]);
  });
});

describe("ladder", () => {
  it("cumulates size and notional, average price between best and level price", () => {
    const rows = ladder([L(100n, 1n), L(90n, 3n)], 4n * WAD);
    expect(rows[1]!.cumSizeWad).toBe(4n * WAD);
    expect(rows[1]!.cumNotionalWad).toBe(370n * T);
    expect(rows[1]!.avgPriceWad).toBe((370n * T * WAD) / (4n * WAD));
    expect(rows[1]!.avgPriceWad).toBeLessThanOrEqual(100n * T);
    expect(rows[1]!.avgPriceWad).toBeGreaterThanOrEqual(90n * T);
    expect(rows.map((r) => r.depthBps)).toEqual([2_500, 10_000]);
  });
  it("zero scale gives zero bars", () => {
    expect(ladder([L(1n, 1n)], 0n)[0]!.depthBps).toBe(0);
  });
});

describe("spread", () => {
  it("absolute and bps of mid, rounded down", () => {
    const s = spread(27_046n * T, 27_051n * T)!;
    expect(s.absWad).toBe(5n * T);
    expect(s.bps).toBe(1n); // 5 / 27048.5 · 1e4 = 1.85 → 1
  });
  it("undefined when a side is empty", () => {
    expect(spread(undefined, 1n)).toBeUndefined();
  });
});
