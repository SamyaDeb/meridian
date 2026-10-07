// IClearingHouse + IFundingRateOracle events (perp market; one ClearingHouse per market).
import { indexer, type Market } from "envio";
import { recordMeridianHour } from "../lib/crossVenue.js";
import { recordPenaltyIn } from "../lib/insurance.js";
import {
  FIELDS,
  type Ctx,
  evId,
  blockOf,
  tsOf,
  getMarket,
  getAccountMarket,
  touchAccount,
  updateProtocol,
  isTestClearingHouse,
  logAdmin,
  toJson,
  getInsuranceFund,
  insuranceFundAddress,
} from "../lib/common.js";
import {
  applyPerpFill,
  checkpointBucket,
  CHECKPOINT_SLOTS,
  entryPriceWad,
  oiDelta,
  rateToAprWad,
  realizedAprWad,
  windowBlocks,
  WAD,
} from "../lib/math.js";

/** Realized-APR windows in seconds (blocks = seconds·1000/blockTimeMs: 12,000 / 96,000 / 288,000 / 2,016,000 at 300 ms). */
export const WINDOWS = { h1: 3_600n, h8: 28_800n, h24: 86_400n, d7: 604_800n } as const;
type Obs = { readonly blockNumber: bigint; readonly cumFunding: bigint; readonly cumIndexTime: bigint };

/**
 * Checkpoint at or before `target`, exactly IFundingRateOracle.observe over the mirrored ring (FundingRingSlot):
 * the newest slot if it is old enough, else the bucket-arithmetic shortcut, else a binary search between the oldest
 * and the newest slot (≤ 11 reads for 1440 slots). Undefined where the contract reverts ObservationTooOld.
 */
async function checkpointAtOrBefore(context: Ctx, market: Market, target: bigint): Promise<Obs | undefined> {
  if (target < 0n || market.checkpointSlot === undefined) return undefined;
  const N = CHECKPOINT_SLOTS;
  const at = (slot: number) => context.FundingRingSlot.get(`${market.id}-${((slot % N) + N) % N}`);
  const idx = market.checkpointSlot;
  const newest = await at(idx);
  if (!newest) return undefined;
  if (newest.blockNumber <= target) return newest;
  const back = Number(checkpointBucket(newest.blockNumber) - checkpointBucket(target));
  if (back !== 0 && back < N) {
    const g = await at(idx - back);
    if (g && g.blockNumber !== 0n && g.blockNumber <= target) {
      const next = await at(idx - back + 1);
      if ((next?.blockNumber ?? 0n) > target) return g;
    }
  }
  const wrapped = Boolean(await at(idx + 1));
  const oldest = wrapped ? (idx + 1) % N : 0;
  const count = wrapped ? N : idx + 1;
  const first = await at(oldest);
  if (!first || first.blockNumber > target) return undefined;
  // invariant: ring[lo].block ≤ target < ring[hi].block (hi = newest, checked above)
  let lo = 0;
  let hi = count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const m = await at(oldest + mid);
    if (m && m.blockNumber <= target) lo = mid;
    else hi = mid;
  }
  return at(oldest + lo);
}

type Window = { apr: bigint | undefined; from: bigint | undefined };

/** Realized APR over each window ending at (block, F, G), MATH_SPEC §1.8, plus the checkpoint block it starts from. */
async function realizedWindows(context: Ctx, market: Market, block: bigint, f: bigint, g: bigint) {
  const at = async (seconds: bigint): Promise<Window> => {
    const cp = await checkpointAtOrBefore(context, market, block - windowBlocks(seconds, market.blockTimeMs));
    return cp ? { apr: realizedAprWad(cp.cumFunding, cp.cumIndexTime, f, g), from: cp.blockNumber } : { apr: undefined, from: undefined };
  };
  return { h1: await at(WINDOWS.h1), h8: await at(WINDOWS.h8), h24: await at(WINDOWS.h24), d7: await at(WINDOWS.d7) };
}

type Windows = Awaited<ReturnType<typeof realizedWindows>>;
const windowAprs = (w: Windows) => ({
  realizedApr1hWad: w.h1.apr,
  realizedApr8hWad: w.h8.apr,
  realizedApr24hWad: w.h24.apr,
}); // FundingCheckpoint keeps the 1 h / 8 h / 24 h columns it always had

indexer.onEvent({ contract: "ClearingHouse", event: "FundingUpdated", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const market = await getMarket(context, event.srcAddress);
  const block = p.blockNumber; // == block.number (first touch in this block)
  const rateAprWad = rateToAprWad(p.rate);
  context.FundingTick.set({
    id: `${market.id}-${block}`,
    market_id: market.id,
    block,
    timestamp: tsOf(event),
    rate: p.rate,
    rateAprWad,
    premium: p.premium,
    emaPremium: p.emaPremium,
    cumFunding: p.cumFunding,
    cumIndexTime: p.cumIndexTime,
    index: p.indexPriceWad,
    mark: p.markPriceWad,
  });
  const w = await realizedWindows(context, market, block, p.cumFunding, p.cumIndexTime);
  context.Market.set({
    ...market,
    ...windowAprs(w),
    realizedApr7dWad: w.d7.apr,
    lastFundingBlock: block,
    lastRate: p.rate,
    lastRateAprWad: rateAprWad,
    lastPremium: p.premium,
    lastEmaPremium: p.emaPremium,
    lastCumFunding: p.cumFunding,
    lastCumIndexTime: p.cumIndexTime,
    lastIndexPrice: p.indexPriceWad,
    lastMarkPrice: p.markPriceWad,
    fundingTickCount: market.fundingTickCount + 1,
  });
  context.FundingWindow.set({
    id: market.id,
    market: market.id,
    block,
    timestamp: tsOf(event),
    blockTimeMs: market.blockTimeMs,
    apr1hWad: w.h1.apr,
    apr8hWad: w.h8.apr,
    apr24hWad: w.h24.apr,
    apr7dWad: w.d7.apr,
    fromBlock1h: w.h1.from,
    fromBlock8h: w.h8.from,
    fromBlock24h: w.h24.from,
    fromBlock7d: w.d7.from,
    rateAprWad,
  });
  if (!market.testMarket) await recordMeridianHour(context, market.id, tsOf(event), block, w.h1.apr);
  await updateProtocol(context, (s) => ({ fundingTicks: s.fundingTicks + 1 }), { block, ts: tsOf(event), testMarket: market.testMarket });
});

indexer.onEvent({ contract: "ClearingHouse", event: "FundingCheckpoint", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const market = await getMarket(context, event.srcAddress);
  const blockNumber = p.blockNumber;
  const windows = windowAprs(await realizedWindows(context, market, blockNumber, p.cumFunding, p.cumIndexTime));
  const slot = Number(p.slot);
  context.FundingRingSlot.set({ id: `${market.id}-${slot}`, market: market.id, slot, blockNumber, cumFunding: p.cumFunding, cumIndexTime: p.cumIndexTime });
  context.Market.set({ ...market, checkpointSlot: slot });
  context.FundingCheckpoint.set({
    id: `${market.id}-${checkpointBucket(blockNumber)}`,
    market_id: market.id,
    slot: Number(p.slot),
    bucket: checkpointBucket(blockNumber),
    blockNumber,
    timestamp: tsOf(event),
    cumFunding: p.cumFunding,
    cumIndexTime: p.cumIndexTime,
    ...windows,
  });
});

indexer.onEvent({ contract: "ClearingHouse", event: "Deposited", fields: FIELDS }, async ({ event, context }) => {
  const { account, amountToken, amountWad } = event.params;
  const block = blockOf(event);
  const m = await getMarket(context, event.srcAddress);
  context.Market.set(m);
  const stat = { block, ts: tsOf(event), testMarket: m.testMarket };
  await touchAccount(context, account, block, tsOf(event), stat);
  const am = await getAccountMarket(context, event.srcAddress, account, block);
  context.AccountMarket.set({
    ...am,
    collateralWad: am.collateralWad + amountWad,
    depositedToken: am.depositedToken + amountToken,
    updatedBlock: block,
  });
  await updateProtocol(context, (s) => ({ perpCollateralToken: s.perpCollateralToken + amountToken }), stat);
});

indexer.onEvent({ contract: "ClearingHouse", event: "Withdrawn", fields: FIELDS }, async ({ event, context }) => {
  const { account, amountToken, amountWad } = event.params;
  const block = blockOf(event);
  const am = await getAccountMarket(context, event.srcAddress, account, block);
  context.AccountMarket.set({
    ...am,
    collateralWad: am.collateralWad - amountWad,
    withdrawnToken: am.withdrawnToken + amountToken,
    updatedBlock: block,
  });
  await updateProtocol(context, (s) => ({ perpCollateralToken: s.perpCollateralToken - amountToken }), {
    block,
    ts: tsOf(event),
    testMarket: await isTestClearingHouse(context, event.srcAddress),
  });
});

indexer.onEvent({ contract: "ClearingHouse", event: "FundingSettled", fields: FIELDS }, async ({ event, context }) => {
  const { account, payment, cumFunding } = event.params;
  const block = blockOf(event);
  const am = await getAccountMarket(context, event.srcAddress, account, block);
  context.AccountMarket.set({
    ...am,
    collateralWad: am.collateralWad - payment, // payment > 0 ⇒ the account paid (INTERFACES §2.8)
    fundingPaid: am.fundingPaid + payment,
    lastCumFunding: cumFunding,
    updatedBlock: block,
  });
  context.FundingPayment.set({
    id: evId(event),
    market: event.srcAddress,
    account,
    payment,
    cumFunding,
    block,
    timestamp: tsOf(event),
    txHash: event.transaction.hash,
  });
});

indexer.onEvent({ contract: "ClearingHouse", event: "PositionChanged", fields: FIELDS }, async ({ event, context }) => {
  const { account, sizeDelta, newSize, priceWad, realizedPnl, fee } = event.params;
  const block = blockOf(event);
  const testMarket = await isTestClearingHouse(context, event.srcAddress);
  const acc = await touchAccount(context, account, block, tsOf(event), { block, testMarket });
  const am = await getAccountMarket(context, event.srcAddress, account, block);
  const oldSize = newSize - sizeDelta;
  // MATH_SPEC §3.1 mirror; if the mirror drifted from the contract (e.g. indexing started mid-life), re-anchor at P.
  let { q, on } = applyPerpFill(am.size, am.openNotional, sizeDelta, priceWad);
  if (q !== newSize) {
    q = newSize;
    on = (newSize * priceWad) / WAD;
  }
  context.AccountMarket.set({
    ...am,
    size: q,
    openNotional: on,
    entryPrice: entryPriceWad(q, on),
    realizedPnl: am.realizedPnl + realizedPnl,
    feesPaid: am.feesPaid + fee,
    collateralWad: am.collateralWad + realizedPnl - fee,
    lastTradeBlock: block,
    updatedBlock: block,
  });
  context.Account.set({ ...acc, tradeCount: acc.tradeCount + 1 });
  const market = await getMarket(context, event.srcAddress);
  const d = oiDelta(oldSize, newSize);
  context.Market.set({
    ...market,
    feesWad: market.feesWad + fee,
    openInterestLongWad: market.openInterestLongWad + d.long,
    openInterestShortWad: market.openInterestShortWad + d.short,
  });
  await updateProtocol(
    context,
    (s) => ({
      feesWad: s.feesWad + fee,
      perpOpenInterestLongWad: s.perpOpenInterestLongWad + d.long,
      perpOpenInterestShortWad: s.perpOpenInterestShortWad + d.short,
    }),
    { block, ts: tsOf(event), testMarket },
  );
});

indexer.onEvent({ contract: "ClearingHouse", event: "Liquidated", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const block = blockOf(event);
  context.Liquidation.set({
    id: evId(event),
    kind: "Perp",
    market: event.srcAddress,
    account: p.account,
    liquidator: p.liquidator,
    sizeTransferred: p.sizeTransferred,
    markPriceWad: p.markPriceWad,
    markAprWad: undefined,
    penalty: p.penalty,
    keeperReward: p.keeperReward,
    toInsurance: p.toInsurance,
    badDebt: p.badDebt,
    block,
    timestamp: tsOf(event),
    txHash: event.transaction.hash,
  });
  const am = await getAccountMarket(context, event.srcAddress, p.account, block);
  const after = am.collateralWad - p.penalty;
  context.AccountMarket.set({
    ...am,
    // Bad debt means collateral was exhausted (AccountView.collateral is unsigned).
    collateralWad: p.badDebt > 0n || after < 0n ? 0n : after,
    liquidationCount: am.liquidationCount + 1,
    updatedBlock: block,
  });
  // Waterfall: the IF share of the penalty arrives by plain transfer (no IF event), AUSD rounded down (_payInsurance)
  await recordPenaltyIn(context, event, "Perp", p.account, p.toInsurance);
  await updateProtocol(context, (s) => ({ liquidations: s.liquidations + 1 }), {
    block,
    ts: tsOf(event),
    testMarket: await isTestClearingHouse(context, event.srcAddress),
  });
});

// Emitted only when the IF fell short: the IF part already arrived as InsuranceFund.BadDebtCovered (earlier log in the
// same tx); here the rest splits into accrued fees and the uncovered remainder (MATH_SPEC §3.3).
indexer.onEvent({ contract: "ClearingHouse", event: "BadDebtSocialized", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const feeCoveredWad = p.requested - p.coveredByInsurance - p.uncovered; // MATH_SPEC §3.3, exact
  context.BadDebtEvent.set({
    id: evId(event),
    source: event.srcAddress,
    requested: p.requested,
    covered: p.coveredByInsurance,
    uncovered: p.uncovered,
    feeCoveredWad,
    block: blockOf(event),
    timestamp: tsOf(event),
  });
  const fund = insuranceFundAddress(context);
  if (!fund) return;
  const f = await getInsuranceFund(context, fund);
  const step = (n: number, flow: "CoveredByFees" | "Uncovered", amountWad: bigint) =>
    context.InsuranceFundEvent.set({
      id: `${evId(event)}-${n}`,
      fund,
      flow,
      direction: "None",
      kind: "Perp",
      market: event.srcAddress,
      account: undefined, // BadDebtSocialized has no account; the Liquidated log of the same tx does
      from: undefined,
      amountWad,
      amountToken: undefined,
      requestedWad: p.requested,
      balanceAfterToken: f.balanceToken,
      block: blockOf(event),
      timestamp: tsOf(event),
      txHash: event.transaction.hash,
    });
  if (feeCoveredWad > 0n) step(0, "CoveredByFees", feeCoveredWad);
  if (p.uncovered > 0n) step(1, "Uncovered", p.uncovered);
});

indexer.onEvent({ contract: "ClearingHouse", event: "OrderMarginChanged", fields: FIELDS }, async ({ event, context }) => {
  const block = blockOf(event);
  const am = await getAccountMarket(context, event.srcAddress, event.params.account, block);
  context.AccountMarket.set({ ...am, reservedOrderMargin: event.params.reservedOrderMargin, updatedBlock: block });
});

indexer.onEvent({ contract: "ClearingHouse", event: "FeesCollected", fields: FIELDS }, async ({ event, context }) => {
  const market = await getMarket(context, event.srcAddress);
  context.Market.set({ ...market, feesCollectedToken: market.feesCollectedToken + event.params.amountToken });
  await logAdmin(context, event, "FeesCollected", event.params);
});

indexer.onEvent({ contract: "ClearingHouse", event: "RiskParamsUpdated", fields: FIELDS }, async ({ event, context }) => {
  const market = await getMarket(context, event.srcAddress);
  context.Market.set({ ...market, riskParams: toJson(event.params.params) });
  await logAdmin(context, event, "RiskParamsUpdated", event.params.params);
});

indexer.onEvent({ contract: "ClearingHouse", event: "FundingParamsUpdated", fields: FIELDS }, async ({ event, context }) => {
  const market = await getMarket(context, event.srcAddress);
  const fp = event.params.params;
  context.Market.set({
    ...market,
    fundingParams: toJson(fp),
    blockTimeMs: fp.blockTimeMs > 0n ? fp.blockTimeMs : market.blockTimeMs,
  });
  await logAdmin(context, event, "FundingParamsUpdated", fp);
});

indexer.onEvent({ contract: "ClearingHouse", event: "PausedSet", fields: FIELDS }, async ({ event, context }) => {
  const market = await getMarket(context, event.srcAddress);
  context.Market.set({ ...market, paused: event.params.paused });
  await logAdmin(context, event, "PausedSet", event.params);
});
