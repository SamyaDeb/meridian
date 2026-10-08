// Minimal ABIs the workflows need, as human-readable fragments checked against abis/*.json by test/abi.test.ts.
import { parseAbi } from "viem";

export const clearingHouseAbi = parseAbi([
  "struct AccountView { uint256 collateral; int256 size; uint256 entryPrice; int256 unrealizedPnl; int256 pendingFunding; int256 equity; uint256 initialMargin; uint256 maintenanceMargin; uint256 reservedOrderMargin; uint256 liquidationPrice; bool liquidatable; }",
  "struct FundingState { int256 cumFunding; int256 cumIndexTime; int256 emaPremium; int256 rate; uint64 lastUpdateBlock; }",
  "function getAccount(address account) view returns (AccountView)",
  "function fundingState() view returns (FundingState)",
  "function markPrice() view returns (uint256)",
  "function openInterest() view returns (uint256 longOI, uint256 shortOI)",
  "function averageFundingApr(uint64 blocksAgo) view returns (int256 aprWad)",
  "function oracle() view returns (address)",
  "event PositionChanged(address indexed account, int256 sizeDelta, int256 newSize, uint256 priceWad, int256 realizedPnl, int256 fee, bool isMaker)",
]);

export const vaultAbi = parseAbi([
  "function needsRebalance() view returns (uint8)",
  "function isKeeper(address) view returns (bool)",
  "function rebalance() returns (uint8 reason)",
]);

export const oracleAbi = parseAbi([
  "function tryGetIndexPrice() view returns (bool ok, uint256 priceWad, uint256 updatedAt)",
  "event PriceUpdated(uint256 priceWad, uint256 publishTime, uint8 source)",
]);

export const mfiFeedAbi = parseAbi([
  "function latest() view returns (int256 mfiAprWad, int256 meridianAprWad, int256 perplAprWad, uint64 blockNumber, uint64 perplFundingBlock)",
]);

export const receiverAbi = parseAbi([
  "event ReportExecuted(uint8 indexed action, bool success, bytes32 workflowId)",
  "event Unwound(address indexed clearingHouse, bool isBid, uint64 lotsRequested, uint64 lotsFilled)",
  "function forwarder() view returns (address)",
]);
