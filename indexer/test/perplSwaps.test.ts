// CR-017: a second swap market settling on Perpl's funding. Its entities stay keyed by its own address (never mixed
// with the Meridian-funding market), its book resolves to it without a BookRef, it never mirrors Meridian's realized
// APR, and PerplFundingSource.Poked is indexed.
import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { TEST_PERPL_SWAP, renderConfig, renderDeploymentsTs, swapMarketsOf } from "../scripts/gen-config.mjs";
import { A, ALICE, BOB, CHAIN, WAD, blk } from "./helpers.js";

const P = {
  SWAP: TEST_PERPL_SWAP.FundingSwapMarket as `0x${string}`,
  SWAP_OB: TEST_PERPL_SWAP.SwapOrderBook as `0x${string}`,
  SRC: TEST_PERPL_SWAP.PerplFundingSource as `0x${string}`,
};
const tx = (block: number) => ({ hash: `0x${block.toString(16).padStart(64, "0")}` });
const poked = (block: number, cumFunding: bigint, cumIndexTime: bigint, feb: bigint) => ({
  contract: "PerplFundingSource" as const,
  event: "Poked" as const,
  srcAddress: P.SRC,
  block: blk(block),
  transaction: tx(block),
  params: { cumFunding, cumIndexTime, fundingEventBlock: feb, priceWad: 25_410_000_000_000_000n, rate: 0n },
});
const trade = (book: `0x${string}`, block: number, priceWad: bigint) => ({
  contract: "SwapOrderBook" as const,
  event: "Trade" as const,
  srcAddress: book,
  block: blk(block),
  transaction: tx(block),
  params: { makerOrderId: 1n, maker: ALICE, taker: BOB, takerIsBid: true, tick: 11_000n, lots: 10n, priceWad, sizeWad: 10_000n * WAD },
});
const spc = (swap: `0x${string}`, block: number, account: `0x${string}`, q: bigint) => ({
  contract: "FundingSwapMarket" as const,
  event: "SwapPositionChanged" as const,
  srcAddress: swap,
  block: blk(block),
  params: { account, sizeDelta: q, newSize: q, aprWad: WAD / 10n, realizedPnl: 0n, fee: 0n, isMaker: false },
});

describe("Perpl-funding swap market (CR-017)", () => {
  it("indexes Poked: snapshot, latest state, realized APR of the step (MATH_SPEC §6.8)", async () => {
    const indexer = createTestIndexer();
    // testnet smoke values: F −214,250,000,000,000, G 0 → 65,557,800,000,000,000,000 at feb 70,445,049 (rate 0)
    const F0 = -214_250_000_000_000n;
    await indexer.process({ chains: { [CHAIN]: { simulate: [poked(10, F0, 0n, 70_436_478n)] } } });
    let st = await indexer.PerplFundingSourceState.getOrThrow(P.SRC);
    expect(st).toMatchObject({ swapMarket: P.SWAP, cumFunding: F0, pokes: 1, lastIntervalAprWad: undefined, fundingEventBlock: 70_436_478n });
    const G1 = 65_557_800_000_000_000_000n;
    const F1 = F0 - 250_000_000_000n; // a −1 per 100k event at I = 0.02541
    await indexer.process({ chains: { [CHAIN]: { simulate: [poked(20, F1, G1, 70_445_049n)] } } });
    st = await indexer.PerplFundingSourceState.getOrThrow(P.SRC);
    const apr = ((-250_000_000_000n * WAD) / G1) * 31_536_000n; // ΔF·1e18/ΔG·YEAR, toward 0
    expect(st).toMatchObject({ pokes: 2, cumIndexTime: G1, lastIntervalAprWad: apr, lastPokeBlock: 20n });
    expect(apr).toBeLessThan(0n); // longs receive ⇒ negative APR
    const snaps = await indexer.PerplFundingSnapshot.getWhere({ source: { _eq: P.SRC } });
    expect(snaps).toHaveLength(2);
  });

  it("a trade on the Perpl swap book resolves to the Perpl market without a BookRef and never takes Meridian's APR", async () => {
    const indexer = createTestIndexer();
    // the Meridian perp market carries a realized APR: it must not leak into the Perpl market's stats
    indexer.Market.set({ ...(await marketWithApr(indexer)), id: A.CH });
    await indexer.process({ chains: { [CHAIN]: { simulate: [trade(P.SWAP_OB, 30, 11n * 10n ** 17n)] } } });
    const trades = await indexer.Trade.getWhere({ book: { _eq: P.SWAP_OB } });
    expect(trades[0]).toMatchObject({ kind: "Swap", swapMarket: P.SWAP, aprWad: WAD / 10n });
    const s = await indexer.SwapStats.getOrThrow(P.SWAP);
    expect(s).toMatchObject({ fundingSource: "perpl", source: P.SRC, realizedApr8hWad: undefined, tradeCount: 1 });
    // the Meridian-funding book (no BookRef either) still resolves to its own market
    await indexer.process({ chains: { [CHAIN]: { simulate: [trade(A.SWAP_OB, 31, 11n * 10n ** 17n)] } } });
    expect((await indexer.Trade.getWhere({ book: { _eq: A.SWAP_OB } }))[0]).toMatchObject({ swapMarket: A.SWAP });
    expect(await indexer.SwapStats.getOrThrow(A.SWAP)).toMatchObject({ fundingSource: "meridian", tradeCount: 1 });
  });

  it("the same account's positions in both markets are separate entities", async () => {
    const indexer = createTestIndexer();
    const q = 10_000n * WAD;
    await indexer.process({ chains: { [CHAIN]: { simulate: [spc(A.SWAP, 40, ALICE, q), spc(P.SWAP, 40, ALICE, -q)] } } });
    expect(await indexer.SwapPosition.getOrThrow(`${A.SWAP}-${ALICE}`)).toMatchObject({ swapMarket: A.SWAP, size: q });
    expect(await indexer.SwapPosition.getOrThrow(`${P.SWAP}-${ALICE}`)).toMatchObject({ swapMarket: P.SWAP, size: -q });
  });
});

describe("gen-config swapMarkets (CR-017)", () => {
  const dep = {
    chainId: 10143,
    startBlock: 1234,
    contracts: {
      ClearingHouse: "0x1000000000000000000000000000000000000001",
      FundingSwapMarket: "0x1000000000000000000000000000000000000004",
      SwapOrderBook: "0x1000000000000000000000000000000000000005",
    },
    swapMarkets: [{ ...TEST_PERPL_SWAP }],
  };
  it("lists every swap market under one contract name, and the source", () => {
    const y = renderConfig(10143, dep).split("chains:")[1]!;
    expect(y).toContain(`- name: FundingSwapMarket\n        address:\n          - "${dep.contracts.FundingSwapMarket}"\n          - "${TEST_PERPL_SWAP.FundingSwapMarket}"`);
    expect(y).toContain(`- name: SwapOrderBook\n        address:\n          - "${dep.contracts.SwapOrderBook}"\n          - "${TEST_PERPL_SWAP.SwapOrderBook}"`);
    expect(y).toContain(`- name: PerplFundingSource\n        address: "${TEST_PERPL_SWAP.PerplFundingSource}"`);
    const ts = renderDeploymentsTs([dep]);
    expect(ts).toContain(`fundingSource: "perpl", swapMarket: "${TEST_PERPL_SWAP.FundingSwapMarket}"`);
    expect(ts).toContain(`fundingSource: "meridian", swapMarket: "${dep.contracts.FundingSwapMarket}"`);
  });
  it("refuses an entry without deployed: true and bad addresses", () => {
    expect(() => swapMarketsOf({ swapMarkets: [{ ...TEST_PERPL_SWAP, deployed: false }] }, 10143)).toThrow(/not deployed/);
    expect(() => renderConfig(10143, { ...dep, swapMarkets: [{ ...TEST_PERPL_SWAP, deployed: undefined }] })).toThrow(/not deployed/);
    expect(() => swapMarketsOf({ swapMarkets: [{ ...TEST_PERPL_SWAP, SwapOrderBook: "0x12" }] }, 10143)).toThrow(/bad address/);
  });
});

async function marketWithApr(indexer: ReturnType<typeof createTestIndexer>) {
  // a Market row as the ClearingHouse handlers write it, with a realized 8 h APR of 12%
  await indexer.process({
    chains: {
      [CHAIN]: {
        simulate: [
          {
            contract: "ClearingHouse",
            event: "FundingUpdated",
            srcAddress: A.CH,
            block: blk(1),
            params: { blockNumber: 1n, premium: 0n, emaPremium: 0n, rate: 0n, cumFunding: 0n, cumIndexTime: 0n, indexPriceWad: 29n * 10n ** 15n, markPriceWad: 29n * 10n ** 15n },
          },
        ],
      },
    },
  });
  const m = await indexer.Market.getOrThrow(A.CH);
  return { ...m, realizedApr8hWad: 12n * 10n ** 16n };
}
