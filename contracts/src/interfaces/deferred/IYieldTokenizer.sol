// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// DEFERRED (CR-003, 29 Sep 2026): PT/YT is out of hackathon scope, replaced by IFundingSwapMarket. Kept for post-hackathon.
/// @title IYieldTokenizer — splits MeridianVault shares into PT + YT for one maturity (FROZEN)
/// @notice Index I = vault.convertToAssets(1e18 shares) scaled to WAD (asset per share).
///         Minting s shares at index I yields s*I PT and s*I YT (asset units, 18 dp): "1 share = 1 PT + 1 YT"
///         in value terms at I = 1. YT accrues yield only above the high-water mark (loss waterfall).
///         See docs/MATH_SPEC.md §6.
interface IYieldTokenizer {
    event Minted(address indexed user, address indexed to, uint256 shares, uint256 ptYtAmount, uint256 indexWad);
    event Redeemed(address indexed user, address indexed to, uint256 ptYtAmount, uint256 shares);
    event PrincipalRedeemed(address indexed user, address indexed to, uint256 ptAmount, uint256 shares);
    event YieldClaimed(address indexed user, address indexed to, uint256 shares, uint256 indexWad);
    event IndexUpdated(uint256 indexWad, uint256 highWaterMarkWad);
    event MaturitySettled(uint256 indexAtMaturityWad, uint256 sharesPerPtWad);

    error Matured();
    error NotMatured();
    error OnlyYieldToken();
    error ZeroAmount();

    function mint(uint256 shares, address to) external returns (uint256 ptYtAmount);
    /// @notice Pre-maturity: burn equal PT + YT, get shares back (also claims pending yield).
    function redeem(uint256 ptYtAmount, address to) external returns (uint256 shares);
    /// @notice Post-maturity: burn PT for shares at sharesPerPt (= 1 / max(I_mat, HWM)), see MATH_SPEC §6.
    function redeemPrincipal(uint256 ptAmount, address to) external returns (uint256 shares);
    function claimYield(address to) external returns (uint256 shares);
    /// @notice Freezes the maturity index. Callable by anyone once block.timestamp >= maturity.
    function settleMaturity() external;
    /// @notice YT hook, onlyYieldToken.
    function onYieldTokenTransfer(address from, address to) external;

    function vault() external view returns (address);
    function principalToken() external view returns (address);
    function yieldToken() external view returns (address);
    function maturity() external view returns (uint256);
    function isMatured() external view returns (bool);
    function currentIndex() external view returns (uint256 indexWad);
    function highWaterMark() external view returns (uint256 indexWad);
    function pendingYield(address user) external view returns (uint256 shares);
    /// @notice shares paid per 1e18 PT at maturity (0 before settleMaturity), WAD
    function sharesPerPrincipal() external view returns (uint256 wad);
    /// @notice UI helper: implied APR from a PT price in AUSD (WAD). implied = (1/p)^(365d/left) - 1
    function impliedApr(uint256 ptPriceWad) external view returns (uint256 aprWad);
}
