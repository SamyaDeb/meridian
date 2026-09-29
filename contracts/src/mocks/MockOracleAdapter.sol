// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOracleAdapter} from "../interfaces/IOracleAdapter.sol";

/// @notice Settable index price. `setStale(true)` makes getIndexPrice revert and tryGetIndexPrice return ok=false.
contract MockOracleAdapter is IOracleAdapter {
    uint256 public price;
    uint256 public updatedAt;
    bool public stale;

    constructor(uint256 priceWad) {
        setPrice(priceWad);
    }

    function setPrice(uint256 priceWad) public {
        price = priceWad;
        updatedAt = block.timestamp;
        emit PriceUpdated(priceWad, block.timestamp, Source.Primary);
    }

    function setStale(bool s) external {
        stale = s;
    }

    function getIndexPrice() external view returns (uint256, uint256) {
        if (stale) revert StalePrice();
        if (price == 0) revert InvalidPrice();
        return (price, updatedAt);
    }

    function tryGetIndexPrice() external view returns (bool, uint256, uint256) {
        return (!stale && price != 0, price, updatedAt);
    }

    function updatePrice(bytes[] calldata) external payable {
        updatedAt = block.timestamp;
        if (msg.value > 0) payable(msg.sender).transfer(msg.value);
    }

    function updateFee(bytes[] calldata) external pure returns (uint256) {
        return 0;
    }

    function maxStaleness() external pure returns (uint256) {
        return 60;
    }

    function maxDeviation() external pure returns (uint256) {
        return 0.02e18;
    }

    function description() external pure returns (string memory) {
        return "MOCK/USD";
    }
}
