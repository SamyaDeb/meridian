import { describe, expect, it } from "vitest";
import { RISK_QUERY, parseRisk } from "./risk";

describe("indexer risk data", () => {
  it("parses positions and the insurance fund", () => {
    const r = parseRisk({ AccountMarket: [{ size: "-100", entryPrice: "27", collateralWad: 5 }], InsuranceFund: [{ fundedToken: "1000000", coveredToken: "0" }] });
    expect(r.positions).toEqual([{ size: -100n, entryPrice: 27n, collateralWad: 5n }]);
    expect(r.insurance).toEqual({ fundedToken: 1_000_000n, coveredToken: 0n });
  });
  it("no fund row ⇒ undefined; garbled ⇒ throws", () => {
    expect(parseRisk({ AccountMarket: [] }).insurance).toBeUndefined();
    expect(() => parseRisk({ AccountMarket: [{ size: "x", entryPrice: "1", collateralWad: "1" }] })).toThrow(/size/);
    expect(() => parseRisk({})).toThrow(/AccountMarket/);
  });
  it("test markets are excluded: positions are queried for the product market only, flat rows skipped (ported from T8)", () => {
    expect(RISK_QUERY).toMatch(/AccountMarket\(where: \{ market_id: \{ _ilike: \$market \}, size: \{ _neq: "0" \} \}/);
    expect(RISK_QUERY).toContain("$market: String!");
  });
});
