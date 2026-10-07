// IOracleAdapter, IInsuranceFund, IMarketFactory, IMeridianKeeperReceiver events.
import { indexer } from "envio";
import { FIELDS, evId, blockOf, tsOf, getMarket, updateProtocol, logAdmin, isTestMarket, getInsuranceFund } from "../lib/common.js";
import { DEPLOYMENTS } from "../deployments.gen.js";
import { AUSD_TO_WAD } from "../lib/math.js";

// ─── Oracle adapter ────────────────────────────────────────────────────────────

indexer.onEvent({ contract: "OracleAdapter", event: "PriceUpdated", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  context.OraclePrice.set({
    id: evId(event),
    oracle: event.srcAddress,
    priceWad: p.priceWad,
    publishTime: p.publishTime,
    source: Number(p.source) === 0 ? "Primary" : "Secondary",
    block: blockOf(event),
  });
});

indexer.onEvent({ contract: "OracleAdapter", event: "DeviationGuardTripped", fields: FIELDS }, async ({ event, context }) => {
  context.OracleGuardTrip.set({
    id: evId(event),
    oracle: event.srcAddress,
    primaryWad: event.params.primaryWad,
    secondaryWad: event.params.secondaryWad,
    block: blockOf(event),
    timestamp: tsOf(event),
  });
});

indexer.onEvent({ contract: "OracleAdapter", event: "OracleParamsUpdated", fields: FIELDS }, async ({ event, context }) => {
  await logAdmin(context, event, "OracleParamsUpdated", event.params);
});

// ─── Insurance fund ────────────────────────────────────────────────────────────

const getIF = getInsuranceFund;

indexer.onEvent({ contract: "InsuranceFund", event: "Funded", fields: FIELDS }, async ({ event, context }) => {
  const { from, amountToken } = event.params;
  const f = await getIF(context, event.srcAddress);
  const balanceToken = f.balanceToken + amountToken;
  context.InsuranceFund.set({ ...f, fundedToken: f.fundedToken + amountToken, balanceToken });
  context.InsuranceFundEvent.set({
    id: `${evId(event)}-0`,
    fund: event.srcAddress,
    flow: "Funded",
    direction: "In",
    kind: undefined,
    market: undefined,
    account: undefined,
    from,
    amountWad: amountToken * AUSD_TO_WAD,
    amountToken,
    requestedWad: undefined,
    balanceAfterToken: balanceToken,
    block: blockOf(event),
    timestamp: tsOf(event),
    txHash: event.transaction.hash,
  });
});

// Step 1 of the waterfall: the IF pays what it can (it precedes the market's BadDebtSocialized / Liquidated logs).
indexer.onEvent({ contract: "InsuranceFund", event: "BadDebtCovered", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const f = await getIF(context, event.srcAddress);
  const balanceToken = f.balanceToken - p.coveredToken;
  context.InsuranceFund.set({ ...f, coveredToken: f.coveredToken + p.coveredToken, balanceToken });
  context.BadDebtEvent.set({
    id: evId(event),
    source: event.srcAddress,
    requested: p.requestedToken,
    covered: p.coveredToken,
    uncovered: p.requestedToken - p.coveredToken,
    feeCoveredWad: undefined,
    block: blockOf(event),
    timestamp: tsOf(event),
  });
  const swap = DEPLOYMENTS[context.chain.id]?.FundingSwapMarket;
  context.InsuranceFundEvent.set({
    id: `${evId(event)}-0`,
    fund: event.srcAddress,
    flow: "CoveredByInsurance",
    direction: "Out",
    kind: swap !== undefined && p.market.toLowerCase() === swap.toLowerCase() ? "Swap" : "Perp",
    market: p.market,
    account: undefined, // the market's Liquidated log later in the same tx names the account
    from: undefined,
    amountWad: p.coveredToken * AUSD_TO_WAD,
    amountToken: p.coveredToken,
    requestedWad: p.requestedToken * AUSD_TO_WAD,
    balanceAfterToken: balanceToken,
    block: blockOf(event),
    timestamp: tsOf(event),
    txHash: event.transaction.hash,
  });
});

indexer.onEvent({ contract: "InsuranceFund", event: "MarketAuthorized", fields: FIELDS }, async ({ event, context }) => {
  const { market, authorized } = event.params;
  const f = await getIF(context, event.srcAddress);
  const rest = f.authorizedMarkets.filter((m) => m !== market);
  context.InsuranceFund.set({ ...f, authorizedMarkets: authorized ? [...rest, market] : rest });
  await logAdmin(context, event, "MarketAuthorized", event.params);
});

// ─── Market factory ────────────────────────────────────────────────────────────

// New markets start indexing automatically: their book, clearinghouse and oracle are registered here.
indexer.contractRegister({ contract: "MarketFactory", event: "MarketRegistered" }, async ({ event, context }) => {
  context.chain.OrderBook.add(event.params.orderBook);
  context.chain.ClearingHouse.add(event.params.clearingHouse);
  context.chain.OracleAdapter.add(event.params.oracle);
});

indexer.onEvent({ contract: "MarketFactory", event: "MarketRegistered", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const m = await getMarket(context, p.clearingHouse);
  context.Market.set({
    ...m,
    marketId: p.marketId,
    symbol: p.symbol,
    testMarket: isTestMarket(context.chain.id, p.clearingHouse, p.symbol),
    orderBook: p.orderBook,
    oracle: p.oracle,
    active: true,
  });
  context.BookRef.set({ id: p.orderBook, kind: "Perp", market: p.clearingHouse });
  await logAdmin(context, event, "MarketRegistered", p);
});

indexer.onEvent({ contract: "MarketFactory", event: "MarketStatusChanged", fields: FIELDS }, async ({ event, context }) => {
  const [m] = await context.Market.getWhere({ marketId: { _eq: event.params.marketId } });
  if (m) context.Market.set({ ...m, active: event.params.active });
  await logAdmin(context, event, "MarketStatusChanged", event.params);
});

// ─── Chainlink CRE receiver ───────────────────────────────────────────────────

indexer.onEvent({ contract: "MeridianKeeperReceiver", event: "ReportExecuted", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  context.KeeperReport.set({
    id: evId(event),
    action: Number(p.action),
    success: p.success,
    workflowId: p.workflowId,
    block: blockOf(event),
    timestamp: tsOf(event),
    txHash: event.transaction.hash,
  });
  await updateProtocol(context, (s) => ({
    keeperReports: s.keeperReports + 1,
    keeperReportFailures: s.keeperReportFailures + (p.success ? 0 : 1),
  }), { block: blockOf(event), ts: tsOf(event) });
});

indexer.onEvent({ contract: "MeridianKeeperReceiver", event: "ForwarderUpdated", fields: FIELDS }, async ({ event, context }) => {
  await logAdmin(context, event, "ForwarderUpdated", event.params);
});
