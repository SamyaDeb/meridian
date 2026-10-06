// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RiskParams, FundingParams, FundingState, Position, AccountView} from "./MeridianTypes.sol";
import {IMarginEngine} from "./IMarginEngine.sol";
import {IFundingRateOracle} from "./IFundingRateOracle.sol";

/// @title IClearingHouse — isolated-margin accounting for ONE perp market (FROZEN)
/// @notice One ClearingHouse per market keeps each market's state disjoint (Monad parallel execution).
///         Holds the market's AUSD collateral. Funding is O(1): a cumulative index F updated by the first
///         transaction touching the market in a block and settled lazily per account on touch.
/// @dev CR-003: OrderBook hooks moved to IMarginEngine; funding-rate oracle views in IFundingRateOracle.
interface IClearingHouse is IMarginEngine, IFundingRateOracle {
    // ─── Events ────────────────────────────────────────────────────────────────
    event Deposited(address indexed account, uint256 amountToken, uint256 amountWad);
    event Withdrawn(address indexed account, uint256 amountToken, uint256 amountWad);
    /// @notice Emitted once per block per market (first touch). Source of the funding-history chart.
    event FundingUpdated(
        uint64 indexed blockNumber,
        int256 premium,
        int256 emaPremium,
        int256 rate,
        int256 cumFunding,
        int256 cumIndexTime,
        uint256 indexPriceWad,
        uint256 markPriceWad
    );
    /// @param payment quote WAD paid by the account (+) or received (-)
    event FundingSettled(address indexed account, int256 payment, int256 cumFunding);
    /// @notice Emitted for every fill on both maker and taker side, and for liquidation transfers.
    event PositionChanged(
        address indexed account,
        int256 sizeDelta,
        int256 newSize,
        uint256 priceWad,
        int256 realizedPnl,
        int256 fee,
        bool isMaker
    );
    event Liquidated(
        address indexed account,
        address indexed liquidator,
        int256 sizeTransferred,
        uint256 markPriceWad,
        uint256 penalty,
        uint256 keeperReward,
        uint256 toInsurance,
        uint256 badDebt
    );
    event BadDebtSocialized(uint256 requested, uint256 coveredByInsurance, uint256 uncovered);
    event OrderMarginChanged(address indexed account, uint256 reservedOrderMargin);
    event FeesCollected(address indexed to, uint256 amountToken);
    event RiskParamsUpdated(RiskParams params);
    event FundingParamsUpdated(FundingParams params);
    event PausedSet(bool paused);

    // ─── Errors ────────────────────────────────────────────────────────────────
    error NotLiquidatable();
    error PositionCapExceeded();
    error OpenInterestCapExceeded();
    error OracleStale();
    error ZeroAmount();
    error AlreadyInitialized();
    error Paused();
    /// @notice CR-006: out-of-bounds admin params, zero address, or self-liquidation.
    error InvalidParams();

    // ─── Collateral ────────────────────────────────────────────────────────────
    /// @param amountToken AUSD (6 dp). Credited as amountToken * 1e12 WAD.
    function deposit(uint256 amountToken) external;
    function depositFor(address account, uint256 amountToken) external;
    /// @notice Settles funding first; reverts InsufficientMargin if post-withdraw equity < initial margin.
    ///         Rounds the WAD debit UP (against the user).
    function withdraw(uint256 amountToken) external;

    // ─── Funding ───────────────────────────────────────────────────────────────
    /// @notice Idempotent within a block. Anyone may call (keepers poke idle markets).
    function updateFunding() external returns (int256 cumFunding);
    function settleFunding(address account) external;

    // ─── Liquidation ───────────────────────────────────────────────────────────
    /// @notice msg.sender (liquidator, must have margin in this market) takes over up to `maxSizeWad`
    ///         of `account`'s position at mark price. Penalty = liqPenalty * notional, split keeperShare
    ///         to liquidator and the rest to the insurance fund. Bad debt is pulled from the insurance fund.
    /// @return sizeTransferred signed size moved to the liquidator
    function liquidate(address account, uint256 maxSizeWad) external returns (int256 sizeTransferred);

    // ─── OrderBook hooks: see IMarginEngine (onlyOrderBook) ────────────────────

    // ─── Admin ─────────────────────────────────────────────────────────────────
    /// @notice One-shot wiring (CH and OB reference each other). Reverts AlreadyInitialized.
    function setOrderBook(address orderBook) external;
    function setRiskParams(RiskParams calldata params) external;
    function setFundingParams(FundingParams calldata params) external;
    function setPaused(bool paused) external;
    function collectFees(address to) external returns (uint256 amountToken);

    // ─── Views ─────────────────────────────────────────────────────────────────
    function collateralToken() external view returns (address);
    function oracle() external view returns (address);
    function insuranceFund() external view returns (address);
    function riskParams() external view returns (RiskParams memory);
    function fundingParams() external view returns (FundingParams memory);
    /// @notice Stored state (may lag by blocks).
    function fundingState() external view returns (FundingState memory);
    /// @notice State as if updateFunding() were called now.
    function previewFundingState() external view returns (FundingState memory);
    function markPrice() external view returns (uint256 priceWad);
    function indexPrice() external view returns (uint256 priceWad);
    function getPosition(address account) external view returns (Position memory);
    function getAccount(address account) external view returns (AccountView memory);
    function isLiquidatable(address account) external view returns (bool);
    /// @return longOI sum of long sizes (WAD) @return shortOI sum of |short sizes| (WAD). Always equal.
    function openInterest() external view returns (uint256 longOI, uint256 shortOI);
    function accruedFees() external view returns (uint256 amountWad);
    function totalBadDebt() external view returns (uint256 amountWad);
}
