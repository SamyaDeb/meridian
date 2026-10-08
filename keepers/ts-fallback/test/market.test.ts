import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type MarketRecord, baseCoin, findAddedMarket, resolveMarket } from "../src/market.js";

const ETH_FEED = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";

const rec: MarketRecord = {
  chainId: 10143,
  startBlock: 100,
  deployed: true,
  symbol: "MON-PERP",
  oracleKind: "keeper-fed",
  contracts: { ClearingHouse: "0x0000000000000000000000000000000000000001", OracleAdapter: "0x0000000000000000000000000000000000000002", OrderBook: "0x0000000000000000000000000000000000000003" },
  demoMarket: {
    symbol: "MON-PERP-DEMO",
    testMarket: true,
    oracleKind: "keeper-fed",
    ClearingHouse: "0x0000000000000000000000000000000000000004",
    OracleAdapter: "0x0000000000000000000000000000000000000005",
    OrderBook: "0x0000000000000000000000000000000000000006",
  },
  markets: [
    {
      symbol: "ETH-PERP",
      oracleKind: "keeper-fed",
      feedSymbol: "ETH/USD",
      pythFeedId: ETH_FEED,
      tickSizeWad: "100000000000000000",
      lotSizeWad: "1000000000000000",
      baseAsset: "0x0000000000000000000000000000000000000000",
      keeper: "0x0000000000000000000000000000000000000010",
      OracleAdapter: "0x0000000000000000000000000000000000000007",
      ClearingHouse: "0x0000000000000000000000000000000000000008",
      OrderBook: "0x0000000000000000000000000000000000000009",
      startBlock: 500,
    },
  ],
};

/** The record without an optional key (exactOptionalPropertyTypes: no `key: undefined`). */
function without(key: "demoMarket" | "markets"): MarketRecord {
  const c = { ...rec };
  delete c[key];
  return c;
}

describe("resolveMarket", () => {
  it("main = contracts.*, MON feed from env, record startBlock", () => {
    const m = resolveMarket(rec, "main");
    expect(m).toMatchObject({ kind: "main", symbol: "MON-PERP", clearingHouse: rec.contracts.ClearingHouse, oracleKind: "keeper-fed" });
    expect(m.pythFeedId).toBeUndefined();
    expect(m.hyperliquidCoin).toBe("MON");
    expect(m.startBlock).toBe(100);
  });

  it("demo = demoMarket", () => {
    const m = resolveMarket(rec, "demo");
    expect(m).toMatchObject({ kind: "demo", symbol: "MON-PERP-DEMO", clearingHouse: rec.demoMarket?.ClearingHouse, hyperliquidCoin: "MON" });
  });

  it("eth = the ETH-PERP entry: its CH/OB/oracle, feed id, coin and startBlock", () => {
    for (const key of ["eth", "ETH", "ETH-PERP", "eth-perp"]) {
      const m = resolveMarket(rec, key);
      expect(m.kind).toBe("added");
      expect(m.symbol).toBe("ETH-PERP");
      expect(m.clearingHouse).toBe("0x0000000000000000000000000000000000000008");
      expect(m.orderBook).toBe("0x0000000000000000000000000000000000000009");
      expect(m.oracle).toBe("0x0000000000000000000000000000000000000007");
      expect(m.pythFeedId).toBe(ETH_FEED);
      expect(m.hyperliquidCoin).toBe("ETH");
      expect(m.startBlock).toBe(500);
    }
  });

  it("unknown keys and missing markets fail loudly", () => {
    expect(() => resolveMarket(rec, "btc")).toThrow(/markets: ETH-PERP/);
    expect(() => resolveMarket(without("demoMarket"), "demo")).toThrow(/no demoMarket/);
    expect(() => resolveMarket(without("markets"), "eth")).toThrow(/markets: none/);
    expect(() => resolveMarket({ ...rec, deployed: false }, "main")).toThrow(/not a deployed record/);
    expect(() => resolveMarket({ ...rec, contracts: {} }, "main")).toThrow(/not deployed/);
  });

  it("baseCoin / findAddedMarket", () => {
    expect(baseCoin("ETH-PERP")).toBe("ETH");
    expect(baseCoin("MON-PERP-DEMO")).toBe("MON");
    expect(findAddedMarket(rec, "mon")).toBeUndefined();
  });

  it("the committed 10143 record resolves ETH-PERP with the Hermes feed id", () => {
    const path = fileURLToPath(new URL("../../../deployments/10143.json", import.meta.url));
    const live = JSON.parse(readFileSync(path, "utf8")) as MarketRecord;
    const m = resolveMarket(live, "eth", path);
    expect(m.symbol).toBe("ETH-PERP");
    expect(m.pythFeedId).toBe(ETH_FEED);
    expect(m.oracleKind).toBe("keeper-fed");
    expect(m.startBlock).toBeGreaterThan(live.startBlock);
    expect(resolveMarket(live, "main").clearingHouse).not.toBe(m.clearingHouse);
  });
});
