// Perpl Exchange events (K2.2): funding per interval, mark, accounts, positions and liquidations of another Monad perp,
// so the app can compare venues from one endpoint. Only events verified on the deployed contract (PERPL_EVENTS.md).
// Lots continuity (startLotLNS = previous endLotLNS) and PositionInverted carrying the NEW side were checked on every
// position event of the recorded windows, and the resulting positions against the contract's getPosition. The
// pricePNS of Opened / IncreasedV2 / Inverted is the position's entry AFTER the event (the contract's own average, not
// the fill price): the last one equals getPosition().pricePNS exactly, so the entry is never recomputed here.
import { indexer, type PerplMarket, type PerplPosition } from "envio";
import { FIELDS, type Ctx, evId, blockOf, tsOf } from "../lib/common.js";
import { recordPerplHour } from "../lib/crossVenue.js";
import { perplAprWad, scaledToWad } from "../lib/math.js";
import { perplChain, perplMeta, perplSide } from "../lib/perpl.js";

async function getPerplMarket(context: Ctx, perpId: bigint, block: bigint): Promise<PerplMarket> {
  const meta = perplMeta(context.chain.id, perpId);
  return context.PerplMarket.getOrCreate({
    id: String(perpId),
    perpId,
    name: meta?.name,
    symbol: meta?.symbol,
    known: meta !== undefined,
    isMon: perplChain(context.chain.id)?.monPerpId === Number(perpId),
    priceDecimals: meta?.priceDecimals,
    sizeDecimals: meta?.sizeDecimals,
    fundingIntervalSec: meta?.fundingIntervalSec,
    lastMarkPNS: undefined,
    lastMarkWad: undefined,
    lastMarkBlock: undefined,
    lastFundingEventBlock: undefined,
    lastRatePct100k: undefined,
    lastAprWad: undefined,
    fundingEvents: 0,
    openInterestLongLots: 0n,
    openInterestShortLots: 0n,
    openInterestLongWad: meta ? 0n : undefined,
    openInterestShortWad: meta ? 0n : undefined,
    openPositions: 0,
    liquidations: 0,
    updatedBlock: block,
  });
}

const collateralToWad = (context: Ctx, cns: bigint) => scaledToWad(cns, perplChain(context.chain.id)?.collateralDecimals) ?? 0n;

indexer.onEvent({ contract: "PerplExchange", event: "FundingEventCompleted", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const block = blockOf(event);
  const m = await getPerplMarket(context, p.perpId, block);
  const id = `${p.perpId}-${p.fundingEventBlock}`;
  const prev = await context.PerplFunding.get(id);
  const aprWad = perplAprWad(p.actualRatePct100k, m.fundingIntervalSec);
  context.PerplFunding.set({
    id,
    perpId: p.perpId,
    fundingEventBlock: p.fundingEventBlock,
    ratePct100k: p.actualRatePct100k,
    specifiedRatePct100k: p.specifiedRatePct100k,
    aprWad,
    fundingPricePNS: p.fundingPricePNS,
    fundingPriceWad: scaledToWad(p.fundingPricePNS, m.priceDecimals),
    paymentPNS: p.fundingPaymentPNS,
    sumPNS: p.fundingSumPNS,
    overwrites: prev ? prev.overwrites + 1 : 0,
    block,
    timestamp: tsOf(event),
    txHash: event.transaction.hash,
  });
  const newer = m.lastFundingEventBlock === undefined || p.fundingEventBlock >= m.lastFundingEventBlock;
  context.PerplMarket.set({
    ...m,
    ...(newer ? { lastFundingEventBlock: p.fundingEventBlock, lastRatePct100k: p.actualRatePct100k, lastAprWad: aprWad } : {}),
    fundingEvents: m.fundingEvents + (prev ? 0 : 1),
    updatedBlock: block,
  });
  if (m.isMon && newer) await recordPerplHour(context, p.perpId, tsOf(event), block, aprWad, p.fundingEventBlock);
});

indexer.onEvent({ contract: "PerplExchange", event: "MarkUpdated", fields: FIELDS }, async ({ event, context }) => {
  const block = blockOf(event);
  const m = await getPerplMarket(context, event.params.perpId, block);
  context.PerplMarket.set({
    ...m,
    lastMarkPNS: event.params.pricePNS,
    lastMarkWad: scaledToWad(event.params.pricePNS, m.priceDecimals),
    lastMarkBlock: block,
    updatedBlock: block,
  });
});

// ─── accounts ──────────────────────────────────────────────────────────────────

async function getPerplAccount(context: Ctx, accountId: bigint, block: bigint) {
  return context.PerplAccount.getOrCreate({
    id: String(accountId),
    accountId,
    address: undefined,
    balanceCNS: undefined,
    depositedCNS: 0n,
    withdrawnCNS: 0n,
    createdBlock: undefined,
    updatedBlock: block,
  });
}

indexer.onEvent({ contract: "PerplExchange", event: "AccountCreated", fields: FIELDS }, async ({ event, context }) => {
  const block = blockOf(event);
  const a = await getPerplAccount(context, event.params.id, block);
  context.PerplAccount.set({ ...a, address: event.params.account, createdBlock: block, updatedBlock: block });
});

indexer.onEvent({ contract: "PerplExchange", event: "CollateralDeposit", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const block = blockOf(event);
  const a = await getPerplAccount(context, p.accountId, block);
  context.PerplAccount.set({ ...a, balanceCNS: p.balanceCNS, depositedCNS: a.depositedCNS + p.amountCNS, updatedBlock: block });
});

indexer.onEvent({ contract: "PerplExchange", event: "CollateralWithdrawal", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const block = blockOf(event);
  const a = await getPerplAccount(context, p.accountId, block);
  context.PerplAccount.set({ ...a, balanceCNS: p.balanceCNS, withdrawnCNS: a.withdrawnCNS + p.amountCNS, updatedBlock: block });
});

// ─── positions ─────────────────────────────────────────────────────────────────

/** What one position event says about the position after it (fields the event doesn't carry stay undefined). */
type Step = {
  side?: "Long" | "Short";
  lots: bigint;
  /** the position's entry after the event (Opened / IncreasedV2 / Inverted pricePNS); undefined = unchanged */
  entryPricePNS?: bigint;
  /** the event starts a new position (open or inversion) */
  fresh?: boolean;
  depositCNS?: bigint;
  leverageHdths?: bigint;
  deltaPnlCNS?: bigint;
  fundingCNS?: bigint;
  feesCNS?: bigint;
  liquidated?: boolean;
};

type PosEvent = {
  readonly srcAddress: string;
  readonly logIndex: number;
  readonly block: { readonly number: number; readonly timestamp: number };
  readonly transaction: { readonly hash: string };
};

/** Pure: the position row after `s` (prev = the row before, undefined if this position was never seen). */
export function applyPerplStep(prev: PerplPosition | undefined, s: Step, ids: { perpId: bigint; accountId: bigint }, block: bigint): PerplPosition {
  const side = s.side ?? prev?.side ?? "Long";
  // a position first seen through a decrease (opened before the window) has no known entry until its next increase
  let entry = prev?.open ? prev.entryPricePNS : 0n;
  let exact = prev?.open ? prev.entryPriceExact : false;
  if (s.entryPricePNS !== undefined) {
    entry = s.entryPricePNS;
    exact = true;
  }
  if (s.lots === 0n) entry = 0n;
  return {
    id: `${ids.perpId}-${ids.accountId}`,
    perpId: ids.perpId,
    accountId: ids.accountId,
    address: prev?.address,
    side,
    open: s.lots > 0n,
    lots: s.lots,
    sizeWad: undefined,
    entryPricePNS: entry,
    entryPriceWad: undefined,
    entryPriceExact: s.lots === 0n ? true : exact,
    depositCNS: s.depositCNS ?? prev?.depositCNS ?? 0n,
    depositWad: 0n,
    leverageHdths: s.leverageHdths ?? prev?.leverageHdths,
    realizedPnlCNS: (prev?.realizedPnlCNS ?? 0n) + (s.deltaPnlCNS ?? 0n),
    fundingCNS: (prev?.fundingCNS ?? 0n) + (s.fundingCNS ?? 0n),
    feesCNS: (prev?.feesCNS ?? 0n) + (s.feesCNS ?? 0n),
    liquidations: (prev?.liquidations ?? 0) + (s.liquidated ? 1 : 0),
    openedBlock: s.fresh || !prev || !prev.open ? block : prev.openedBlock,
    updatedBlock: block,
  };
}

/** Pure: (long, short) lots a position contributes to open interest. */
const oiOf = (p: PerplPosition | undefined): [bigint, bigint] => (!p?.open ? [0n, 0n] : p.side === "Long" ? [p.lots, 0n] : [0n, p.lots]);

async function onPosition(context: Ctx, event: PosEvent, perpId: bigint, accountId: bigint, s: Step) {
  const block = blockOf(event);
  const id = `${perpId}-${accountId}`;
  const prev = await context.PerplPosition.get(id);
  const m = await getPerplMarket(context, perpId, block);
  const acc = prev?.address ? undefined : await context.PerplAccount.get(String(accountId));
  const base = applyPerplStep(prev, s, { perpId, accountId }, block);
  const next: PerplPosition = {
    ...base,
    address: base.address ?? acc?.address,
    sizeWad: scaledToWad(base.lots, m.sizeDecimals),
    entryPriceWad: scaledToWad(base.entryPricePNS, m.priceDecimals),
    depositWad: collateralToWad(context, base.depositCNS),
  };
  context.PerplPosition.set(next);
  const [l0, s0] = oiOf(prev);
  const [l1, s1] = oiOf(next);
  const longLots = m.openInterestLongLots + l1 - l0;
  const shortLots = m.openInterestShortLots + s1 - s0;
  context.PerplMarket.set({
    ...m,
    openInterestLongLots: longLots,
    openInterestShortLots: shortLots,
    openInterestLongWad: scaledToWad(longLots, m.sizeDecimals),
    openInterestShortWad: scaledToWad(shortLots, m.sizeDecimals),
    openPositions: m.openPositions + (next.open ? 1 : 0) - (prev?.open ? 1 : 0),
    liquidations: m.liquidations + (s.liquidated ? 1 : 0),
    updatedBlock: block,
  });
  return next;
}

indexer.onEvent({ contract: "PerplExchange", event: "PositionOpenedV2", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  await onPosition(context, event, p.perpId, p.accountId, {
    side: perplSide(p.positionType),
    lots: p.lotLNS,
    entryPricePNS: p.pricePNS,
    fresh: true,
    depositCNS: p.depositCNS,
    leverageHdths: p.leverageHdths,
    feesCNS: p.insFeeCNS + p.protFeeCNS,
  });
});

indexer.onEvent({ contract: "PerplExchange", event: "PositionIncreasedV2", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  await onPosition(context, event, p.perpId, p.accountId, {
    side: perplSide(p.positionType),
    lots: p.endLotLNS,
    entryPricePNS: p.pricePNS,
    depositCNS: p.endDepositCNS,
    leverageHdths: p.leverageHdths,
    feesCNS: p.insFeeCNS + p.protFeeCNS,
  });
});

indexer.onEvent({ contract: "PerplExchange", event: "PositionDecreased", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  await onPosition(context, event, p.perpId, p.accountId, {
    side: perplSide(p.positionType),
    lots: p.endLotLNS,
    depositCNS: p.endDepositCNS,
    deltaPnlCNS: p.deltaPnlCNS,
    fundingCNS: p.fundingCNS,
  });
});

indexer.onEvent({ contract: "PerplExchange", event: "PositionClosed", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  await onPosition(context, event, p.perpId, p.accountId, {
    side: perplSide(p.positionType),
    lots: 0n,
    depositCNS: 0n,
    deltaPnlCNS: p.deltaPnlCNS,
    fundingCNS: p.fundingCNS,
  });
});

// positionType is the NEW side; startLotLNS = the old side's lots, endLotLNS = the new side's lots opened at pricePNS
indexer.onEvent({ contract: "PerplExchange", event: "PositionInverted", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  await onPosition(context, event, p.perpId, p.accountId, {
    side: perplSide(p.positionType),
    lots: p.endLotLNS,
    entryPricePNS: p.pricePNS,
    fresh: true,
    depositCNS: p.endDepositCNS,
    leverageHdths: p.leverageHdths,
    deltaPnlCNS: p.deltaPnlCNS,
    fundingCNS: p.fundingCNS,
    feesCNS: p.insFeeCNS + p.protFeeCNS,
  });
});

// Margin added to an open position (lots unchanged). A position not seen yet is skipped: its next lots-carrying event
// brings both lots and deposit (the recordings show deposit continuity across every event once this is applied).
indexer.onEvent({ contract: "PerplExchange", event: "IncreasePositionCollateral", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const prev = await context.PerplPosition.get(`${p.perpId}-${p.accountId}`);
  if (!prev?.open) return;
  await onPosition(context, event, p.perpId, p.accountId, { lots: prev.lots, depositCNS: p.positionDepositCNS });
  const a = await getPerplAccount(context, p.accountId, blockOf(event));
  context.PerplAccount.set({ ...a, balanceCNS: p.balanceCNS, updatedBlock: blockOf(event) });
});

indexer.onEvent({ contract: "PerplExchange", event: "PositionLiquidated", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const pos = await onPosition(context, event, p.perpId, p.posAccountId, {
    side: perplSide(p.positionType),
    lots: p.posLotLNS,
    depositCNS: p.posDepositCNS,
    deltaPnlCNS: p.deltaPnlCNS,
    fundingCNS: p.fundingCNS,
    liquidated: true,
  });
  const m = await getPerplMarket(context, p.perpId, blockOf(event));
  context.PerplLiquidation.set({
    id: evId(event),
    perpId: p.perpId,
    accountId: p.posAccountId,
    address: pos.address,
    side: perplSide(p.positionType),
    markPricePNS: p.markPricePNS,
    markPriceWad: scaledToWad(p.markPricePNS, m.priceDecimals),
    liqPricePNS: p.liqPricePNS,
    liqPriceWad: scaledToWad(p.liqPricePNS, m.priceDecimals),
    liqLots: p.liqLotLNS,
    remainingLots: p.posLotLNS,
    deltaPnlCNS: p.deltaPnlCNS,
    fundingCNS: p.fundingCNS,
    onOrderBook: p.onOrderBook,
    block: blockOf(event),
    timestamp: tsOf(event),
    txHash: event.transaction.hash,
  });
});
