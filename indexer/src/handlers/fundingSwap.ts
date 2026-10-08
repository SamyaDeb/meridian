// IFundingSwapMarket events (fixed-for-floating funding swaps, MATH_SPEC §6).
import { indexer } from "envio";
import {
  FIELDS,
  evId,
  blockOf,
  tsOf,
  getSwapStats,
  getSwapPosition,
  touchAccount,
  updateProtocol,
  logAdmin,
  toJson,
} from "../lib/common.js";
import { applySwapFill, avgFixedAprWad, max } from "../lib/math.js";
import { recordPenaltyIn } from "../lib/insurance.js";

indexer.onEvent({ contract: "FundingSwapMarket", event: "Deposited", fields: FIELDS }, async ({ event, context }) => {
  const { account, amountToken, amountWad } = event.params;
  const block = blockOf(event);
  await touchAccount(context, account, block, tsOf(event));
  await getSwapStats(context, event.srcAddress).then((s) => context.SwapStats.set(s));
  const sp = await getSwapPosition(context, event.srcAddress, account, block);
  context.SwapPosition.set({ ...sp, collateralWad: sp.collateralWad + amountWad, updatedBlock: block });
  await updateProtocol(context, (s) => ({ swapCollateralToken: s.swapCollateralToken + amountToken }), { block, ts: tsOf(event) });
});

indexer.onEvent({ contract: "FundingSwapMarket", event: "Withdrawn", fields: FIELDS }, async ({ event, context }) => {
  const { account, amountToken, amountWad } = event.params;
  const block = blockOf(event);
  const sp = await getSwapPosition(context, event.srcAddress, account, block);
  context.SwapPosition.set({ ...sp, collateralWad: sp.collateralWad - amountWad, updatedBlock: block });
  await updateProtocol(context, (s) => ({ swapCollateralToken: s.swapCollateralToken - amountToken }), { block, ts: tsOf(event) });
});

indexer.onEvent({ contract: "FundingSwapMarket", event: "SwapPositionChanged", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const block = blockOf(event);
  await touchAccount(context, p.account, block, tsOf(event));
  const sp = await getSwapPosition(context, event.srcAddress, p.account, block);
  const oldSize = p.newSize - p.sizeDelta;
  const k = applySwapFill(sp.fixedAprNotional, p.sizeDelta, p.aprWad); // MATH_SPEC §6.2, K += Δq·A/1e18
  context.SwapPosition.set({
    ...sp,
    size: p.newSize,
    fixedAprNotional: k,
    avgFixedAprWad: avgFixedAprWad(p.newSize, k),
    lockedSpread: p.newSize === 0n && k !== 0n,
    realizedPnl: sp.realizedPnl + p.realizedPnl,
    feesPaid: sp.feesPaid + p.fee,
    collateralWad: sp.collateralWad + p.realizedPnl - p.fee,
    updatedBlock: block,
  });
  context.SwapTrade.set({
    id: evId(event),
    swapMarket: event.srcAddress,
    account: p.account,
    sizeDelta: p.sizeDelta,
    newSize: p.newSize,
    aprWad: p.aprWad,
    realizedPnl: p.realizedPnl,
    fee: p.fee,
    isMaker: p.isMaker,
    block,
    timestamp: tsOf(event),
    txHash: event.transaction.hash,
  });
  const st = await getSwapStats(context, event.srcAddress);
  const dOi = max(p.newSize, 0n) - max(oldSize, 0n); // Σq = 0, so long OI = Σ max(q, 0)
  context.SwapStats.set({ ...st, openInterestWad: st.openInterestWad + dOi, feesWad: st.feesWad + p.fee });
  await updateProtocol(context, (s) => ({ feesWad: s.feesWad + p.fee, swapOpenInterestWad: s.swapOpenInterestWad + dOi }), {
    block,
    ts: tsOf(event),
  });
});

indexer.onEvent({ contract: "FundingSwapMarket", event: "SwapAccrualSettled", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const block = blockOf(event);
  const sp = await getSwapPosition(context, event.srcAddress, p.account, block);
  context.SwapPosition.set({
    ...sp,
    floatingReceived: sp.floatingReceived + p.floatingLeg,
    fixedPaid: sp.fixedPaid + p.fixedLeg,
    netAccrued: sp.netAccrued + p.net,
    collateralWad: sp.collateralWad + p.net, // net > 0 ⇒ credited
    updatedBlock: block,
  });
});

indexer.onEvent({ contract: "FundingSwapMarket", event: "SwapLiquidated", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const block = blockOf(event);
  context.Liquidation.set({
    id: evId(event),
    kind: "Swap",
    market: event.srcAddress,
    account: p.account,
    liquidator: p.liquidator,
    sizeTransferred: p.sizeTransferred,
    markPriceWad: undefined,
    markAprWad: p.markAprWad,
    penalty: p.penalty,
    keeperReward: p.keeperReward,
    toInsurance: p.toInsurance,
    badDebt: p.badDebt,
    block,
    timestamp: tsOf(event),
    txHash: event.transaction.hash,
  });
  const sp = await getSwapPosition(context, event.srcAddress, p.account, block);
  const after = sp.collateralWad - p.penalty;
  context.SwapPosition.set({
    ...sp,
    collateralWad: p.badDebt > 0n || after < 0n ? 0n : after,
    liquidationCount: sp.liquidationCount + 1,
    updatedBlock: block,
  });
  // the IF share of the penalty (the swap market has no BadDebtSocialized: its fee / uncovered split isn't evented)
  await recordPenaltyIn(context, event, "Swap", p.account, p.toInsurance);
  await updateProtocol(context, (s) => ({ liquidations: s.liquidations + 1 }), { block, ts: tsOf(event) });
});

indexer.onEvent({ contract: "FundingSwapMarket", event: "MaturitySettled", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const st = await getSwapStats(context, event.srcAddress);
  context.SwapStats.set({
    ...st,
    matured: true,
    cumFundingAtMaturity: p.cumFundingAtMaturity,
    cumIndexTimeAtMaturity: p.cumIndexTimeAtMaturity,
    maturityBlock: p.blockNumber,
  });
  await logAdmin(context, event, "MaturitySettled", p);
});

indexer.onEvent({ contract: "FundingSwapMarket", event: "SwapParamsUpdated", fields: FIELDS }, async ({ event, context }) => {
  const st = await getSwapStats(context, event.srcAddress);
  context.SwapStats.set({ ...st, params: toJson(event.params.params) });
  await logAdmin(context, event, "SwapParamsUpdated", event.params.params);
});
