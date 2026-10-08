import { describe, expect, it } from "vitest";
import { createMockSource } from "./source";
import { ETH_MOCK_K, createScaledMockSource } from "./scaled";
import { withPerpMarket } from "../composite";

const WAD = 10n ** 18n;
const NOW = Date.UTC(2026, 9, 8, 12);
const mon = createMockSource(() => NOW);
const eth = createScaledMockSource(mon, {
  symbol: "ETH-PERP",
  clearingHouse: "0x00000000000000000000000000000000000E7401",
  orderBook: "0x00000000000000000000000000000000000E7402",
  k: ETH_MOCK_K,
  tickSizeWad: 10n ** 17n,
  lotSizeWad: 10n ** 15n,
  maxOpenInterest: 25n * 10n ** 17n,
  maxPositionSize: 25n * 10n ** 16n,
});

describe("scaled mock ETH-PERP (K7)", () => {
  it("prices × k on the ETH grid, symbol and ids of the ETH market", async () => {
    const [m0, m1] = await Promise.all([mon.market(), eth.market()]);
    expect(m1.symbol).toBe("ETH-PERP");
    expect(m1.clearingHouse).toBe("0x00000000000000000000000000000000000E7401");
    expect(m1.lastMarkPrice).toBe(m0.lastMarkPrice * ETH_MOCK_K);
    expect(m1.lastRateAprWad).toBe(m0.lastRateAprWad); // funding APR is price-independent
    expect(m1.lastMarkPrice > 1000n * WAD && m1.lastMarkPrice < 5000n * WAD).toBe(true);
  });
  it("book and trades: notional unchanged, ticks / lots on the ETH grid", async () => {
    const [d0, d1] = await Promise.all([mon.depth(6), eth.depth(6)]);
    d1.bids.forEach((l, i) => {
      expect(l.priceWad % 10n ** 17n).toBe(0n);
      expect(l.sizeWad % 10n ** 15n).toBe(0n);
      expect((l.priceWad * l.sizeWad) / WAD).toBe((d0.bids[i]!.priceWad * d0.bids[i]!.sizeWad) / WAD);
    });
    const t = (await eth.trades(5))[0]!;
    expect(t.tick * 10n ** 17n).toBe(t.priceWad);
    expect(t.lots * 10n ** 15n).toBe(t.sizeWad);
  });
  it("own caps; vault and swaps pass through", async () => {
    expect((await eth.riskParams()).maxPositionSize).toBe(25n * 10n ** 16n);
    expect(await eth.vault()).toEqual(await mon.vault());
  });
  it("withPerpMarket: market reads from the market, vault / swaps / stats from the primary", async () => {
    const c = withPerpMarket(mon, eth, "eth");
    expect(c.marketKey).toBe("eth");
    expect((await c.market()).symbol).toBe("ETH-PERP");
    expect(c.vault).toBe(mon.vault);
    expect(c.swapStats).toBe(mon.swapStats);
    expect(c.protocolStats).toBe(mon.protocolStats);
  });
});
