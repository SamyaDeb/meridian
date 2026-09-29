// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IInsuranceFund} from "../interfaces/IInsuranceFund.sol";

/// @notice Balance-based insurance fund. Authorization is open by default in the mock (set `strict`).
contract MockInsuranceFund is IInsuranceFund {
    using SafeERC20 for IERC20;

    address public immutable asset;
    bool public strict;
    mapping(address => bool) public isAuthorized;

    constructor(address asset_) {
        asset = asset_;
    }

    function setStrict(bool s) external {
        strict = s;
    }

    function balance() public view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }

    function fund(uint256 amountToken) external {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amountToken);
        emit Funded(msg.sender, amountToken);
    }

    function coverBadDebt(uint256 requestedToken) external returns (uint256 covered) {
        if (strict && !isAuthorized[msg.sender]) revert UnauthorizedMarket();
        uint256 bal = balance();
        covered = requestedToken < bal ? requestedToken : bal;
        IERC20(asset).safeTransfer(msg.sender, covered);
        emit BadDebtCovered(msg.sender, requestedToken, covered);
    }

    function setMarketAuthorized(address market, bool authorized) external {
        isAuthorized[market] = authorized;
        emit MarketAuthorized(market, authorized);
    }
}
