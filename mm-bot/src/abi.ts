// Minimal typed fragments of the frozen interfaces (interfaces-v1.3). test/abi.test.ts checks every selector
// against the committed abis/*.json, so drift from contracts/src/interfaces fails CI.
import { parseAbi } from "viem";

export const orderBookAbi = parseAbi([
  "struct OrderView { address maker; bool isBid; uint32 tick; uint64 remainingLots; uint64 placedBlock; }",
  "function placeLimitOrder(bool isBid, uint32 tick, uint64 lots, uint8 flags) returns (uint64 orderId, uint64 filledLots)",
  "function replaceOrder(uint64 orderId, uint32 newTick, uint64 newLots, uint8 flags) returns (uint64 newOrderId, uint64 filledLots)",
  "function cancelOrder(uint64 orderId)",
  "function getOrder(uint64 orderId) view returns (OrderView)",
  "function tickSize() view returns (uint256)",
  "function lotSize() view returns (uint256)",
  "event OrderPlaced(uint64 indexed orderId, address indexed maker, bool isBid, uint32 tick, uint64 lots, uint8 flags)",
  "event OrderEvicted(uint64 indexed orderId, address indexed maker, uint64 remainingLots)",
  "event Trade(uint64 indexed makerOrderId, address indexed maker, address indexed taker, bool takerIsBid, uint32 tick, uint64 lots, uint256 priceWad, uint256 sizeWad)",
]);

export const clearingHouseAbi = parseAbi([
  "struct AccountView { uint256 collateral; int256 size; uint256 entryPrice; int256 unrealizedPnl; int256 pendingFunding; int256 equity; uint256 initialMargin; uint256 maintenanceMargin; uint256 reservedOrderMargin; uint256 liquidationPrice; bool liquidatable; }",
  "function getAccount(address account) view returns (AccountView)",
]);

export const oracleAdapterAbi = parseAbi([
  "function tryGetIndexPrice() view returns (bool ok, uint256 priceWad, uint256 updatedAt)",
]);
