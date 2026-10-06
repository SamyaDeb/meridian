// Minimal typed fragments of the frozen interfaces (interfaces-v1.6). test/abi.test.ts checks every selector
// against the committed abis/*.json, so drift from contracts/src/interfaces fails CI.
import { parseAbi } from "viem";

export const orderBookAbi = parseAbi([
  "struct OrderView { address maker; bool isBid; uint32 tick; uint64 remainingLots; uint64 placedBlock; }",
  "function placeLimitOrder(bool isBid, uint32 tick, uint64 lots, uint8 flags) returns (uint64 orderId, uint64 filledLots)",
  "function replaceOrder(uint64 orderId, uint32 newTick, uint64 newLots, uint8 flags) returns (uint64 newOrderId, uint64 filledLots)",
  "function placeMarketOrder(bool isBid, uint64 lots, uint32 limitTick, uint64 minFilledLots, bool reduceOnly) returns (uint64 filledLots, uint256 avgPriceWad)",
  "function cancelOrder(uint64 orderId)",
  "function getOrder(uint64 orderId) view returns (OrderView)",
  "function tickSize() view returns (uint256)",
  "function lotSize() view returns (uint256)",
  "function bestBid() view returns (uint32 tick)",
  "function bestAsk() view returns (uint32 tick)",
  "event OrderPlaced(uint64 indexed orderId, address indexed maker, bool isBid, uint32 tick, uint64 lots, uint8 flags)",
  "event OrderEvicted(uint64 indexed orderId, address indexed maker, uint64 remainingLots)",
  "event MakerFillSkipped(uint64 indexed orderId, address indexed maker)",
  "event Trade(uint64 indexed makerOrderId, address indexed maker, address indexed taker, bool takerIsBid, uint32 tick, uint64 lots, uint256 priceWad, uint256 sizeWad)",
]);

export const clearingHouseAbi = parseAbi([
  "struct FundingState { int256 cumFunding; int256 cumIndexTime; int256 emaPremium; int256 rate; uint64 lastUpdateBlock; }",
  "struct FundingParams { uint256 alpha; int256 interestRate; uint256 rateCap; uint256 maxRateChangePerBlock; uint256 blockTimeMs; uint256 premiumBandWad; }",
  "function previewFundingState() view returns (FundingState)",
  "function fundingParams() view returns (FundingParams)",
  "struct AccountView { uint256 collateral; int256 size; uint256 entryPrice; int256 unrealizedPnl; int256 pendingFunding; int256 equity; uint256 initialMargin; uint256 maintenanceMargin; uint256 reservedOrderMargin; uint256 liquidationPrice; bool liquidatable; }",
  "function getAccount(address account) view returns (AccountView)",
]);

export const oracleAdapterAbi = parseAbi([
  "function tryGetIndexPrice() view returns (bool ok, uint256 priceWad, uint256 updatedAt)",
]);

// IFundingSwapMarket (MARKET=swap): the swap market is the margin engine of the SwapOrderBook.
export const fundingSwapAbi = parseAbi([
  "struct SwapAccountView { uint256 collateral; int256 size; int256 avgFixedApr; int256 accruedNet; int256 unrealizedPnl; int256 equity; uint256 initialMargin; uint256 maintenanceMargin; uint256 reservedOrderMargin; bool liquidatable; }",
  "struct SwapParams { uint256 aprMoveBuffer; uint256 liqHorizonSec; uint256 imMultiplier; uint256 takerFeeApr; int256 makerFeeApr; uint256 liqPenalty; uint256 keeperShare; uint256 maxOpenInterest; uint256 maxPositionSize; }",
  "function getAccount(address account) view returns (SwapAccountView)",
  "function realizedApr(uint64 blocksAgo) view returns (int256 aprWad)",
  "function swapParams() view returns (SwapParams)",
  "function isMatured() view returns (bool)",
]);
