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

    /// @notice Reverts InsufficientMargin if the order would push initial margin above equity.
    function reserveOrderMargin(address trader, bool isBid, uint256 sizeWad, uint256 priceWad) external;
    function releaseOrderMargin(address trader, bool isBid, uint256 sizeWad, uint256 priceWad) external;
    /// @notice Settle one maker fill; releases the matching reservation.
    /// @return ok false => maker failed the margin check; the book must evict the order and continue.
    function settleMakerFill(address maker, bool makerIsBid, uint256 sizeWad, uint256 priceWad)
        external
        returns (bool ok);
    /// @notice Settle the aggregated taker side of one order. Enforces IM (or reduce-only) and reverts otherwise.
    function settleTakerFill(address taker, bool takerIsBid, uint256 sizeWad, uint256 notionalWad, bool reduceOnly)
        external;

    function orderBook() external view returns (address);
}
