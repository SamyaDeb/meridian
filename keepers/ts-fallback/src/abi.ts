// Minimal typed fragments of the frozen interfaces (interfaces-v1.3). test/abi.test.ts checks every
// selector against the committed abis/*.json, so drift from contracts/src/interfaces fails CI.
import { parseAbi } from "viem";

export const clearingHouseAbi = parseAbi([
  "struct FundingState { int256 cumFunding; int256 cumIndexTime; int256 emaPremium; int256 rate; uint64 lastUpdateBlock; }",
  "struct AccountView { uint256 collateral; int256 size; uint256 entryPrice; int256 unrealizedPnl; int256 pendingFunding; int256 equity; uint256 initialMargin; uint256 maintenanceMargin; uint256 reservedOrderMargin; uint256 liquidationPrice; bool liquidatable; }",
  "function fundingState() view returns (FundingState)",
  "function markPrice() view returns (uint256 priceWad)",
  "function getAccount(address account) view returns (AccountView)",
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

export const pulseVaultAbi = parseAbi([
  "struct HedgeState { uint256 spotBase; int256 perpSize; int256 perpEquity; uint256 idleAssets; uint256 nav; int256 netDelta; uint256 marginRatio; bool hedged; uint64 lastRebalanceBlock; }",
  "function hedgeState() view returns (HedgeState)",
  "function needsRebalance() view returns (uint8 reason)",
  "function rebalance() returns (uint8 reason)",
  "function rebalanceWithRoute(bytes spotRoute) returns (uint8 reason)",
  "function hedger() view returns (address)",
  "function sharePrice() view returns (uint256)",
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
