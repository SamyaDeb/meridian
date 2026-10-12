import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type PerpRecord, resolvePerpMarket, resolveSwapBook } from "../src/market.js";

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

describe("resolveSwapBook (CR-017 swapMarkets)", () => {
  const contracts = { FundingSwapMarket: "0xACFc9b2aEfD546AEd1FB21B2D82C5433c1d3Fe33", SwapOrderBook: "0xb7D732a5ac88c159B3CA553c672182D2Be51E6Db" } as const;
  const perpl = {
    symbol: "MON-FUNDING-PERPL",
    fundingSource: "perpl",
    PerplFundingSource: "0xC008aF47fCC651889a1d66f0734da941A55224cC",
    FundingSwapMarket: "0x4e5A8b88e8F09FDf2DC178B4641a25676d181bde",
    SwapOrderBook: "0x5D4f03B6Afa525ed580C75878A2F51A35c202334",
    deployed: true,
  } as const;
  it("unset ⇒ the Meridian-funding book, no Perpl source", () => {
    const b = resolveSwapBook({ contracts, swapMarkets: [perpl] }, undefined);
    expect(b.swapMarket).toBe(contracts.FundingSwapMarket);
    expect(b.orderBook).toBe(contracts.SwapOrderBook);
    expect(b.perplSource).toBeUndefined();
  });
  it("'perpl' or the symbol ⇒ the swapMarkets entry and its source", () => {
    for (const key of ["perpl", "mon-funding-perpl"]) {
      const b = resolveSwapBook({ contracts, swapMarkets: [perpl] }, key);
      expect(b.swapMarket).toBe(perpl.FundingSwapMarket);
      expect(b.orderBook).toBe(perpl.SwapOrderBook);
      expect(b.perplSource).toBe(perpl.PerplFundingSource);
    }
  });
  it("refuses an undeployed entry, an unknown key, and a record without the main swap book", () => {
    expect(() => resolveSwapBook({ contracts, swapMarkets: [{ ...perpl, deployed: false }] }, "perpl")).toThrow(/not deployed/);
    expect(() => resolveSwapBook({ contracts, swapMarkets: [perpl] }, "eth")).toThrow(/not in deployments/);
    expect(() => resolveSwapBook({ contracts: {} }, undefined)).toThrow(/no FundingSwapMarket/);
  });
});
