// IClearingHouse + IFundingRateOracle events (perp market; one ClearingHouse per market).
import { indexer, type FundingCheckpoint, type Market } from "envio";
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
  logAdmin,
  toJson,
} from "../lib/common.js";
import {
  applyPerpFill,
  checkpointBucket,
  entryPriceWad,
  oiDelta,
  rateToAprWad,
  realizedAprWad,
  windowBlocks,
  WAD,
} from "../lib/math.js";

const WINDOWS = { h1: 3_600n, h8: 28_800n, h24: 86_400n } as const;
/** Buckets to walk back when the target bucket has no checkpoint (bounded; the keeper pokes every ≤ 20 blocks). */
const MAX_BUCKET_WALK = 3n;

/** Checkpoint at or before `target` (IFundingRateOracle.observe semantics), bounded lookup. */
async function checkpointAtOrBefore(context: Ctx, market: string, target: bigint): Promise<FundingCheckpoint | undefined> {
  if (target < 0n) return undefined;
  const bucket = checkpointBucket(target);
  for (let k = 0n; k <= MAX_BUCKET_WALK && bucket - k >= 0n; k++) {
    const cp = await context.FundingCheckpoint.get(`${market}-${bucket - k}`);
    if (cp && cp.blockNumber <= target) return cp;
  }
  return undefined;
}

/** Realized APR over 1 h / 8 h / 24 h ending at (block, F, G), MATH_SPEC §1.8. */
async function realizedWindows(
  context: Ctx,
  market: Market,
  block: bigint,
  f: bigint,
  g: bigint,
): Promise<{ realizedApr1hWad: bigint | undefined; realizedApr8hWad: bigint | undefined; realizedApr24hWad: bigint | undefined }> {
  const at = async (seconds: bigint) => {
    const cp = await checkpointAtOrBefore(context, market.id, block - windowBlocks(seconds, market.blockTimeMs));
    return cp ? realizedAprWad(cp.cumFunding, cp.cumIndexTime, f, g) : undefined;
  };
  return {
    realizedApr1hWad: await at(WINDOWS.h1),
    realizedApr8hWad: await at(WINDOWS.h8),
    realizedApr24hWad: await at(WINDOWS.h24),
  };
}

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
  const windows = await realizedWindows(context, market, block, p.cumFunding, p.cumIndexTime);
  context.Market.set({
    ...market,
    ...windows,
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
  await updateProtocol(context, (s) => ({ fundingTicks: s.fundingTicks + 1 }));
});

indexer.onEvent({ contract: "ClearingHouse", event: "FundingCheckpoint", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const market = await getMarket(context, event.srcAddress);
  const blockNumber = p.blockNumber;
  const windows = await realizedWindows(context, market, blockNumber, p.cumFunding, p.cumIndexTime);
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
  await getMarket(context, event.srcAddress).then((m) => context.Market.set(m));
  await touchAccount(context, account, block, tsOf(event));
  const am = await getAccountMarket(context, event.srcAddress, account, block);
  context.AccountMarket.set({
    ...am,
    collateralWad: am.collateralWad + amountWad,
    depositedToken: am.depositedToken + amountToken,
    updatedBlock: block,
  });
  await updateProtocol(context, (s) => ({ perpCollateralToken: s.perpCollateralToken + amountToken }));
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
  await updateProtocol(context, (s) => ({ perpCollateralToken: s.perpCollateralToken - amountToken }));
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
});

indexer.onEvent({ contract: "ClearingHouse", event: "PositionChanged", fields: FIELDS }, async ({ event, context }) => {
  const { account, sizeDelta, newSize, priceWad, realizedPnl, fee } = event.params;
  const block = blockOf(event);
  const acc = await touchAccount(context, account, block, tsOf(event));
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
  await updateProtocol(context, (s) => ({ feesWad: s.feesWad + fee }));
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
  await updateProtocol(context, (s) => ({ liquidations: s.liquidations + 1 }));
});

indexer.onEvent({ contract: "ClearingHouse", event: "BadDebtSocialized", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  context.BadDebtEvent.set({
    id: evId(event),
    source: event.srcAddress,
    requested: p.requested,
    covered: p.coveredByInsurance,
    uncovered: p.uncovered,
    block: blockOf(event),
    timestamp: tsOf(event),
  });
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
