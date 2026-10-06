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

    // ─── CR-014 (interfaces-v1.7): async withdrawals beyond idle, routed exits, emergency unwind ───────────────
    /// @notice Pending: shares escrowed in the vault (still in totalSupply). Claimable: priced and paid into
    ///         `claimableAssets`, waiting for `claimRedeem`. Claimed / Cancelled: final.
    enum RedeemStatus {
        Pending,
        Claimable,
        Claimed,
        Cancelled
    }

    /// @notice One redemption request. `assets` (AUSD token units) is 0 until fulfilment, then the fixed payout.
    ///         An id whose `owner` is address(0) does not exist.
    struct RedeemRequest {
        address owner;
        uint64 requestedBlock;
        RedeemStatus status;
        address receiver;
        uint128 shares;
        uint128 assets;
    }

    event RedeemRequested(uint256 indexed id, address indexed owner, address receiver, uint256 shares);
    event RedeemCancelled(uint256 indexed id);
    /// @param unwindCost this request's pro-rata share of the batch's unwind cost (NAV lost), AUSD token units
    event RedeemFulfilled(uint256 indexed id, uint256 assets, uint256 unwindCost);
    event RedeemClaimed(uint256 indexed id, address indexed receiver, uint256 assets);
    event EmergencyUnwind(uint256 baseSold, uint256 perpBought, uint256 navAfter);

    error RequestNotFound();
    error NotRequestOwner();
    /// @notice previewRedeem(shares) of one request exceeds `maxSliceAssets` (split it).
    error RequestTooLarge();
    /// @notice A forced keeper path ran less than MIN_FORCED_INTERVAL_BLOCKS after the last rebalance (A-09).
    error CooldownActive();

    /// @notice Escrow `shares` of `owner` (ERC-4626 allowance rules when msg.sender ≠ owner) for an async
    ///         redemption beyond idle. The shares keep NAV exposure until fulfilment (priced then).
    function requestRedeem(uint256 shares, address receiver, address owner) external returns (uint256 id);
    /// @notice Owner only, Pending only: the escrowed shares go back to the owner.
    function cancelRedeem(uint256 id) external;
    /// @notice Keeper: price the Pending ids among `ids` (≤ MAX_BATCH; others are skipped) at the current NAV, unwind
    ///         a pro-rata slice of both legs through `spotRoute` if idle can't pay them, burn their shares and move
    ///         the payout into `claimableAssets`. The unwind cost is charged to this batch.
    function fulfillRedeems(uint256[] calldata ids, bytes calldata spotRoute) external;
    /// @notice Anyone: pay a Claimable request to its receiver (pull pattern).
    function claimRedeem(uint256 id) external returns (uint256 assets);
    /// @notice Keeper: forced exit of one slice with a Kuru Flow route (cooldown, A-09).
    function exitHedgeWithRoute(bytes calldata spotRoute) external;
    /// @notice Owner (Safe): buy back ≤ maxBase of the short (reduce-only), sell the same spot through `spotRoute`,
    ///         withdraw the perp collateral once flat, and clear the entered state. No cooldown; works while entered.
    function emergencyUnwind(uint256 maxBase, bytes calldata spotRoute) external;
    /// @notice Shares escrowed by Pending requests (included in totalSupply).
    function pendingRedeemShares() external view returns (uint256);
    /// @notice AUSD (token units) owed to Claimable requests; held by the vault, excluded from totalAssets().
    function claimableAssets() external view returns (uint256);
    /// @notice Reverts RequestNotFound for an unknown id.
    function getRedeemRequest(uint256 id) external view returns (RedeemRequest memory);
    /// @notice What `fulfillRedeems(ids, ·)` would do now: total payout before the unwind cost (AUSD token units)
    ///         and the spot base it would sell (WAD; 0 when idle covers the batch). For quoting the route (A-13).
    ///         Duplicate ids are counted once.
    function previewFulfill(uint256[] calldata ids) external view returns (uint256 assets, uint256 spotToSell);

    /// @notice Keeper entrypoint. Does whatever needsRebalance() reports using the direct Kuru route.
    function rebalance() external returns (RebalanceReason reason);
    /// @notice Same, with a Kuru Flow route for the spot leg (CR-002). minOut is computed by the vault from the
    ///         oracle index ± maxSlippage, never taken from the keeper.
    function rebalanceWithRoute(bytes calldata spotRoute) external returns (RebalanceReason reason);
    /// @notice Current cap on the vault's short from the skew rule, base WAD.
    function shortCapacity() external view returns (uint256 baseWad);
    /// @notice Forced exit / entry of one slice (keeper, empty route). CR-014: cooldown (CooldownActive).
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
