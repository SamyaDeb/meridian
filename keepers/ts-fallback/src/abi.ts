// Minimal typed fragments of the frozen interfaces (interfaces-v1.3). test/abi.test.ts checks every
// selector against the committed abis/*.json, so drift from contracts/src/interfaces fails CI.
import { parseAbi } from "viem";

export const clearingHouseAbi = parseAbi([
  "struct FundingState { int256 cumFunding; int256 cumIndexTime; int256 emaPremium; int256 rate; uint64 lastUpdateBlock; }",
  "struct AccountView { uint256 collateral; int256 size; uint256 entryPrice; int256 unrealizedPnl; int256 pendingFunding; int256 equity; uint256 initialMargin; uint256 maintenanceMargin; uint256 reservedOrderMargin; uint256 liquidationPrice; bool liquidatable; }",
  "function fundingState() view returns (FundingState)",
  "function getAccount(address account) view returns (AccountView)",
  "function updateFunding() returns (int256 cumFunding)",
  "function liquidate(address account, uint256 maxSizeWad) returns (int256 sizeTransferred)",
  "event PositionChanged(address indexed account, int256 sizeDelta, int256 newSize, uint256 priceWad, int256 realizedPnl, int256 fee, bool isMaker)",
]);

export const oracleAdapterAbi = parseAbi([
  "function tryGetIndexPrice() view returns (bool ok, uint256 priceWad, uint256 updatedAt)",
  "function updateFee(bytes[] updateData) view returns (uint256 feeWei)",
  "function updatePrice(bytes[] updateData) payable",
]);

export const pulseVaultAbi = parseAbi([
  "function needsRebalance() view returns (uint8 reason)",
  "function rebalance() returns (uint8 reason)",
  "function rebalanceWithRoute(bytes spotRoute) returns (uint8 reason)",
]);
