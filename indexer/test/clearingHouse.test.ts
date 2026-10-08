import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { A, ALICE, BOB, CHAIN, WAD, blk } from "./helpers.js";
import { realizedAprWad, rateToAprWad } from "../src/lib/math.js";

const funding = (block: number, f: bigint, g: bigint, rate = 3_472_222_222n) => ({
  contract: "ClearingHouse" as const,
  event: "FundingUpdated" as const,
  srcAddress: A.CH,
  block: blk(block),
  params: {
    blockNumber: BigInt(block),
    premium: 2n * 10n ** 15n,
    emaPremium: 10n ** 15n,
    rate,
    cumFunding: f,
    cumIndexTime: g,
    indexPriceWad: 29n * 10n ** 15n,
    markPriceWad: 29n * 10n ** 15n + 10n ** 12n,
  },
});
const checkpoint = (block: number, f: bigint, g: bigint, slot = 0n) => ({
  contract: "ClearingHouse" as const,
  event: "FundingCheckpoint" as const,
  srcAddress: A.CH,
  block: blk(block),
  params: { slot, blockNumber: BigInt(block), cumFunding: f, cumIndexTime: g },
});

describe("FundingUpdated → FundingTick (one per block, incl. cumIndexTime)", () => {
  it("writes the tick and the market's live funding state", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { [CHAIN]: { simulate: [funding(10, 111n, 222n), funding(11, 333n, 444n)] } } });
    const t = await indexer.FundingTick.getOrThrow(`${A.CH}-11`);
    expect(t).toMatchObject({
      market_id: A.CH,
      block: 11n,
      timestamp: BigInt(blk(11).timestamp),
      rate: 3_472_222_222n,
      rateAprWad: rateToAprWad(3_472_222_222n),
      premium: 2n * 10n ** 15n,
      emaPremium: 10n ** 15n,
      cumFunding: 333n,
      cumIndexTime: 444n,
      index: 29n * 10n ** 15n,
      mark: 29n * 10n ** 15n + 10n ** 12n,
    });
    const m = await indexer.Market.getOrThrow(A.CH);
    expect(m).toMatchObject({ symbol: "MON-PERP", orderBook: A.OB, lastFundingBlock: 11n, lastCumFunding: 333n, lastCumIndexTime: 444n, fundingTickCount: 2 });
    expect((await indexer.ProtocolStats.getOrThrow("protocol")).fundingTicks).toBe(2);
  });
});

describe("realized APR windows = ΔF/ΔG·YEAR vs the checkpoint 1 h back (averageFundingApr semantics)", () => {
  it("uses the checkpoint at or before block − 12,000 (300 ms blocks)", async () => {
    const indexer = createTestIndexer();
    const [f1, g1] = [5n * 10n ** 12n, 7n * 10n ** 20n];
    const [f2, g2] = [9n * 10n ** 13n, 3n * 10n ** 22n];
    await indexer.process({ chains: { [CHAIN]: { simulate: [checkpoint(1_000, f1, g1), funding(13_000, f2, g2)] } } });
    const m = await indexer.Market.getOrThrow(A.CH);
    expect(m.realizedApr1hWad).toBe(realizedAprWad(f1, g1, f2, g2));
    expect(m.realizedApr8hWad).toBeUndefined(); // not enough history
    expect(m.realizedApr24hWad).toBeUndefined();
  });

  it("walks back to the previous bucket when the bucket's checkpoint is after the target", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            checkpoint(800, 10n, 100n, 0n), // bucket 4
            checkpoint(1_150, 20n, 200n, 1n), // bucket 5, after target 1,100
            funding(13_100, 1_010n, 1_100n),
          ],
        },
      },
    });
    expect((await indexer.Market.getOrThrow(A.CH)).realizedApr1hWad).toBe(realizedAprWad(10n, 100n, 1_010n, 1_100n));
  });

  it("stores windows on each checkpoint (oracle history) and respects blockTimeMs from FundingParamsUpdated", async () => {
    const indexer = createTestIndexer();
    const params = {
      alpha: 2n * 10n ** 15n,
      interestRate: 3_472_222_222n,
      rateCap: 555_555_555_556n,
      maxRateChangePerBlock: 555_555_556n,
      blockTimeMs: 400n, // 1 h = 9,000 blocks
      premiumBandWad: 5n * 10n ** 16n,
    };
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "ClearingHouse", event: "FundingParamsUpdated", srcAddress: A.CH, block: blk(5), params: { params } },
            checkpoint(1_000, 1n, 10n, 5n),
            checkpoint(10_000, 51n, 60n, 50n),
          ],
        },
      },
    });
    const cp = await indexer.FundingCheckpoint.getOrThrow(`${A.CH}-50`);
    expect(cp).toMatchObject({ slot: 50, bucket: 50n, blockNumber: 10_000n, cumFunding: 51n, cumIndexTime: 60n });
    expect(cp.realizedApr1hWad).toBe(realizedAprWad(1n, 10n, 51n, 60n));
    const m = await indexer.Market.getOrThrow(A.CH);
    expect(m.blockTimeMs).toBe(400n);
    expect(m.fundingParams).toMatchObject({ blockTimeMs: "400", alpha: "2000000000000000" });
  });
});

describe("account lifecycle: deposit → fill → funding → margin → withdraw → liquidation", () => {
  it("mirrors AccountMarket, Market OI and ProtocolStats", async () => {
    const indexer = createTestIndexer();
    const P = 30n * 10n ** 15n;
    const size = 1_000n * WAD;
    const fee = 15n * 10n ** 15n; // 5 bps of 30 AUSD
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "ClearingHouse", event: "Deposited", srcAddress: A.CH, block: blk(20), params: { account: ALICE, amountToken: 100_000_000n, amountWad: 100n * WAD } },
            { contract: "ClearingHouse", event: "PositionChanged", srcAddress: A.CH, block: blk(21), params: { account: ALICE, sizeDelta: size, newSize: size, priceWad: P, realizedPnl: 0n, fee, isMaker: false } },
            { contract: "ClearingHouse", event: "PositionChanged", srcAddress: A.CH, block: blk(21), params: { account: BOB, sizeDelta: -size, newSize: -size, priceWad: P, realizedPnl: 0n, fee: -3n * 10n ** 15n, isMaker: true } },
            { contract: "ClearingHouse", event: "FundingSettled", srcAddress: A.CH, block: blk(22), params: { account: ALICE, payment: 2n * 10n ** 15n, cumFunding: 777n } },
            { contract: "ClearingHouse", event: "OrderMarginChanged", srcAddress: A.CH, block: blk(23), params: { account: ALICE, reservedOrderMargin: 5n * WAD } },
            { contract: "ClearingHouse", event: "Withdrawn", srcAddress: A.CH, block: blk(24), params: { account: ALICE, amountToken: 10_000_000n, amountWad: 10n * WAD } },
          ],
        },
      },
    });
    const am = await indexer.AccountMarket.getOrThrow(`${A.CH}-${ALICE}`);
    expect(am).toMatchObject({
      account_id: ALICE,
      market_id: A.CH,
      size,
      openNotional: 30n * WAD,
      entryPrice: P,
      feesPaid: fee,
      fundingPaid: 2n * 10n ** 15n,
      lastCumFunding: 777n,
      reservedOrderMargin: 5n * WAD,
      depositedToken: 100_000_000n,
      withdrawnToken: 10_000_000n,
      collateralWad: 100n * WAD - fee - 2n * 10n ** 15n - 10n * WAD,
    });
    const m = await indexer.Market.getOrThrow(A.CH);
    expect(m).toMatchObject({ openInterestLongWad: size, openInterestShortWad: size, feesWad: fee - 3n * 10n ** 15n });
    const s = await indexer.ProtocolStats.getOrThrow("protocol");
    expect(s).toMatchObject({ users: 2, perpCollateralToken: 90_000_000n, tvlToken: 90_000_000n, feesWad: fee - 3n * 10n ** 15n });

    // −15% ⇒ liquidated (DEMO_SCRIPT crash): position transferred, penalty charged
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "ClearingHouse", event: "Liquidated", srcAddress: A.CH, block: blk(30), transaction: { hash: "0xabc" }, params: { account: ALICE, liquidator: BOB, sizeTransferred: size, markPriceWad: 25_500n * 10n ** 12n, penalty: WAD, keeperReward: WAD / 2n, toInsurance: WAD / 2n, badDebt: 0n } },
            { contract: "ClearingHouse", event: "PositionChanged", srcAddress: A.CH, block: blk(30), params: { account: ALICE, sizeDelta: -size, newSize: 0n, priceWad: 25_500n * 10n ** 12n, realizedPnl: -4_500n * 10n ** 15n, fee: 0n, isMaker: false } },
          ],
        },
      },
    });
    const liq = await indexer.Liquidation.getAll();
    expect(liq).toHaveLength(1);
    expect(liq[0]).toMatchObject({ kind: "Perp", account: ALICE, liquidator: BOB, penalty: WAD, badDebt: 0n, txHash: "0xabc" });
    const after = await indexer.AccountMarket.getOrThrow(`${A.CH}-${ALICE}`);
    expect(after).toMatchObject({ size: 0n, openNotional: 0n, entryPrice: 0n, liquidationCount: 1 });
    expect(after.collateralWad).toBe(am.collateralWad - WAD - 4_500n * 10n ** 15n);
    expect((await indexer.Market.getOrThrow(A.CH)).openInterestLongWad).toBe(0n);
    expect((await indexer.ProtocolStats.getOrThrow("protocol")).liquidations).toBe(1);
  });

  it("bad debt floors collateral at zero", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "ClearingHouse", event: "Deposited", srcAddress: A.CH, block: blk(1), params: { account: ALICE, amountToken: 1_000_000n, amountWad: WAD } },
            { contract: "ClearingHouse", event: "Liquidated", srcAddress: A.CH, block: blk(2), params: { account: ALICE, liquidator: BOB, sizeTransferred: WAD, markPriceWad: WAD, penalty: WAD / 2n, keeperReward: 0n, toInsurance: 0n, badDebt: 3n * WAD } },
            { contract: "ClearingHouse", event: "BadDebtSocialized", srcAddress: A.CH, block: blk(2), params: { requested: 3n * WAD, coveredByInsurance: 2n * WAD, uncovered: WAD } },
          ],
        },
      },
    });
    expect((await indexer.AccountMarket.getOrThrow(`${A.CH}-${ALICE}`)).collateralWad).toBe(0n);
    const bd = await indexer.BadDebtEvent.getAll();
    expect(bd[0]).toMatchObject({ source: A.CH, requested: 3n * WAD, covered: 2n * WAD, uncovered: WAD });
  });
});

describe("admin events", () => {
  it("RiskParamsUpdated, PausedSet, FeesCollected update the market and the admin log", async () => {
    const indexer = createTestIndexer();
    const risk = {
      imr: 2n * 10n ** 17n,
      mmr: 10n ** 17n,
      takerFee: 5n * 10n ** 14n,
      makerFee: -(10n ** 14n),
      liqPenalty: 10n ** 16n,
      keeperShare: 5n * 10n ** 17n,
      maxOpenInterest: 250_000n * WAD,
      maxPositionSize: 25_000n * WAD,
    };
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "ClearingHouse", event: "RiskParamsUpdated", srcAddress: A.CH, block: blk(1), params: { params: risk } },
            { contract: "ClearingHouse", event: "PausedSet", srcAddress: A.CH, block: blk(2), params: { paused: true } },
            { contract: "ClearingHouse", event: "FeesCollected", srcAddress: A.CH, block: blk(3), params: { to: BOB, amountToken: 1_234_567n } },
          ],
        },
      },
    });
    const m = await indexer.Market.getOrThrow(A.CH);
    expect(m.paused).toBe(true);
    expect(m.feesCollectedToken).toBe(1_234_567n);
    expect(m.riskParams).toMatchObject({ imr: "200000000000000000", makerFee: "-100000000000000" });
    const names = (await indexer.AdminEvent.getAll()).map((e) => e.name).sort();
    expect(names).toEqual(["FeesCollected", "PausedSet", "RiskParamsUpdated"]);
  });
});
