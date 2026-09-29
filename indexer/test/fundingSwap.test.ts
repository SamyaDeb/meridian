import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { A, ALICE, BOB, CHAIN, WAD, blk } from "./helpers.js";

const spc = (block: number, account: `0x${string}`, sizeDelta: bigint, newSize: bigint, aprWad: bigint, fee = 0n, isMaker = false) => ({
  contract: "FundingSwapMarket" as const,
  event: "SwapPositionChanged" as const,
  srcAddress: A.SWAP,
  block: blk(block),
  params: { account, sizeDelta, newSize, aprWad, realizedPnl: 0n, fee, isMaker },
});

describe("FundingSwapMarket", () => {
  it("MATH_SPEC §6.6 offset: long 1M at 12%, sell at 15% ⇒ locked spread K = −30,000", async () => {
    const indexer = createTestIndexer();
    const q = 1_000_000n * WAD;
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "FundingSwapMarket", event: "Deposited", srcAddress: A.SWAP, block: blk(1), params: { account: ALICE, amountToken: 3_000_000_000n, amountWad: 3_000n * WAD } },
            spc(2, ALICE, q, q, 12n * 10n ** 16n, 5n * WAD),
            spc(2, BOB, -q, -q, 12n * 10n ** 16n, -WAD, true),
          ],
        },
      },
    });
    expect(await indexer.SwapPosition.getOrThrow(`${A.SWAP}-${ALICE}`)).toMatchObject({
      size: q,
      fixedAprNotional: 120_000n * WAD,
      avgFixedAprWad: 12n * 10n ** 16n,
      lockedSpread: false,
      collateralWad: 3_000n * WAD - 5n * WAD,
    });
    expect((await indexer.SwapStats.getOrThrow(A.SWAP))).toMatchObject({ openInterestWad: q, feesWad: 4n * WAD });

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "FundingSwapMarket", event: "SwapAccrualSettled", srcAddress: A.SWAP, block: blk(10), params: { account: ALICE, floatingLeg: 150n * WAD, fixedLeg: 100n * WAD, net: 50n * WAD } },
            spc(10, ALICE, -q, 0n, 15n * 10n ** 16n),
          ],
        },
      },
    });
    const sp = await indexer.SwapPosition.getOrThrow(`${A.SWAP}-${ALICE}`);
    expect(sp).toMatchObject({
      size: 0n,
      fixedAprNotional: -30_000n * WAD,
      avgFixedAprWad: undefined,
      lockedSpread: true, // show "locked +x AUSD until maturity", not zero
      floatingReceived: 150n * WAD,
      fixedPaid: 100n * WAD,
      netAccrued: 50n * WAD,
    });
    expect((await indexer.SwapStats.getOrThrow(A.SWAP)).openInterestWad).toBe(0n);
    expect(await indexer.SwapTrade.getAll()).toHaveLength(3);
    expect((await indexer.ProtocolStats.getOrThrow("protocol")).swapCollateralToken).toBe(3_000_000_000n);
  });

  it("withdraw, liquidation, maturity and params", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "FundingSwapMarket", event: "Deposited", srcAddress: A.SWAP, block: blk(1), params: { account: ALICE, amountToken: 2_000_000n, amountWad: 2n * WAD } },
            { contract: "FundingSwapMarket", event: "Withdrawn", srcAddress: A.SWAP, block: blk(2), params: { account: ALICE, amountToken: 500_000n, amountWad: WAD / 2n } },
            { contract: "FundingSwapMarket", event: "SwapLiquidated", srcAddress: A.SWAP, block: blk(3), params: { account: ALICE, liquidator: BOB, sizeTransferred: WAD, markAprWad: 13n * 10n ** 16n, penalty: WAD / 10n, keeperReward: WAD / 20n, toInsurance: WAD / 20n, badDebt: 0n } },
            { contract: "FundingSwapMarket", event: "MaturitySettled", srcAddress: A.SWAP, block: blk(4), params: { cumFundingAtMaturity: 11n, cumIndexTimeAtMaturity: 22n, blockNumber: 4n } },
          ],
        },
      },
    });
    expect((await indexer.SwapPosition.getOrThrow(`${A.SWAP}-${ALICE}`))).toMatchObject({ collateralWad: 2n * WAD - WAD / 2n - WAD / 10n, liquidationCount: 1 });
    expect((await indexer.Liquidation.getAll())[0]).toMatchObject({ kind: "Swap", markAprWad: 13n * 10n ** 16n, markPriceWad: undefined });
    expect(await indexer.SwapStats.getOrThrow(A.SWAP)).toMatchObject({ matured: true, cumFundingAtMaturity: 11n, cumIndexTimeAtMaturity: 22n, maturityBlock: 4n });
    expect((await indexer.ProtocolStats.getOrThrow("protocol")).swapCollateralToken).toBe(1_500_000n);
  });
});
