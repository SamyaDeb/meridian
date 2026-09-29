// Minimal typed fragments of the frozen interfaces (interfaces-v1.3); abi.test.ts checks them against abis/*.json.
import { parseAbi } from "viem";

export const clearingHouseAbi = parseAbi([
  "struct FundingState { int256 cumFunding; int256 cumIndexTime; int256 emaPremium; int256 rate; uint64 lastUpdateBlock; }",
  "struct Position { int256 size; int256 openNotional; int256 lastCumFunding; }",
  "struct AccountView { uint256 collateral; int256 size; uint256 entryPrice; int256 unrealizedPnl; int256 pendingFunding; int256 equity; uint256 initialMargin; uint256 maintenanceMargin; uint256 reservedOrderMargin; uint256 liquidationPrice; bool liquidatable; }",
  "struct RiskParams { uint256 imr; uint256 mmr; uint256 takerFee; int256 makerFee; uint256 liqPenalty; uint256 keeperShare; uint256 maxOpenInterest; uint256 maxPositionSize; }",
  "struct FundingParams { uint256 alpha; int256 interestRate; uint256 rateCap; uint256 maxRateChangePerBlock; uint256 blockTimeMs; uint256 premiumBandWad; }",
  "function previewFundingState() view returns (FundingState)",
  "function markPrice() view returns (uint256)",
  "function indexPrice() view returns (uint256)",
  "function openInterest() view returns (uint256 longOI, uint256 shortOI)",
  "function paused() view returns (bool)",
  "function riskParams() view returns (RiskParams)",
  "function fundingParams() view returns (FundingParams)",
  "function averageFundingApr(uint64 blocksAgo) view returns (int256)",
  "function getAccount(address account) view returns (AccountView)",
  "function getPosition(address account) view returns (Position)",
  "function accruedFees() view returns (uint256)",
  "function deposit(uint256 amountToken)",
  "function withdraw(uint256 amountToken)",
  "event FundingUpdated(uint64 indexed blockNumber, int256 premium, int256 emaPremium, int256 rate, int256 cumFunding, int256 cumIndexTime, uint256 indexPriceWad, uint256 markPriceWad)",
  "event FundingSettled(address indexed account, int256 payment, int256 cumFunding)",
]);

export const orderBookAbi = parseAbi([
  "struct OrderView { address maker; bool isBid; uint32 tick; uint64 remainingLots; uint64 placedBlock; }",
  "function placeLimitOrder(bool isBid, uint32 tick, uint64 lots, uint8 flags) returns (uint64 orderId, uint64 filledLots)",
  "function placeMarketOrder(bool isBid, uint64 lots, uint32 limitTick, uint64 minFilledLots, bool reduceOnly) returns (uint64 filledLots, uint256 avgPriceWad)",
  "function cancelOrder(uint64 orderId)",
  "function getOrder(uint64 orderId) view returns (OrderView)",
  "function getDepth(bool isBid, uint256 maxLevels) view returns (uint32[] ticks, uint64[] lots)",
  "function tickSize() view returns (uint256)",
  "function lotSize() view returns (uint256)",
  "event OrderPlaced(uint64 indexed orderId, address indexed maker, bool isBid, uint32 tick, uint64 lots, uint8 flags)",
  // errors the book can revert with, incl. those bubbled up from the ClearingHouse hooks (so the UI shows a name)
  "error InvalidTick()",
  "error InvalidSize()",
  "error PostOnlyWouldCross()",
  "error NotOrderOwner()",
  "error OrderNotFound()",
  "error TooManyOpenOrders()",
  "error NoLiquidity()",
  "error SlippageExceeded()",
  "error BatchTooLarge()",
  "error Paused()",
  "error InsufficientMargin()",
  "error ReduceOnlyViolated()",
  "error OracleStale()",
  "error PositionCapExceeded()",
  "error OpenInterestCapExceeded()",
  "event Trade(uint64 indexed makerOrderId, address indexed maker, address indexed taker, bool takerIsBid, uint32 tick, uint64 lots, uint256 priceWad, uint256 sizeWad)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function nonces(address owner) view returns (uint256)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);
