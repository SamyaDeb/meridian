// K2.2 Perpl handlers on synthetic events (units, idempotency, position lifecycle, OI, CrossVenueFunding).
// Metadata = the testnet snapshot (PERPL_TEST: MON = perp 64, price_decimals 5, size_decimals 0, interval 2580 s).
import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { A, CHAIN, WAD, blk } from "./helpers.js";
import { TEST_PERPL_EXCHANGE } from "../scripts/gen-config.mjs";
import { PERPL_TEST } from "../src/perpl.gen.js";
import { perplAprWad, realizedAprWad, scaledToWad, SECONDS_PER_YEAR } from "../src/lib/math.js";
import { hourStart } from "../src/lib/crossVenue.js";

const X = TEST_PERPL_EXCHANGE as `0x${string}`;
const MON = BigInt(PERPL_TEST.monPerpId);
const BTC = 16n;
let li = 0;
const ev = (event: string, block: number, params: Record<string, unknown>) => ({
  contract: "PerplExchange" as const,
  event: event as never,
  srcAddress: X,
  block: blk(block),
  logIndex: li++,
  transaction: { hash: `0x${block.toString(16).padStart(64, "0")}` as `0x${string}` },
  params: params as never,
});
const fundingEv = (block: number, perpId: bigint, rate: bigint, feb: bigint, payment = 0n, sum = 0n) =>
  ev("FundingEventCompleted", block, { perpId, fundingEventBlock: feb, specifiedRatePct100k: rate, actualRatePct100k: rate, fundingPricePNS: 2_877n, fundingPaymentPNS: payment, fundingSumPNS: sum, allowOverwrite: false });
const opened = (block: number, perpId: bigint, acc: bigint, type: bigint, lots: bigint, price: bigint) =>
  ev("PositionOpenedV2", block, { perpId, accountId: acc, positionType: type, leverageHdths: 300n, depositCNS: 6_000_000n, pnlCollateralizedCNS: 0n, pricePNS: price, lotLNS: lots, insFeeCNS: 100n, protFeeCNS: 500n, priceResiduePNSQ16: 0n });
const increased = (block: number, perpId: bigint, acc: bigint, type: bigint, from: bigint, to: bigint, price: bigint) =>
  ev("PositionIncreasedV2", block, { perpId, accountId: acc, positionType: type, leverageHdths: 300n, startDepositCNS: 6_000_000n, endDepositCNS: 9_000_000n, pnlCollateralizedCNS: 0n, premiumPnlSettledCNS: 0n, maxNegPnlCollatBPS: 1_000n, pricePNS: price, startLotLNS: from, endLotLNS: to, insFeeCNS: 10n, protFeeCNS: 20n, priceResiduePNSQ16: 0n });
const decreased = (block: number, perpId: bigint, acc: bigint, type: bigint, from: bigint, to: bigint, pnl: bigint, funding: bigint) =>
  ev("PositionDecreased", block, { perpId, accountId: acc, positionType: type, startDepositCNS: 9_000_000n, endDepositCNS: 4_000_000n, startLotLNS: from, endLotLNS: to, deltaPnlCNS: pnl, fundingCNS: funding });

describe("Perpl funding → PerplFunding + PerplMarket (units verified on-chain: rate·1e5 per interval)", () => {
  it("APR = rate·1e13·YEAR/interval; a re-emitted interval overwrites, never double counts", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { [CHAIN]: { simulate: [fundingEv(100, MON, -4n, 178n, -115n, -22_301n), fundingEv(150, MON, -3n, 178n, -86n, -22_272n), fundingEv(200, MON, 2n, 8_749n)] } } });
    const f = await indexer.PerplFunding.getOrThrow(`${MON}-178`);
    expect(f).toMatchObject({ ratePct100k: -3n, paymentPNS: -86n, sumPNS: -22_272n, overwrites: 1, fundingPriceWad: 2_877n * 10n ** 13n });
    expect(f.aprWad).toBe((-3n * 10n ** 13n * SECONDS_PER_YEAR) / 2_580n);
    // −4 per 100k per 43 min ≈ −48.9 % APR (docs/MFI.md §2: ±40 micros ≈ ±48.9 %)
    expect(Number(perplAprWad(-4n, 2580)!) / 1e18).toBeCloseTo(-0.48893, 4);
    const m = await indexer.PerplMarket.getOrThrow(String(MON));
    expect(m).toMatchObject({ isMon: true, known: true, name: "MON Perp", fundingEvents: 2, lastFundingEventBlock: 8_749n, lastRatePct100k: 2n });
  });

  it("an unknown perp (not in the snapshot) keeps raw values and no WAD conversions", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { [CHAIN]: { simulate: [fundingEv(10, 304n, 1n, 50n), ev("MarkUpdated", 11, { perpId: 304n, pricePNS: 302_502n })] } } });
    const m = await indexer.PerplMarket.getOrThrow("304");
    expect(m).toMatchObject({ known: false, isMon: false, lastMarkPNS: 302_502n, lastMarkWad: undefined, lastAprWad: undefined });
    expect((await indexer.PerplFunding.getOrThrow("304-50")).aprWad).toBeUndefined();
  });

  it("MarkUpdated → mark in WAD (price_decimals 5)", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { [CHAIN]: { simulate: [ev("MarkUpdated", 9, { perpId: MON, pricePNS: 2_873n })] } } });
    expect(await indexer.PerplMarket.getOrThrow(String(MON))).toMatchObject({ lastMarkPNS: 2_873n, lastMarkWad: 2_873n * 10n ** 13n, lastMarkBlock: 9n });
  });
});

describe("Perpl positions: open → increase → decrease → invert → liquidate → reopen → close", () => {
  it("tracks lots, side, weighted entry, collateral, pnl/funding/fees and open interest", async () => {
    const indexer = createTestIndexer();
    const acc = 806n;
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ev("AccountCreated", 1, { account: "0xD4e2a4dd0D933a3AdF7fC95890e9B67a6C9480Ea", id: acc }),
            ev("CollateralDeposit", 2, { accountId: acc, amountCNS: 10_000_000n, balanceCNS: 10_000_000n }),
            opened(3, MON, acc, 1n, 600n, 2_877n), // short 600 @ 0.02877
            increased(4, MON, acc, 1n, 600n, 1_000n, 2_900n),
          ],
        },
      },
    });
    let p = await indexer.PerplPosition.getOrThrow(`${MON}-${acc}`);
    // IncreasedV2.pricePNS is the position's entry after the increase (the exchange's average), taken as is
    expect(p).toMatchObject({ side: "Short", open: true, lots: 1_000n, entryPricePNS: 2_900n, entryPriceExact: true, depositCNS: 9_000_000n, feesCNS: 630n, address: "0xD4e2a4dd0D933a3AdF7fC95890e9B67a6C9480Ea" });
    expect(p.sizeWad).toBe(1_000n * WAD); // size_decimals 0
    expect(p.depositWad).toBe(9n * WAD); // AUSD 6 dp
    expect(await indexer.PerplMarket.getOrThrow(String(MON))).toMatchObject({ openInterestShortLots: 1_000n, openInterestLongLots: 0n, openPositions: 1 });

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            decreased(5, MON, acc, 1n, 1_000n, 400n, 1_500n, -20n),
            // inversion: positionType = the NEW side, startLot = old short lots, endLot = new long lots at the fill price
            ev("PositionInverted", 6, { perpId: MON, accountId: acc, positionType: 0n, leverageHdths: 300n, startDepositCNS: 4_000_000n, endDepositCNS: 3_000_000n, pnlCollateralizedCNS: 0n, pricePNS: 2_861n, startLotLNS: 400n, endLotLNS: 250n, deltaPnlCNS: 42n, fundingCNS: -1n, insFeeCNS: 1n, protFeeCNS: 2n }),
          ],
        },
      },
    });
    p = await indexer.PerplPosition.getOrThrow(`${MON}-${acc}`);
    expect(p).toMatchObject({ side: "Long", lots: 250n, entryPricePNS: 2_861n, realizedPnlCNS: 1_542n, fundingCNS: -21n, depositCNS: 3_000_000n });
    expect(await indexer.PerplMarket.getOrThrow(String(MON))).toMatchObject({ openInterestShortLots: 0n, openInterestLongLots: 250n, openPositions: 1 });

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ev("PositionLiquidated", 7, { perpId: MON, posAccountId: acc, positionType: 0n, markPricePNS: 2_500n, liqPricePNS: 2_510n, liqLotLNS: 250n, posLotLNS: 0n, deltaPnlCNS: -900_000n, fundingCNS: -5n, posAmountCNS: -1n, posDepositCNS: 0n, accAmountCNS: 0n, accBalanceCNS: 1n, onOrderBook: true }),
            opened(8, MON, acc, 0n, 10n, 2_600n),
            ev("PositionClosed", 9, { perpId: MON, accountId: acc, positionType: 0n, pricePNS: 2_650n, deltaPnlCNS: 500n, fundingCNS: 0n }),
          ],
        },
      },
    });
    p = await indexer.PerplPosition.getOrThrow(`${MON}-${acc}`);
    expect(p).toMatchObject({ open: false, lots: 0n, entryPricePNS: 0n, liquidations: 1, openedBlock: 8n });
    const m = await indexer.PerplMarket.getOrThrow(String(MON));
    expect(m).toMatchObject({ openInterestShortLots: 0n, openInterestLongLots: 0n, openPositions: 0, liquidations: 1 });
    const [liq] = await indexer.PerplLiquidation.getAll();
    expect(liq).toMatchObject({ side: "Long", liqLots: 250n, remainingLots: 0n, markPriceWad: scaledToWad(2_500n, 5), address: "0xD4e2a4dd0D933a3AdF7fC95890e9B67a6C9480Ea" });
    expect(await indexer.PerplAccount.getOrThrow(String(acc))).toMatchObject({ depositedCNS: 10_000_000n, balanceCNS: 10_000_000n, createdBlock: 1n });
  });

  it("a position opened before the window: lots from the event; entry unknown after a decrease, exact after an increase", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { [CHAIN]: { simulate: [decreased(3, BTC, 1n, 1n, 2_100_000n, 2_091_575n, 0n, 0n)] } } });
    expect(await indexer.PerplPosition.getOrThrow(`${BTC}-1`)).toMatchObject({ lots: 2_091_575n, entryPricePNS: 0n, entryPriceExact: false });
    await indexer.process({ chains: { [CHAIN]: { simulate: [increased(4, BTC, 1n, 1n, 2_091_575n, 2_092_442n, 857_265n), ev("CollateralWithdrawal", 5, { accountId: 1n, amountCNS: 7n, balanceCNS: 3n })] } } });
    const p = await indexer.PerplPosition.getOrThrow(`${BTC}-1`);
    expect(p).toMatchObject({ lots: 2_092_442n, side: "Short", entryPricePNS: 857_265n, entryPriceExact: true, address: undefined });
    expect(p.sizeWad).toBe(2_092_442n * 10n ** 13n); // BTC size_decimals 5
    expect((await indexer.PerplMarket.getOrThrow(String(BTC))).openInterestShortLots).toBe(2_092_442n);
    expect(await indexer.PerplAccount.getOrThrow("1")).toMatchObject({ withdrawnCNS: 7n, balanceCNS: 3n, address: undefined });
  });
});

describe("CrossVenueFunding: Meridian realized 1 h vs Perpl MON per UTC hour", () => {
  it("each venue fills its side of the hour; the other side carries over; spread = meridian − perpl", async () => {
    const indexer = createTestIndexer();
    const checkpoint = { contract: "ClearingHouse" as const, event: "FundingCheckpoint" as const, srcAddress: A.CH, block: blk(1_000), params: { slot: 0n, blockNumber: 1_000n, cumFunding: 0n, cumIndexTime: 0n } };
    const tick = (block: number, f: bigint, g: bigint) => ({ contract: "ClearingHouse" as const, event: "FundingUpdated" as const, srcAddress: A.CH, block: blk(block), params: { blockNumber: BigInt(block), premium: 0n, emaPremium: 0n, rate: 0n, cumFunding: f, cumIndexTime: g, indexPriceWad: WAD, markPriceWad: WAD } });
    // Perpl MON funding first (no Meridian tick yet), then Meridian ticks 1 h of history later
    await indexer.process({ chains: { [CHAIN]: { simulate: [checkpoint, fundingEv(1_100, MON, -4n, 1_178n), tick(13_000, 10n ** 12n, 10n ** 21n)] } } });
    const hPerpl = hourStart(BigInt(blk(1_100).timestamp));
    const hMer = hourStart(BigInt(blk(13_000).timestamp));
    expect(hMer).toBeGreaterThan(hPerpl);
    const perplApr = perplAprWad(-4n, 2580)!;
    const merApr = realizedAprWad(0n, 0n, 10n ** 12n, 10n ** 21n)!;
    expect(await indexer.CrossVenueFunding.getOrThrow(String(hPerpl))).toMatchObject({ perplAprWad: perplApr, meridianAprWad: undefined, spreadAprWad: undefined, perplPerpId: MON });
    const row = await indexer.CrossVenueFunding.getOrThrow(String(hMer));
    expect(row).toMatchObject({ meridianMarket: A.CH, meridianAprWad: merApr, perplAprWad: perplApr, perplFundingEventBlock: 1_178n, spreadAprWad: merApr - perplApr });
  });

  it("non-MON Perpl markets never touch CrossVenueFunding", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { [CHAIN]: { simulate: [fundingEv(5, BTC, 3n, 80n)] } } });
    expect(await indexer.CrossVenueFunding.getAll()).toEqual([]);
  });
});

describe("Perpl math (pure, rounding neutral)", () => {
  it("perplAprWad truncates toward zero symmetrically; unknown interval → undefined", () => {
    expect(perplAprWad(7n, 2580)).toBe(-perplAprWad(-7n, 2580)!);
    expect(perplAprWad(1n, undefined)).toBeUndefined();
    expect(perplAprWad(1n, 0)).toBeUndefined();
  });
  it("scaledToWad is exact; refuses decimals > 18", () => {
    expect(scaledToWad(123n, 0)).toBe(123n * WAD);
    expect(scaledToWad(123n, 18)).toBe(123n);
    expect(scaledToWad(1n, 19)).toBeUndefined();
  });
});
