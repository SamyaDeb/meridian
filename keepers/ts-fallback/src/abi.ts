// Minimal typed fragments of the frozen interfaces (interfaces-v1.3). test/abi.test.ts checks every
// selector against the committed abis/*.json, so drift from contracts/src/interfaces fails CI.
import { parseAbi } from "viem";

export const clearingHouseAbi = parseAbi([
  "struct FundingState { int256 cumFunding; int256 cumIndexTime; int256 emaPremium; int256 rate; uint64 lastUpdateBlock; }",
  "struct AccountView { uint256 collateral; int256 size; uint256 entryPrice; int256 unrealizedPnl; int256 pendingFunding; int256 equity; uint256 initialMargin; uint256 maintenanceMargin; uint256 reservedOrderMargin; uint256 liquidationPrice; bool liquidatable; }",
  "function fundingState() view returns (FundingState)",
  "function markPrice() view returns (uint256 priceWad)",
  "function getAccount(address account) view returns (AccountView)",
  "struct RiskParams { uint256 imr; uint256 mmr; uint256 takerFee; int256 makerFee; uint256 liqPenalty; uint256 keeperShare; uint256 maxOpenInterest; uint256 maxPositionSize; }",
  "function riskParams() view returns (RiskParams)",
  "function updateFunding() returns (int256 cumFunding)",
  "function liquidate(address account, uint256 maxSizeWad) returns (int256 sizeTransferred)",
  "event PositionChanged(address indexed account, int256 sizeDelta, int256 newSize, uint256 priceWad, int256 realizedPnl, int256 fee, bool isMaker)",
  "event FundingUpdated(uint64 indexed blockNumber, int256 premium, int256 emaPremium, int256 rate, int256 cumFunding, int256 cumIndexTime, uint256 indexPriceWad, uint256 markPriceWad)",
]);

export const oracleAdapterAbi = parseAbi([
  "function tryGetIndexPrice() view returns (bool ok, uint256 priceWad, uint256 updatedAt)",
  "function updateFee(bytes[] updateData) view returns (uint256 feeWei)",
  "function updatePrice(bytes[] updateData) payable",
  "event PriceUpdated(uint256 priceWad, uint256 publishTime, uint8 source)",
]);

export const meridianVaultAbi = parseAbi([
  "struct HedgeState { uint256 spotBase; int256 perpSize; int256 perpEquity; uint256 idleAssets; uint256 nav; int256 netDelta; uint256 marginRatio; bool hedged; uint64 lastRebalanceBlock; }",
  "function hedgeState() view returns (HedgeState)",
  "function needsRebalance() view returns (uint8 reason)",
  "function rebalance() returns (uint8 reason)",
  "function rebalanceWithRoute(bytes spotRoute) returns (uint8 reason)",
  "function hedger() view returns (address)",
  "function sharePrice() view returns (uint256)",
  // CR-014 (interfaces-v1.7): the fulfil loop (src/redeem.ts)
  "function fulfillRedeems(uint256[] ids, bytes spotRoute)",
  "function previewFulfill(uint256[] ids) view returns (uint256 assets, uint256 spotToSell)",
  "event RedeemRequested(uint256 indexed id, address indexed owner, address receiver, uint256 shares)",
  "event RedeemCancelled(uint256 indexed id)",
  "event RedeemFulfilled(uint256 indexed id, uint256 assets, uint256 unwindCost)",
]);

// IKuruHedger (CR-002): the vault's spot leg; the keeper decodes its calls from a trace and reads its wiring.
export const kuruHedgerAbi = parseAbi([
  "function buySpot(uint256 quoteInToken, uint256 minBaseOut, bytes route) returns (uint256 baseOut)",
  "function sellSpot(uint256 baseIn, uint256 minQuoteOut, bytes route) returns (uint256 quoteOutToken)",
  "function flowEntrypoint() view returns (address)",
  "function baseToken() view returns (address)",
  "function quoteToken() view returns (address)",
]);

// IFundingSwapMarket (interfaces-v1.5), checked against abis/IFundingSwapMarket.json.
export const fundingSwapAbi = parseAbi([
  "struct SwapAccountView { uint256 collateral; int256 size; int256 avgFixedApr; int256 accruedNet; int256 unrealizedPnl; int256 equity; uint256 initialMargin; uint256 maintenanceMargin; uint256 reservedOrderMargin; bool liquidatable; }",
  "function getAccount(address account) view returns (SwapAccountView)",
  "function liquidate(address account, uint256 maxSizeWad) returns (int256 sizeTransferred)",
  "function settle(address account)",
  "function settleMaturity()",
  "function maturity() view returns (uint256 timestamp)",
  "event SwapPositionChanged(address indexed account, int256 sizeDelta, int256 newSize, int256 aprWad, int256 realizedPnl, int256 fee, bool isMaker)",
  "event MaturitySettled(int256 cumFundingAtMaturity, int256 cumIndexTimeAtMaturity, uint64 blockNumber)",
]);

// FundingSwapMarket (the deployed contract, not the frozen interface), checked against abis/FundingSwapMarket.json:
// the "snapshot taken" flag. isMatured() is only `block.timestamp >= maturity`, true before any snapshot.
export const fundingSwapImplAbi = parseAbi([
  "function maturitySnapshot() view returns (bool snapped, int256 cumFunding, int256 cumIndexTime)",
]);

// H-1 keeper unwind (IOrderBook): the keeper closes what a liquidation handed it with a reduce-only IOC market order, on
// the perp book and (when it has liquidity) the funding-swap book (same OrderBook contract, price = 1 + APR).
export const orderBookAbi = parseAbi([
  "function placeMarketOrder(bool isBid, uint64 lots, uint32 limitTick, uint64 minFilledLots, bool reduceOnly) returns (uint64 filledLots, uint256 avgPriceWad)",
  "function lotSize() view returns (uint256)",
  "function tickSize() view returns (uint256)",
  "function bestBid() view returns (uint32 tick)",
  "function bestAsk() view returns (uint32 tick)",
]);

// H-1 swap side: cap check and the reference price for the swap unwind bound (IFundingSwapMarket).
export const fundingSwapUnwindAbi = parseAbi([
  "struct SwapParams { uint256 aprMoveBuffer; uint256 liqHorizonSec; uint256 imMultiplier; uint256 takerFeeApr; int256 makerFeeApr; uint256 liqPenalty; uint256 keeperShare; uint256 maxOpenInterest; uint256 maxPositionSize; }",
  "function swapParams() view returns (SwapParams)",
  "function markApr() view returns (int256 aprWad)",
]);

export const insuranceFundAbi = parseAbi(["function balance() view returns (uint256 amountToken)"]);

// Watcher reads (Phase 5 B6): IOrderBook, IFundingSwapMarket, Chainlink AggregatorV3 (external interface).
export const orderBookWatchAbi = parseAbi(["function openOrderCount(address account) view returns (uint256)"]);
export const fundingSwapWatchAbi = parseAbi([
  "function maturity() view returns (uint256 timestamp)",
  "function openInterest() view returns (uint256 longOI, uint256 shortOI)",
]);
export const aggregatorAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

// PS (CR-017): PerplFundingSource (contracts/src/oracle/PerplFundingSource.sol, abis/PerplFundingSource.json) and the
// one Perpl Exchange view the poke duty reads (abis/IPerplExchange.json, copied from indexer/abis/PerplExchange.json).
export const perplFundingSourceAbi = parseAbi([
  "function poke() returns (bool advanced)",
  "function latestObservation() view returns (int256 cumFunding, int256 cumIndexTime, uint64 blockNumber)",
  "function exchange() view returns (address)",
  "function perpId() view returns (uint256)",
  "function lastPokeBlock() view returns (uint64)",
  "event Poked(int256 cumFunding, uint256 cumIndexTime, uint64 fundingEventBlock, uint256 priceWad, int256 rate)",
  "error StalePerplPrice(uint256 oracleTimestampSec)",
  "error PerplScaleChanged()",
]);
export const perplExchangeAbi = parseAbi([
  "function getFundingSumAtBlock(uint256 perpId, uint256 blockNumber) view returns (int48 fundingSumPNS, uint256 fundingEventBlock)",
]);
