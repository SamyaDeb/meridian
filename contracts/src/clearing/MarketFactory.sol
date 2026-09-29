// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IMarketFactory} from "../interfaces/IMarketFactory.sol";
import {IMarginEngine} from "../interfaces/IMarginEngine.sol";

/// @title MarketFactory — registry of perp markets
/// @notice Markets are deployed by script (OrderBook ⇄ ClearingHouse wiring) and registered here. Never read on
///         the trading hot path. `marketIds()` returns the whole list; it stays tiny (1–2 markets).
contract MarketFactory is IMarketFactory, Ownable {
    mapping(bytes32 => Market) internal _markets;
    mapping(address => bytes32) internal _byClearingHouse;
    bytes32[] internal _ids;

    constructor(address owner_) Ownable(owner_) {}

    /// @inheritdoc IMarketFactory
    function registerMarket(
        string calldata symbol,
        address orderBook,
        address clearingHouse,
        address oracle,
        address baseAsset
    ) external onlyOwner returns (bytes32 marketId) {
        if (
            bytes(symbol).length == 0 || orderBook == address(0) || clearingHouse == address(0) || oracle == address(0)
                || IMarginEngine(clearingHouse).orderBook() != orderBook
        ) revert InvalidParams();
        marketId = keccak256(bytes(symbol));
        if (_markets[marketId].clearingHouse != address(0) || _byClearingHouse[clearingHouse] != bytes32(0)) {
            revert MarketExists();
        }
        _markets[marketId] = Market(marketId, symbol, orderBook, clearingHouse, oracle, baseAsset, true);
        _byClearingHouse[clearingHouse] = marketId;
        _ids.push(marketId);
        emit MarketRegistered(marketId, symbol, orderBook, clearingHouse, oracle);
    }

    /// @inheritdoc IMarketFactory
    function setMarketActive(bytes32 marketId, bool active) external onlyOwner {
        Market storage m = _markets[marketId];
        if (m.clearingHouse == address(0)) revert UnknownMarket();
        m.active = active;
        emit MarketStatusChanged(marketId, active);
    }

    /// @inheritdoc IMarketFactory
    function getMarket(bytes32 marketId) external view returns (Market memory m) {
        m = _markets[marketId];
        if (m.clearingHouse == address(0)) revert UnknownMarket();
    }

    /// @inheritdoc IMarketFactory
    function marketIds() external view returns (bytes32[] memory) {
        return _ids;
    }

    /// @inheritdoc IMarketFactory
    function marketByClearingHouse(address clearingHouse) external view returns (bytes32 marketId) {
        marketId = _byClearingHouse[clearingHouse];
        if (marketId == bytes32(0)) revert UnknownMarket();
    }
}
