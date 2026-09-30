import { describe, expect, it } from "vitest";
import { maxFundingGap, spreadBps, summarizeBook } from "../src/evidence.js";

describe("maxFundingGap", () => {
  it("measures between events and at both edges", () => {
    expect(maxFundingGap([105n, 120n, 125n], 100n, 140n)).toBe(15n);
    expect(maxFundingGap([101n, 102n], 100n, 130n)).toBe(28n); // tail gap
    expect(maxFundingGap([], 100n, 130n)).toBe(30n);
    expect(maxFundingGap([130n, 110n, 90n], 100n, 130n)).toBe(20n); // unsorted, out of range ignored
  });
});

describe("book summary", () => {
  it("spread in bps of mid; one-sided is null", () => {
    expect(spreadBps({ t: 0, block: 1n, bestBidTick: 27_013, bestAskTick: 27_030 })).toBeCloseTo(6.291, 3);
    expect(spreadBps({ t: 0, block: 1n, bestBidTick: null, bestAskTick: 27_030 })).toBeNull();
  });
  it("counts two-sided samples within the limit", () => {
    const s = summarizeBook(
      [
        { t: 0, block: 1n, bestBidTick: 27_013, bestAskTick: 27_030 },
        { t: 60, block: 61n, bestBidTick: 27_000, bestAskTick: 27_100 },
        { t: 120, block: 121n, bestBidTick: null, bestAskTick: 27_030 },
      ],
      20,
    );
    expect(s).toMatchObject({ samples: 3, twoSided: 2, withinBps: 1 });
    expect(s.maxSpreadBps).toBeCloseTo(36.97, 2);
  });
});
