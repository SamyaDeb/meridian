// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IInsuranceFund — AUSD backstop shared by all markets (FROZEN)
/// @notice Receives liquidation surplus by plain ERC20 transfer (balance-based accounting).
///         Only registered ClearingHouses may draw on it. Touched only on liquidation / bad debt,
///         never on the trading hot path.
interface IInsuranceFund {
    event Funded(address indexed from, uint256 amountToken);
    event BadDebtCovered(address indexed market, uint256 requestedToken, uint256 coveredToken);
    event MarketAuthorized(address indexed market, bool authorized);

    error UnauthorizedMarket();

    function asset() external view returns (address);
    function balance() external view returns (uint256 amountToken);
    function fund(uint256 amountToken) external;
    /// @notice Transfers min(requested, balance) to msg.sender.
    function coverBadDebt(uint256 requestedToken) external returns (uint256 coveredToken);
    function setMarketAuthorized(address market, bool authorized) external;
    function isAuthorized(address market) external view returns (bool);
}
