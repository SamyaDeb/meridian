// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IInsuranceFund} from "../interfaces/IInsuranceFund.sol";

/// @title InsuranceFund — AUSD backstop shared by all markets (perp ClearingHouses and swap markets)
/// @notice Balance-based: liquidation surplus arrives by plain transfer, anyone can top up with `fund`.
///         Only authorized markets draw on it, and only through `coverBadDebt`. Off the trading hot path.
contract InsuranceFund is IInsuranceFund, Ownable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @inheritdoc IInsuranceFund
    address public immutable asset;
    /// @inheritdoc IInsuranceFund
    mapping(address => bool) public isAuthorized;

    constructor(address asset_, address owner_) Ownable(owner_) {
        asset = asset_;
    }

    /// @inheritdoc IInsuranceFund
    function balance() public view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }

    /// @inheritdoc IInsuranceFund
    function fund(uint256 amountToken) external nonReentrant {
        emit Funded(msg.sender, amountToken);
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amountToken);
    }

    /// @inheritdoc IInsuranceFund
    function coverBadDebt(uint256 requestedToken) external nonReentrant returns (uint256 coveredToken) {
        if (!isAuthorized[msg.sender]) revert UnauthorizedMarket();
        uint256 bal = balance();
        coveredToken = requestedToken < bal ? requestedToken : bal;
        emit BadDebtCovered(msg.sender, requestedToken, coveredToken);
        if (coveredToken != 0) IERC20(asset).safeTransfer(msg.sender, coveredToken);
    }

    /// @inheritdoc IInsuranceFund
    function setMarketAuthorized(address market, bool authorized) external onlyOwner {
        isAuthorized[market] = authorized;
        emit MarketAuthorized(market, authorized);
    }
}
