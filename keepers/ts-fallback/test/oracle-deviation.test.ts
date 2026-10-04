import { describe, expect, it } from "vitest";
import { deviation, percentile } from "../scripts/oracle-deviation.js";

describe("oracle-deviation helpers (B3)", () => {
  it("deviation = |p − s| / s, the adapter's measure (s = Chainlink)", () => {
    // worst sampled block 108,753,387: Pyth 0.02935634 vs Chainlink 0.0289459
    expect(deviation(0.02935634, 0.0289459)).toBeCloseTo(0.014179555653823218, 12);
    expect(deviation(0.99, 1)).toBeCloseTo(0.01, 12);
    expect(deviation(1, 1)).toBe(0);
  });

  it("nearest-rank percentile", () => {
    const a = Array.from({ length: 1000 }, (_, i) => i + 1);
    expect(percentile(a, 0.5)).toBe(500);
    expect(percentile(a, 0.999)).toBe(999);
    expect(percentile(a, 1)).toBe(1000);
    expect(percentile([7], 0.99)).toBe(7);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });
});
