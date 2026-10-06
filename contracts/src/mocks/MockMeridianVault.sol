// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IMeridianVault} from "../interfaces/IMeridianVault.sol";
import {VaultParams, HedgeState} from "../interfaces/MeridianTypes.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Plain ERC-4626 over a MockERC20 with no strategy. Simulate yield with mockGain / mockLoss.
///         Used by WS-05 (tokenizer), WS-06/07 before the real vault lands. Decimals offset 12 (18-dp shares).
contract MockMeridianVault is ERC4626, IMeridianVault {
    VaultParams internal _params;
    // CR-014 queue: no strategy, so fulfilment just prices the escrowed shares from the balance.
    uint256 public pendingRedeemShares;
    uint256 public claimableAssets;
    uint256 internal _nextId;
    mapping(uint256 => RedeemRequest) internal _requests;

    constructor(address asset_) ERC20("Meridian Vault Share (mock)", "pvAUSD") ERC4626(IERC20(asset_)) {}

    function _decimalsOffset() internal pure override returns (uint8) {
        return 12;
    }

    function mockGain(uint256 assets) external {
        MockERC20(asset()).mint(address(this), assets);
        _snapshot();
    }

    function mockLoss(uint256 assets) external {
        MockERC20(asset()).burn(address(this), assets);
        _snapshot();
    }

    function totalAssets() public view override(ERC4626, IERC4626) returns (uint256) {
        return super.totalAssets() - claimableAssets;
    }

    function requestRedeem(uint256 shares, address receiver, address owner_) external returns (uint256 id) {
        if (msg.sender != owner_) _spendAllowance(owner_, msg.sender, shares);
        _transfer(owner_, address(this), shares);
        pendingRedeemShares += shares;
        id = ++_nextId;
        _requests[id] = RedeemRequest(owner_, uint64(block.number), RedeemStatus.Pending, receiver, uint128(shares), 0);
        emit RedeemRequested(id, owner_, receiver, shares);
    }

    function cancelRedeem(uint256 id) external {
        RedeemRequest storage r = _requests[id];
        if (r.owner == address(0)) revert RequestNotFound();
        if (r.owner != msg.sender) revert NotRequestOwner();
        if (r.status != RedeemStatus.Pending) revert NothingToDo();
        r.status = RedeemStatus.Cancelled;
        pendingRedeemShares -= r.shares;
        _transfer(address(this), r.owner, r.shares);
        emit RedeemCancelled(id);
    }

    function fulfillRedeems(uint256[] calldata ids, bytes calldata) external {
        for (uint256 i; i < ids.length; ++i) {
            RedeemRequest storage r = _requests[ids[i]];
            if (r.owner == address(0) || r.status != RedeemStatus.Pending) continue;
            uint256 assets = previewRedeem(r.shares);
            _burn(address(this), r.shares);
            pendingRedeemShares -= r.shares;
            claimableAssets += assets;
            (r.status, r.assets) = (RedeemStatus.Claimable, uint128(assets));
            emit RedeemFulfilled(ids[i], assets, 0);
        }
    }

    function claimRedeem(uint256 id) external returns (uint256 assets) {
        RedeemRequest storage r = _requests[id];
        if (r.owner == address(0)) revert RequestNotFound();
        if (r.status != RedeemStatus.Claimable) revert NothingToDo();
        r.status = RedeemStatus.Claimed;
        assets = r.assets;
        claimableAssets -= assets;
        IERC20(asset()).transfer(r.receiver, assets);
        emit RedeemClaimed(id, r.receiver, assets);
    }

    function exitHedgeWithRoute(bytes calldata) external {}
    function emergencyUnwind(uint256, bytes calldata) external {}

    function getRedeemRequest(uint256 id) external view returns (RedeemRequest memory r) {
        r = _requests[id];
        if (r.owner == address(0)) revert RequestNotFound();
    }

    function previewFulfill(uint256[] calldata ids) external view returns (uint256 assets, uint256) {
        for (uint256 i; i < ids.length; ++i) {
            RedeemRequest storage r = _requests[ids[i]];
            if (r.owner != address(0) && r.status == RedeemStatus.Pending) assets += previewRedeem(r.shares);
        }
        return (assets, 0);
    }

    function _snapshot() internal {
        emit NavSnapshot(totalAssets(), totalSupply(), sharePrice(), 0);
    }

    function rebalance() external returns (RebalanceReason) {
        _snapshot();
        return RebalanceReason.None;
    }

    function rebalanceWithRoute(bytes calldata) external returns (RebalanceReason) {
        _snapshot();
        return RebalanceReason.None;
    }

    function shortCapacity() external pure returns (uint256) {
        return 0;
    }

    function exitHedge() external {}
    function enterHedge() external {}

    function needsRebalance() external pure returns (RebalanceReason) {
        return RebalanceReason.None;
    }

    function shouldExitHedge() external pure returns (bool) {
        return false;
    }

    function hedgeState() external view returns (HedgeState memory h) {
        h.idleAssets = totalAssets();
        h.nav = totalAssets();
    }

    function sharePrice() public view returns (uint256) {
        return convertToAssets(1e18) * 1e12; // assets(6dp) per 1e18 shares, scaled to WAD
    }

    function vaultParams() external view returns (VaultParams memory) {
        return _params;
    }

    function clearingHouse() external pure returns (address) {
        return address(0);
    }

    function orderBook() external pure returns (address) {
        return address(0);
    }

    function hedger() external pure returns (address) {
        return address(0);
    }

    function setVaultParams(VaultParams calldata p) external {
        _params = p;
        emit VaultParamsUpdated(p);
    }

    function setKeeper(address keeper, bool allowed) external {
        emit KeeperUpdated(keeper, allowed);
    }
}
