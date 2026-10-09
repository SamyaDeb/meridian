import { describe, expect, it } from "vitest";
import testnet from "../../../deployments/10143.json";
import type { Deployment } from "./deployments";
import { decimalsFor, mockMarkets, perpMarkets, pickMarket } from "./markets";

describe("perpMarkets (K7)", () => {
  const ms = perpMarkets(testnet as unknown as Deployment);
  it("10143: MON-PERP (primary) then ETH-PERP from the record's markets list", () => {
    expect(ms.map((m) => m.symbol)).toEqual(["MON-PERP", "ETH-PERP"]);
    expect(ms[0]).toMatchObject({ key: "main", base: "MON", primary: true, sizeDp: 0, priceDp: 6 });
    expect(ms[0]!.clearingHouse).toBe(testnet.contracts.ClearingHouse);
  });
  it("ETH-PERP: tick 0.10, lot 0.001, own CH/OB/oracle, keeper-fed", () => {
    const eth = ms[1]!;
    expect(eth).toMatchObject({ key: "eth", base: "ETH", primary: false, keeperFed: true, sizeDp: 3, priceDp: 1 });
    expect(eth.tickSizeWad).toBe(10n ** 17n);
    expect(eth.lotSizeWad).toBe(10n ** 15n);
    expect(eth.clearingHouse).toBe(testnet.markets[0]!.ClearingHouse);
    expect(eth.clearingHouse).not.toBe(ms[0]!.clearingHouse);
    expect(eth.orderBook).not.toBe(ms[0]!.orderBook);
  });
  it("no record / no perp ⇒ no markets; a record without `markets` ⇒ primary only", () => {
    expect(perpMarkets(undefined)).toEqual([]);
    expect(perpMarkets({ chainId: 1, mocks: false, startBlock: 0, contracts: {} })).toEqual([]);
    const { markets: _drop, ...noMarkets } = testnet as unknown as Deployment;
    void _drop;
    expect(perpMarkets(noMarkets as Deployment)).toHaveLength(1);
  });
  it("decimalsFor prints one lot / tick exactly", () => {
    expect(decimalsFor(100n * 10n ** 18n)).toBe(0);
    expect(decimalsFor(10n ** 18n)).toBe(0);
    expect(decimalsFor(10n ** 15n)).toBe(3);
    expect(decimalsFor(10n ** 17n)).toBe(1);
    expect(decimalsFor(10n ** 12n)).toBe(6);
    expect(decimalsFor(25n * 10n ** 16n)).toBe(2);
    expect(decimalsFor(0n)).toBe(0);
  });
  it("pickMarket falls back to the primary market", () => {
    expect(pickMarket(ms, "eth")?.symbol).toBe("ETH-PERP");
    expect(pickMarket(ms, "doge")?.symbol).toBe("MON-PERP");
    expect(pickMarket(ms, null)?.symbol).toBe("MON-PERP");
    expect(pickMarket([], "eth")).toBeUndefined();
  });
  it("mock markets use the testnet ETH grid", () => {
    const [mon, eth] = mockMarkets({ clearingHouse: "0x0000000000000000000000000000000000000001", orderBook: "0x0000000000000000000000000000000000000002" });
    expect(mon!.primary).toBe(true);
    expect(eth!.tickSizeWad).toBe(BigInt((testnet.markets[0] as { tickSizeWad: string }).tickSizeWad));
    expect(eth!.lotSizeWad).toBe(BigInt((testnet.markets[0] as { lotSizeWad: string }).lotSizeWad));
  });
});
