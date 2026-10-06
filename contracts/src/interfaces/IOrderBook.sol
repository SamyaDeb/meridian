// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IOrderBook — one fully onchain CLOB per perp market (FROZEN)
/// @notice Price-time priority. Price = tick * tickSize (WAD). Size = lots * lotSize (base WAD).
///         Instrument-agnostic (CR-003): every fill settles synchronously in the market's IMarginEngine —
///         the perp ClearingHouse (price = AUSD per MON) or the FundingSwapMarket (price = 1 + fixed APR).
///         No offchain matching.
///         Loops are bounded by MeridianConstants.MAX_FILLS_PER_ORDER / MAX_BATCH.
interface IOrderBook {
    // ─── Flags for placeLimitOrder ─────────────────────────────────────────────
    // uint8 bitmask: FLAG_POST_ONLY = 1, FLAG_IOC = 2, FLAG_REDUCE_ONLY = 4

    struct OrderView {
        address maker;
        bool isBid;
        uint32 tick;
        uint64 remainingLots;
        uint64 placedBlock;
    }

    // ─── Events ────────────────────────────────────────────────────────────────
    event OrderPlaced(uint64 indexed orderId, address indexed maker, bool isBid, uint32 tick, uint64 lots, uint8 flags);
    event OrderCancelled(uint64 indexed orderId, address indexed maker, uint64 remainingLots);
    /// @notice Resting order removed during matching because the maker failed the margin check.
    event OrderEvicted(uint64 indexed orderId, address indexed maker, uint64 remainingLots);
    /// @notice The engine refused a fill on this resting order because the market refuses new risk (paused, oracle
    ///         stale; CR-007). The order is still live and unchanged; matching stopped at it.
    event MakerFillSkipped(uint64 indexed orderId, address indexed maker);
    /// @notice One event per maker fill. priceWad = tick * tickSize; sizeWad = lots * lotSize.
    event Trade(
        uint64 indexed makerOrderId,
        address indexed maker,
        address indexed taker,
        bool takerIsBid,
        uint32 tick,
        uint64 lots,
        uint256 priceWad,
        uint256 sizeWad
    );

    // ─── Errors ────────────────────────────────────────────────────────────────
    error InvalidTick();
    error InvalidSize();
    error PostOnlyWouldCross();
    error NotOrderOwner();
    error OrderNotFound();
    error TooManyOpenOrders();
    error NoLiquidity();
    error SlippageExceeded();
    error BatchTooLarge();
    error Paused();

    // ─── Trading ───────────────────────────────────────────────────────────────
    /// @return orderId 0 if nothing rests (fully filled or IOC)
    /// @return filledLots lots filled immediately as taker
    function placeLimitOrder(bool isBid, uint32 tick, uint64 lots, uint8 flags)
        external
        returns (uint64 orderId, uint64 filledLots);

    /// @notice Market order = IOC limit at `limitTick` (worst acceptable price). Reverts SlippageExceeded
    ///         if filled < minFilledLots.
    function placeMarketOrder(bool isBid, uint64 lots, uint32 limitTick, uint64 minFilledLots, bool reduceOnly)
        external
        returns (uint64 filledLots, uint256 avgPriceWad);

    function cancelOrder(uint64 orderId) external;

    /// @dev length <= MAX_BATCH
    function cancelOrders(uint64[] calldata orderIds) external;

    /// @notice Cancel + place in one call (market-maker hot path; target < 100k gas). Loses time priority.
    function replaceOrder(uint64 orderId, uint32 newTick, uint64 newLots, uint8 flags)
        external
        returns (uint64 newOrderId, uint64 filledLots);

    // ─── Views ─────────────────────────────────────────────────────────────────
    /// @notice The IMarginEngine this book settles into (name kept for compatibility).
    function clearingHouse() external view returns (address);
    function tickSize() external view returns (uint256); // WAD
    function lotSize() external view returns (uint256); // base WAD
    /// @return tick 0 if no bids
    function bestBid() external view returns (uint32 tick);
    /// @return tick type(uint32).max if no asks
    function bestAsk() external view returns (uint32 tick);
    /// @return midWad (bestBid+bestAsk)/2 price, WAD
    /// @return valid false if either side is empty
    function midPrice() external view returns (uint256 midWad, bool valid);
    /// @return priceWad last traded price, 0 if never traded
    /// @return blockNumber block of that trade
    function lastTrade() external view returns (uint256 priceWad, uint64 blockNumber);
    function getOrder(uint64 orderId) external view returns (OrderView memory);
    function getLevel(uint32 tick) external view returns (uint64 totalLots, uint32 orderCount);
    /// @notice Up to `maxLevels` (<= MAX_BATCH) best levels on one side.
    function getDepth(bool isBid, uint256 maxLevels) external view returns (uint32[] memory ticks, uint64[] memory lots);
    function openOrderCount(address account) external view returns (uint256);
}
