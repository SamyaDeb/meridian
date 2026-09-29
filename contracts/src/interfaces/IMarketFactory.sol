// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMarketFactory — registry of perp markets (FROZEN)
/// @notice Markets are deployed by script (OrderBook and ClearingHouse reference each other, wired via
///         IClearingHouse.setOrderBook) and then registered here. The registry is read-mostly: it is never
///         touched on the trading hot path, so it causes no cross-market conflicts.
interface IMarketFactory {
    struct Market {
        bytes32 marketId; // keccak256(symbol), e.g. keccak256("MON-PERP")
        string symbol;
        address orderBook;
        address clearingHouse;
        address oracle;
        address baseAsset; // spot asset used by the vault hedge (e.g. WMON); informational
        bool active;
    }

    event MarketRegistered(
        bytes32 indexed marketId, string symbol, address orderBook, address clearingHouse, address oracle
    );
    event MarketStatusChanged(bytes32 indexed marketId, bool active);

    error MarketExists();
    error UnknownMarket();
    /// @notice CR-006: zero address, or the ClearingHouse is not wired to the given order book.
    error InvalidParams();

    function registerMarket(
        string calldata symbol,
        address orderBook,
        address clearingHouse,
        address oracle,
        address baseAsset
    ) external returns (bytes32 marketId);
    function setMarketActive(bytes32 marketId, bool active) external;

    function getMarket(bytes32 marketId) external view returns (Market memory);
    function marketIds() external view returns (bytes32[] memory); // bounded: tiny list (1-2 markets)
    function marketByClearingHouse(address clearingHouse) external view returns (bytes32 marketId);
}
