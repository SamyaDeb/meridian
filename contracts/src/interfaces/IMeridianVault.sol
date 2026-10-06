// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {VaultParams, HedgeState} from "./MeridianTypes.sol";

/// @title IMeridianVault — delta-neutral funding vault, ERC-4626 over AUSD (FROZEN)
/// @notice "Skew absorber" basis vault. Deposit AUSD; keeper deploys it into spot MON (via IKuruHedger / Kuru Flow)
///         + short MON-PERP. Short size is capped by other traders' net long skew (VaultParams.skewCapacity) and
///         the hedge is only entered when funding pays for costs (MATH_SPEC §5).
///         totalAssets() = NAV in AUSD (6 dp). Shares have 18 decimals (decimals offset 12, inflation guard).
///         Deposits stay idle until the next rebalance, so a deposit never trades (sandwich-safe, cheap).
interface IMeridianVault is IERC4626 {
    enum RebalanceReason {
        None,
        Deploy, // idle above buffer
        DeltaDrift, // |netDelta| / N > driftBand
        MarginLow, // marginRatio < minMarginRatio
        ExitHedge, // smoothed funding below round-trip cost
        EnterHedge, // funding back above threshold
        Withdraw, // unwind to serve a withdrawal
        SkewCap // shrink the short because other traders' net long skew fell
    }

    event Rebalanced(
        RebalanceReason indexed reason,
        int256 spotDeltaBase,
        int256 perpDeltaBase,
        uint256 navAfter,
        uint256 sharePriceWad
    );
    event HedgeExited(uint256 navAfter);
    event HedgeEntered(uint256 navAfter);
    /// @notice Emitted on every NAV-changing op; source for the vault NAV / APY chart.
    event NavSnapshot(uint256 nav, uint256 totalShares, uint256 sharePriceWad, int256 fundingAccruedWad);
    event VaultParamsUpdated(VaultParams params);
    event KeeperUpdated(address indexed keeper, bool allowed);

    error OnlyKeeper();
    error NothingToDo();
    error SlippageExceeded();
    error DepositCapExceeded();
    /// @notice Constructor / `setVaultParams` bounds, zero addresses (CR-009, additive).
    error InvalidParams();

    /// @notice Keeper entrypoint. Does whatever needsRebalance() reports using the direct Kuru route.
    function rebalance() external returns (RebalanceReason reason);
    /// @notice Same, with a Kuru Flow route for the spot leg (CR-002). minOut is computed by the vault from the
    ///         oracle index ± maxSlippage, never taken from the keeper.
    function rebalanceWithRoute(bytes calldata spotRoute) external returns (RebalanceReason reason);
    /// @notice Current cap on the vault's short from the skew rule, base WAD.
    function shortCapacity() external view returns (uint256 baseWad);
    function exitHedge() external;
    function enterHedge() external;

    function needsRebalance() external view returns (RebalanceReason reason);
    function shouldExitHedge() external view returns (bool);
    function hedgeState() external view returns (HedgeState memory);
    /// @notice assets per 1e18 shares, WAD-scaled in asset units (1e6 AUSD per share => 1e18 at par).
    function sharePrice() external view returns (uint256);
    function vaultParams() external view returns (VaultParams memory);
    function clearingHouse() external view returns (address);
    function orderBook() external view returns (address);
    function hedger() external view returns (address);

    function setVaultParams(VaultParams calldata params) external;
    function setKeeper(address keeper, bool allowed) external;
}
