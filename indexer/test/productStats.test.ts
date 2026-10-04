// C5 metrics dashboard: ProtocolStats are PRODUCT stats (test markets excluded), external users exclude our own
// accounts, our MM's volume is disclosed separately (RISKS E9), and every change stamps its block.
import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { A, ALICE, BOB, CHAIN, WAD, blk } from "./helpers.js";
import { mmShareOf } from "../src/lib/common.js";
import { operatorList, renderDeploymentsTs } from "../scripts/gen-config.mjs";

// EIP-55 checksummed, as Envio decodes both srcAddress and address params (helpers.ts)
const DEMO_CH = "0x00000000000000000000000000000000000000D1" as const;
const DEMO_OB = "0x00000000000000000000000000000000000000D2" as const;
const registerDemo = {
  contract: "MarketFactory" as const,
  event: "MarketRegistered" as const,
  srcAddress: A.FACTORY,
  block: blk(1),
  params: { marketId: `0x${"d".repeat(64)}` as `0x${string}`, symbol: "MON-PERP-DEMO", orderBook: DEMO_OB, clearingHouse: DEMO_CH, oracle: "0x00000000000000000000000000000000000000D3" as const },
};

describe("ProtocolStats = product stats", () => {
  it("test-market deposits, fees and liquidations stay on the Market entity, not in the product numbers", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { [CHAIN]: { simulate: [registerDemo] } } });
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "ClearingHouse", event: "Deposited", srcAddress: DEMO_CH, block: blk(2), params: { account: ALICE, amountToken: 50_000_000n, amountWad: 50n * WAD } },
            { contract: "ClearingHouse", event: "PositionChanged", srcAddress: DEMO_CH, block: blk(3), params: { account: ALICE, sizeDelta: WAD, newSize: WAD, priceWad: WAD, realizedPnl: 0n, fee: 10n ** 15n, isMaker: false } },
            { contract: "ClearingHouse", event: "Liquidated", srcAddress: DEMO_CH, block: blk(4), params: { account: ALICE, liquidator: BOB, sizeTransferred: WAD, markPriceWad: WAD, penalty: 0n, keeperReward: 0n, toInsurance: 0n, badDebt: 0n } },
          ],
        },
      },
    });
    const s = await indexer.ProtocolStats.getOrThrow("protocol");
    expect(s).toMatchObject({ perpCollateralToken: 0n, feesWad: 0n, liquidations: 0, externalUsers: 0, perpVolumeQuoteWad: 0n });
    expect(s.users).toBe(1); // every account seen (incl. on test markets) stays in `users`
    expect((await indexer.Market.getOrThrow(DEMO_CH)).feesWad).toBe(10n ** 15n);

    // the same account's first product-market action counts it once as an external user; the block is stamped
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "ClearingHouse", event: "Deposited", srcAddress: A.CH, block: blk(7), params: { account: ALICE, amountToken: 20_000_000n, amountWad: 20n * WAD } },
            { contract: "ClearingHouse", event: "Deposited", srcAddress: A.CH, block: blk(8), params: { account: ALICE, amountToken: 1_000_000n, amountWad: WAD } },
          ],
        },
      },
    });
    const s2 = await indexer.ProtocolStats.getOrThrow("protocol");
    expect(s2).toMatchObject({ perpCollateralToken: 21_000_000n, tvlToken: 21_000_000n, externalUsers: 1, users: 1, updatedBlock: 8n });
    expect((await indexer.Account.getOrThrow(ALICE)).countedExternal).toBe(true);
  });

  it("product perp trades count volume and users; no MM listed on 31337 ⇒ MM share 0", async () => {
    const indexer = createTestIndexer();
    const P = 29n * 10n ** 15n;
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "OrderBook", event: "OrderPlaced", srcAddress: A.OB, block: blk(10), params: { orderId: 1n, maker: BOB, isBid: false, tick: 29_000n, lots: 10n, flags: 0n } },
            { contract: "OrderBook", event: "Trade", srcAddress: A.OB, block: blk(11), params: { makerOrderId: 1n, maker: BOB, taker: ALICE, takerIsBid: true, tick: 29_000n, lots: 10n, priceWad: P, sizeWad: 1_000n * WAD } },
          ],
        },
      },
    });
    const s = await indexer.ProtocolStats.getOrThrow("protocol");
    expect(s).toMatchObject({ externalUsers: 2, trades: 1, perpVolumeQuoteWad: 29n * WAD, perpVolumeMmQuoteWad: 0n, updatedBlock: 11n });
  });
});

describe("MM share and operator lists (pure)", () => {
  const MM = "0x00000000000000000000000000000000000000aa";
  it("a trade counts toward the MM share once when our MM is maker, taker or both", () => {
    const mm = [MM];
    expect(mmShareOf(MM, ALICE, 5n, mm)).toBe(5n);
    expect(mmShareOf(ALICE, MM.toUpperCase().replace("0X", "0x"), 5n, mm)).toBe(5n);
    expect(mmShareOf(MM, MM, 5n, mm)).toBe(5n);
    expect(mmShareOf(ALICE, BOB, 5n, mm)).toBe(0n);
  });
  it("operator lists come only from the deploy record; a malformed entry is an error, never a guess", () => {
    expect(operatorList(undefined, 143, "mmAccounts")).toEqual([]);
    expect(operatorList([MM.toUpperCase().replace("0X", "0x")], 143, "mmAccounts")).toEqual([MM]);
    expect(() => operatorList(["0x123"], 143, "mmAccounts")).toThrow(/bad address/);
    expect(() => operatorList(MM, 143, "mmAccounts")).toThrow(/array/);
    const ts = renderDeploymentsTs([
      { chainId: 143, owner: "0x00000000000000000000000000000000000000Bb", mmAccounts: [MM], keeperAccounts: ["0x00000000000000000000000000000000000000cc"], contracts: {} },
    ]);
    expect(ts).toContain(`143: ["${MM}"]`);
    expect(ts).toContain(`143: ["${MM}", "0x00000000000000000000000000000000000000cc", "0x00000000000000000000000000000000000000bb"]`);
  });
});
