import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type PerpRecord, resolvePerpMarket } from "../src/market.js";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
const rec: PerpRecord = {
  deployed: true,
  symbol: "MON-PERP",
  contracts: { ClearingHouse: a(1), OrderBook: a(2), OracleAdapter: a(3) },
  demoMarket: { symbol: "MON-PERP-DEMO", ClearingHouse: a(4), OrderBook: a(5), OracleAdapter: a(6) },
  markets: [{ symbol: "ETH-PERP", ClearingHouse: a(7), OrderBook: a(8), OracleAdapter: a(9), startBlock: 5 }],
};

describe("resolvePerpMarket", () => {
  it("main and swap quote with the main market's CH/oracle", () => {
    expect(resolvePerpMarket(rec, "main")).toEqual({ symbol: "MON-PERP", clearingHouse: a(1), orderBook: a(2), oracle: a(3) });
    expect(resolvePerpMarket(rec, "swap").clearingHouse).toBe(a(1));
  });
  it("demo", () => {
    expect(resolvePerpMarket(rec, "demo")).toEqual({ symbol: "MON-PERP-DEMO", clearingHouse: a(4), orderBook: a(5), oracle: a(6) });
  });
  it("eth by coin or symbol", () => {
    for (const k of ["eth", "ETH", "ETH-PERP"]) {
      expect(resolvePerpMarket(rec, k)).toEqual({ symbol: "ETH-PERP", clearingHouse: a(7), orderBook: a(8), oracle: a(9) });
    }
  });
  it("unknown / undeployed fail", () => {
    expect(() => resolvePerpMarket(rec, "btc")).toThrow(/markets: ETH-PERP/);
    expect(() => resolvePerpMarket({ ...rec, deployed: false }, "main")).toThrow(/not deployed/);
    expect(() => resolvePerpMarket({ contracts: {} }, "demo")).toThrow(/not deployed/);
  });
  it("the committed 10143 record has ETH-PERP on its own book", () => {
    const live = JSON.parse(readFileSync(fileURLToPath(new URL("../../deployments/10143.json", import.meta.url)), "utf8")) as PerpRecord;
    const eth = resolvePerpMarket(live, "eth");
    expect(eth.symbol).toBe("ETH-PERP");
    expect(eth.orderBook).not.toBe(resolvePerpMarket(live, "main").orderBook);
  });
});
