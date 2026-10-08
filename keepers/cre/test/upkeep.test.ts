import { describe, expect, it } from "vitest";
import { fundingStale, rebalanceReasonName } from "../shared/upkeep";

describe("upkeep", () => {
  it("funding is stale at >= maxGap blocks behind the head", () => {
    expect(fundingStale(140n, 100n, 40n)).toBe(true);
    expect(fundingStale(139n, 100n, 40n)).toBe(false);
    expect(fundingStale(90n, 100n, 40n)).toBe(false); // stale read / reorg
  });

  it("rebalance reasons follow the frozen enum", () => {
    expect(rebalanceReasonName(0)).toBe("None");
    expect(rebalanceReasonName(3)).toBe("MarginLow");
    expect(rebalanceReasonName(7)).toBe("SkewCap");
    expect(rebalanceReasonName(9)).toBe("Unknown(9)");
  });
});
