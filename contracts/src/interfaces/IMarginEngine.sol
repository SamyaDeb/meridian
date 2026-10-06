// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMarginEngine — the hook surface an OrderBook settles against (FROZEN, CR-003)
/// @notice The OrderBook is instrument-agnostic: it matches prices/sizes and calls these hooks. Two engines
///         implement it: the perp ClearingHouse (price = asset price) and the FundingSwapMarket
///         (price = 1 + fixed APR). Protocol: docs/INTERFACES.md §2.
interface IMarginEngine {
    error OnlyOrderBook();
    error InsufficientMargin();
    error ReduceOnlyViolated();

    /// @notice Outcome of one maker fill (CR-007). Filled = settled. Evict = the maker itself can't carry the fill
    ///         (margin, position cap, matured swap): the book removes the order, releases its remainder and continues.
    ///         Skip = the market refuses new risk right now (paused, oracle stale): the order must stay untouched
    ///         and the book stops matching.
    enum MakerFillResult {
        Filled,
        Evict,
        Skip
    }

    /// @notice Reverts InsufficientMargin if the order would push initial margin above equity.
    function reserveOrderMargin(address trader, bool isBid, uint256 sizeWad, uint256 priceWad) external;
    function releaseOrderMargin(address trader, bool isBid, uint256 sizeWad, uint256 priceWad) external;
    /// @notice Settle one maker fill; on Filled, releases the matching reservation.
    /// @return result Filled => settled; Evict => the book must evict the order (release its remainder) and continue;
    ///         Skip => nothing written for the fill, reservation kept: the book must leave the order resting
    ///         untouched and stop matching.
    function settleMakerFill(address maker, bool makerIsBid, uint256 sizeWad, uint256 priceWad)
        external
        returns (MakerFillResult result);
    /// @notice Settle the aggregated taker side of one order. Enforces IM (or reduce-only) and reverts otherwise.
    function settleTakerFill(address taker, bool takerIsBid, uint256 sizeWad, uint256 notionalWad, bool reduceOnly)
        external;

    function orderBook() external view returns (address);
}
