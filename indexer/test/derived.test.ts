// K2.1 derived entities: FundingWindow (1 h / 8 h / 24 h / 7 d), AccountMarket.lastTradeBlock, the insurance-fund
// waterfall (InsuranceFundEvent), ProtocolDaily, the vault queue's timestamps and protocol open interest.
import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { A, ALICE, BOB, CHAIN, KEEPER, WAD, blk } from "./helpers.js";
import { realizedAprWad, rateToAprWad } from "../src/lib/math.js";
import { dayStart, rollDaily } from "../src/lib/common.js";

const funding = (block: number, f: bigint, g: bigint, rate = 3_472_222_222n) => ({
  contract: "ClearingHouse" as const,
  event: "FundingUpdated" as const,
  srcAddress: A.CH,
  block: blk(block),
  params: { blockNumber: BigInt(block), premium: 0n, emaPremium: 0n, rate, cumFunding: f, cumIndexTime: g, indexPriceWad: WAD, markPriceWad: WAD },
});
const checkpoint = (block: number, f: bigint, g: bigint) => ({
  contract: "ClearingHouse" as const,
  event: "FundingCheckpoint" as const,
  srcAddress: A.CH,
  block: blk(block),
  params: { slot: 0n, blockNumber: BigInt(block), cumFunding: f, cumIndexTime: g },
});
const pos = (block: number, account: `0x${string}`, sizeDelta: bigint, newSize: bigint, fee = 0n) => ({
  contract: "ClearingHouse" as const,
  event: "PositionChanged" as const,
  srcAddress: A.CH,
  block: blk(block),
  params: { account, sizeDelta, newSize, priceWad: WAD, realizedPnl: 0n, fee, isMaker: false },
});

describe("FundingWindow: realized APR over 1 h / 8 h / 24 h / 7 d (MATH_SPEC §1.8)", () => {
  it("7 d = the checkpoint at or before block − 2,016,000, with the start block of every window", async () => {
    const indexer = createTestIndexer();
    const head = 2_100_000;
    const cps: Array<[number, bigint, bigint]> = [
      [83_900, 1n * 10n ** 12n, 1n * 10n ** 20n], // ≤ head − 2,016,000 = 84,000 → 7 d (the keeper fills every 200-block bucket)
      [1_812_000, 5n * 10n ** 13n, 5n * 10n ** 21n], // ≤ head − 288,000 = 1,812,000 → 24 h
      [2_004_000, 6n * 10n ** 13n, 6n * 10n ** 21n], // ≤ head − 96,000 → 8 h
      [2_088_000, 7n * 10n ** 13n, 7n * 10n ** 21n], // ≤ head − 12,000 → 1 h
    ];
    const [F, G] = [8n * 10n ** 13n, 8n * 10n ** 21n];
    await indexer.process({ chains: { [CHAIN]: { simulate: [...cps.map(([b, f, g]) => checkpoint(b, f, g)), funding(head, F, G)] } } });
    const w = await indexer.FundingWindow.getOrThrow(A.CH);
    expect(w).toMatchObject({
      market: A.CH,
      block: BigInt(head),
      blockTimeMs: 300n,
      rateAprWad: rateToAprWad(3_472_222_222n),
      apr7dWad: realizedAprWad(cps[0]![1], cps[0]![2], F, G),
      apr24hWad: realizedAprWad(cps[1]![1], cps[1]![2], F, G),
      apr8hWad: realizedAprWad(cps[2]![1], cps[2]![2], F, G),
      apr1hWad: realizedAprWad(cps[3]![1], cps[3]![2], F, G),
      fromBlock7d: 83_900n,
      fromBlock24h: 1_812_000n,
      fromBlock8h: 2_004_000n,
      fromBlock1h: 2_088_000n,
    });
    expect((await indexer.Market.getOrThrow(A.CH)).realizedApr7dWad).toBe(w.apr7dWad);
  });

  it("a window without history is null (never a made-up rate)", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { [CHAIN]: { simulate: [checkpoint(1_000, 1n, 10n), funding(13_000, 2n, 20n)] } } });
    const w = await indexer.FundingWindow.getOrThrow(A.CH);
    expect(w.apr1hWad).toBe(realizedAprWad(1n, 10n, 2n, 20n));
    expect([w.apr8hWad, w.apr24hWad, w.apr7dWad, w.fromBlock7d]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe("AccountMarket.lastTradeBlock and protocol open interest", () => {
  it("lastTradeBlock follows PositionChanged; ProtocolStats OI per side follows the product market", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { [CHAIN]: { simulate: [pos(10, ALICE, 3n * WAD, 3n * WAD), pos(10, BOB, -3n * WAD, -3n * WAD), pos(20, ALICE, -WAD, 2n * WAD)] } } });
    expect((await indexer.AccountMarket.getOrThrow(`${A.CH}-${ALICE}`)).lastTradeBlock).toBe(20n);
    expect((await indexer.AccountMarket.getOrThrow(`${A.CH}-${BOB}`)).lastTradeBlock).toBe(10n);
    const s = await indexer.ProtocolStats.getOrThrow("protocol");
    const m = await indexer.Market.getOrThrow(A.CH);
    expect([s.perpOpenInterestLongWad, s.perpOpenInterestShortWad]).toEqual([2n * WAD, 3n * WAD]);
    expect([s.perpOpenInterestLongWad, s.perpOpenInterestShortWad]).toEqual([m.openInterestLongWad, m.openInterestShortWad]);
  });
});

describe("InsuranceFundEvent: the bad-debt waterfall, one row per step", () => {
  const tx = `0x${"ab".repeat(32)}` as `0x${string}`;
  const at = (n: number, logIndex: number) => ({ block: blk(n), logIndex, transaction: { hash: tx } });

  it("top-up, penalty in, then IF → fees → uncovered in log order; IF balance tracked", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "InsuranceFund", event: "Funded", srcAddress: A.IF, ...at(5, 0), params: { from: KEEPER, amountToken: 100_000_000n } },
            // a liquidation whose IF share is 2.5 AUSD (+ dust that stays as fees)
            { contract: "ClearingHouse", event: "Liquidated", srcAddress: A.CH, ...at(6, 3), params: { account: ALICE, liquidator: BOB, sizeTransferred: WAD, markPriceWad: WAD, penalty: 3n * WAD, keeperReward: WAD / 2n, toInsurance: (5n * WAD) / 2n + 7n, badDebt: 0n } },
            // a liquidation with 150 AUSD bad debt: IF pays its 102.5, fees 20, 27.5 uncovered
            { contract: "InsuranceFund", event: "BadDebtCovered", srcAddress: A.IF, ...at(7, 1), params: { market: A.CH, requestedToken: 150_000_000n, coveredToken: 102_500_000n } },
            { contract: "ClearingHouse", event: "BadDebtSocialized", srcAddress: A.CH, ...at(7, 2), params: { requested: 150n * WAD, coveredByInsurance: (205n * WAD) / 2n, uncovered: (55n * WAD) / 2n } },
            { contract: "ClearingHouse", event: "Liquidated", srcAddress: A.CH, ...at(7, 3), params: { account: BOB, liquidator: ALICE, sizeTransferred: WAD, markPriceWad: WAD, penalty: 0n, keeperReward: 0n, toInsurance: 0n, badDebt: 150n * WAD } },
          ],
        },
      },
    });
    const rows = (await indexer.InsuranceFundEvent.getAll()).sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(rows.map((r) => [r.flow, r.direction, r.amountWad, r.balanceAfterToken])).toEqual([
      ["Funded", "In", 100n * WAD, 100_000_000n],
      ["PenaltyIn", "In", (5n * WAD) / 2n, 102_500_000n], // toInsurance / 1e12 rounded down, as _payInsurance sends
      ["CoveredByInsurance", "Out", (205n * WAD) / 2n, 0n],
      ["CoveredByFees", "None", 20n * WAD, 0n],
      ["Uncovered", "None", (55n * WAD) / 2n, 0n],
    ]);
    expect(rows[0]).toMatchObject({ from: KEEPER, kind: undefined, txHash: tx });
    expect(rows[1]).toMatchObject({ kind: "Perp", market: A.CH, account: ALICE, amountToken: 2_500_000n });
    expect(rows[2]).toMatchObject({ kind: "Perp", market: A.CH, requestedWad: 150n * WAD });
    expect(rows[3]!.requestedWad).toBe(150n * WAD);
    const f = await indexer.InsuranceFund.getOrThrow(A.IF);
    expect(f).toMatchObject({ fundedToken: 100_000_000n, penaltyToken: 2_500_000n, coveredToken: 102_500_000n, balanceToken: 0n });
    const bd = (await indexer.BadDebtEvent.getAll()).find((b) => b.source === A.CH)!;
    expect(bd.feeCoveredWad).toBe(20n * WAD);
  });

  it("IF covers everything: no fee / uncovered steps (BadDebtSocialized is not emitted)", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "InsuranceFund", event: "Funded", srcAddress: A.IF, ...at(5, 0), params: { from: KEEPER, amountToken: 10_000_000n } },
            { contract: "InsuranceFund", event: "BadDebtCovered", srcAddress: A.IF, ...at(6, 0), params: { market: A.CH, requestedToken: 4_000_000n, coveredToken: 4_000_000n } },
          ],
        },
      },
    });
    const flows = (await indexer.InsuranceFundEvent.getAll()).map((r) => r.flow).sort();
    expect(flows).toEqual(["CoveredByInsurance", "Funded"]);
    expect((await indexer.InsuranceFund.getOrThrow(A.IF)).balanceToken).toBe(6_000_000n);
  });
});

describe("ProtocolDaily: a UTC day's flows and closes", () => {
  it("rolls the ProtocolStats changes into the event's day; closes carry the last value", async () => {
    const indexer = createTestIndexer();
    const DAY_BLOCKS = 288_000; // 86,400 s at 300 ms (helpers.blk)
    const b1 = 1_000;
    const b2 = b1 + DAY_BLOCKS + 10;
    const trade = (block: number, maker: `0x${string}`, taker: `0x${string}`) => ({
      contract: "OrderBook" as const,
      event: "Trade" as const,
      srcAddress: A.OB,
      block: blk(block),
      params: { makerOrderId: 1n, maker, taker, takerIsBid: true, tick: 1n, lots: 1n, priceWad: 2n * WAD, sizeWad: 5n * WAD },
    });
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "ClearingHouse", event: "Deposited", srcAddress: A.CH, block: blk(b1), params: { account: ALICE, amountToken: 7_000_000n, amountWad: 7n * WAD } },
            trade(b1 + 1, ALICE, BOB),
            pos(b1 + 1, BOB, WAD, WAD, 10n ** 15n),
            pos(b1 + 1, ALICE, -WAD, -WAD),
            trade(b2, BOB, ALICE),
          ],
        },
      },
    });
    const d1 = dayStart(BigInt(blk(b1).timestamp));
    const d2 = dayStart(BigInt(blk(b2).timestamp));
    expect(d2).toBeGreaterThan(d1);
    const r1 = await indexer.ProtocolDaily.getOrThrow(String(d1));
    const r2 = await indexer.ProtocolDaily.getOrThrow(String(d2));
    expect(r1).toMatchObject({ day: d1, trades: 1, perpVolumeQuoteWad: 10n * WAD, feesWad: 10n ** 15n, newUsers: 2, newExternalUsers: 2, activeExternalUsers: 2 });
    expect(r1).toMatchObject({ perpCollateralTokenClose: 7_000_000n, tvlTokenClose: 7_000_000n, perpOpenInterestLongWadClose: WAD, perpOpenInterestShortWadClose: WAD });
    expect(r2).toMatchObject({ trades: 1, perpVolumeQuoteWad: 10n * WAD, newUsers: 0, activeExternalUsers: 2, perpCollateralTokenClose: 7_000_000n });
    const s = await indexer.ProtocolStats.getOrThrow("protocol");
    expect(r1.trades + r2.trades).toBe(s.trades);
    expect(r1.perpVolumeQuoteWad + r2.perpVolumeQuoteWad).toBe(s.perpVolumeQuoteWad);
  });

  it("rollDaily adds the change of every flow and takes closes from the new stats (pure)", () => {
    const zero = { perpVolumeQuoteWad: 0n, perpVolumeMmQuoteWad: 0n, swapVolumeWad: 0n, feesWad: 0n, trades: 0, liquidations: 0, fundingTicks: 0, users: 0, externalUsers: 0, tvlToken: 0n, perpCollateralToken: 0n, vaultNavToken: 0n, perpOpenInterestLongWad: 0n, perpOpenInterestShortWad: 0n, swapOpenInterestWad: 0n } as never;
    const prev = { ...(zero as object), trades: 4, feesWad: 10n, tvlToken: 5n } as never;
    const next = { ...(zero as object), trades: 6, feesWad: 7n, tvlToken: 9n, swapOpenInterestWad: 3n } as never;
    const d = { id: "0", day: 0n, perpVolumeQuoteWad: 0n, perpVolumeMmQuoteWad: 0n, swapVolumeWad: 0n, feesWad: 1n, trades: 1, liquidations: 0, fundingTicks: 0, newUsers: 0, newExternalUsers: 0, activeExternalUsers: 0, tvlTokenClose: 0n, perpCollateralTokenClose: 0n, vaultNavTokenClose: 0n, perpOpenInterestLongWadClose: 0n, perpOpenInterestShortWadClose: 0n, swapOpenInterestWadClose: 0n, updatedBlock: 3n };
    const r = rollDaily(d, prev, next, 2n);
    expect(r).toMatchObject({ trades: 3, feesWad: -2n, tvlTokenClose: 9n, swapOpenInterestWadClose: 3n, updatedBlock: 3n }); // fee rebates can make a flow negative
  });
});

describe("Vault v2 queue lifecycle timestamps (request → fulfil → claim; cancel)", () => {
  it("records block, time and tx of every step", async () => {
    const indexer = createTestIndexer();
    const tx = (n: number) => ({ hash: `0x${n.toString(16).padStart(64, "0")}` as `0x${string}` });
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: "MeridianVault", event: "RedeemRequested", srcAddress: A.VAULT, block: blk(10), transaction: tx(1), params: { id: 1n, owner: ALICE, receiver: ALICE, shares: 5n * WAD } },
            { contract: "MeridianVault", event: "RedeemRequested", srcAddress: A.VAULT, block: blk(11), transaction: tx(2), params: { id: 2n, owner: BOB, receiver: BOB, shares: WAD } },
            { contract: "MeridianVault", event: "RedeemFulfilled", srcAddress: A.VAULT, block: blk(20), transaction: tx(3), params: { id: 1n, assets: 5_000_000n, unwindCost: 1_000n } },
            { contract: "MeridianVault", event: "RedeemClaimed", srcAddress: A.VAULT, block: blk(30), transaction: tx(4), params: { id: 1n, receiver: ALICE, assets: 5_000_000n } },
            { contract: "MeridianVault", event: "RedeemCancelled", srcAddress: A.VAULT, block: blk(31), transaction: tx(5), params: { id: 2n } },
          ],
        },
      },
    });
    const r1 = await indexer.VaultRedeemRequest.getOrThrow(`${A.VAULT}-1`);
    expect(r1).toMatchObject({
      status: "Claimed",
      requestedAt: BigInt(blk(10).timestamp),
      fulfilledBlock: 20n,
      fulfilledAt: BigInt(blk(20).timestamp),
      fulfilTxHash: tx(3).hash,
      claimedBlock: 30n,
      claimedAt: BigInt(blk(30).timestamp),
      claimTxHash: tx(4).hash,
    });
    const r2 = await indexer.VaultRedeemRequest.getOrThrow(`${A.VAULT}-2`);
    expect(r2).toMatchObject({ status: "Cancelled", cancelledBlock: 31n, cancelledAt: BigInt(blk(31).timestamp) });
  });
});
