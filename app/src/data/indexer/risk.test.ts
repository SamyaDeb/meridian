import { describe, expect, it } from "vitest";
import { parseRisk } from "./risk";

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
});
