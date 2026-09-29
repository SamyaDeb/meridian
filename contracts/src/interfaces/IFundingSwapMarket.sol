// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SwapParams, SwapPosition, SwapAccountView} from "./PulseTypes.sol";
import {IMarginEngine} from "./IMarginEngine.sol";

/// @title IFundingSwapMarket — fixed-for-floating MON-PERP funding swaps, one maturity (FROZEN, CR-003)
/// @notice The "fix it" layer. Long = receive floating perp funding, pay a fixed APR. Short = the reverse.
///         Traded on its own IOrderBook instance where price = 1 + fixed APR (WAD); size = MON notional units.
///         Accrues per block in O(1) from the perp ClearingHouse's two indices (IFundingRateOracle):
///           floating received by a long = size * ΔF
///           fixed paid by a long        = fixedAprNotional * ΔG / SECONDS_PER_YEAR
///         Fill rule: settle both sides, then size += Δq and fixedAprNotional += Δq * apr (never reduced
///         proportionally) ⇒ Σsize = 0 and ΣK = 0 ⇒ accrual conserves exactly (MATH_SPEC §6.2).
///         Settlement is lazy on touch. After maturity, accrual stops at the maturity snapshot (settleMaturity).
///         Margin covers worst-case funding over liqHorizon + an implied-APR shock (MATH_SPEC §6).
interface IFundingSwapMarket is IMarginEngine {
    event Deposited(address indexed account, uint256 amountToken, uint256 amountWad);
    event Withdrawn(address indexed account, uint256 amountToken, uint256 amountWad);
    /// @param aprWad fixed APR of this fill (price - 1e18)
    event SwapPositionChanged(
        address indexed account,
        int256 sizeDelta,
        int256 newSize,
        int256 aprWad,
        int256 realizedPnl,
        int256 fee,
        bool isMaker
    );
    /// @param net floating received - fixed paid (quote WAD, + = credited to account)
    event SwapAccrualSettled(address indexed account, int256 floatingLeg, int256 fixedLeg, int256 net);
    event SwapLiquidated(
        address indexed account,
        address indexed liquidator,
        int256 sizeTransferred,
        int256 markAprWad,
        uint256 penalty,
        uint256 keeperReward,
        uint256 toInsurance,
        uint256 badDebt
    );
    event MaturitySettled(int256 cumFundingAtMaturity, int256 cumIndexTimeAtMaturity, uint64 blockNumber);
    event SwapParamsUpdated(SwapParams params);

    error Matured();
    error NotMatured();
    error NotLiquidatable();
    error PositionCapExceeded();
    error OpenInterestCapExceeded();
    error ZeroAmount();
    error AlreadyInitialized();
    error Paused();

    // ─── Collateral (AUSD, same units as IClearingHouse) ────────────────────────
    function deposit(uint256 amountToken) external;
    function depositFor(address account, uint256 amountToken) external;
    function withdraw(uint256 amountToken) external;

    // ─── Accrual / lifecycle ────────────────────────────────────────────────────
    function settle(address account) external;
    /// @notice Callable by anyone once block.timestamp >= maturity; snapshots perp F and G. Idempotent.
    function settleMaturity() external;
    /// @notice Liquidator takes over x ≤ maxSizeWad and K·x/size, with an equal-and-opposite cash transfer of the
    ///         position value at markApr, then the penalty (MATH_SPEC §6.4).
    function liquidate(address account, uint256 maxSizeWad) external returns (int256 sizeTransferred);

    // ─── Admin ──────────────────────────────────────────────────────────────────
    function setOrderBook(address orderBook) external;
    function setSwapParams(SwapParams calldata params) external;
    function setPaused(bool paused) external;
    function collectFees(address to) external returns (uint256 amountToken);

    // ─── Views ──────────────────────────────────────────────────────────────────
    function perpClearingHouse() external view returns (address);
    function collateralToken() external view returns (address);
    function insuranceFund() external view returns (address);
    function maturity() external view returns (uint256 timestamp);
    function isMatured() external view returns (bool);
    function swapParams() external view returns (SwapParams memory);
    /// @notice Median of (book mid, last trade, trailing 8h realized funding APR), clamped. WAD, signed.
    function markApr() external view returns (int256 aprWad);
    /// @notice Trailing realized funding APR from the perp oracle (the "floating" reference shown in the UI).
    function realizedApr(uint64 blocksAgo) external view returns (int256 aprWad);
    function timeToMaturity() external view returns (uint256 sec);
    function getPosition(address account) external view returns (SwapPosition memory);
    function getAccount(address account) external view returns (SwapAccountView memory);
    function isLiquidatable(address account) external view returns (bool);
    function openInterest() external view returns (uint256 longOI, uint256 shortOI);
}
