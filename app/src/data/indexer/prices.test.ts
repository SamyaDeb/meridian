import { describe, expect, it } from "vitest";
import { INDEX_QUERY, MARK_QUERY, parsePoints } from "./prices";

describe("indexer price history", () => {
  it("index from OraclePrice (publishTime), mark from FundingTick (timestamp), oldest first", () => {
    expect(parsePoints({ OraclePrice: [{ priceWad: "2", publishTime: "20" }, { priceWad: "1", publishTime: 10 }] }, "OraclePrice")).toEqual([
      { time: 10, price: 1n },
      { time: 20, price: 2n },
    ]);
    expect(parsePoints({ FundingTick: [{ mark: "7", timestamp: "5" }] }, "FundingTick")).toEqual([{ time: 5, price: 7n }]);
  });
  it("garbled or missing data throws", () => {
    expect(() => parsePoints({ OraclePrice: [{ priceWad: "x", publishTime: "1" }] }, "OraclePrice")).toThrow(/priceWad/);
    expect(() => parsePoints({}, "FundingTick")).toThrow(/FundingTick/);
  });
  it("queries filter by oracle / market, newest first", () => {
    expect(INDEX_QUERY).toContain("oracle: { _ilike: $oracle }");
    expect(MARK_QUERY).toContain("market_id: { _ilike: $market }");
  });
});
