// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPulseVault} from "../interfaces/IPulseVault.sol";
import {VaultParams, HedgeState} from "../interfaces/PulseTypes.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Plain ERC-4626 over a MockERC20 with no strategy. Simulate yield with mockGain / mockLoss.
///         Used by WS-05 (tokenizer), WS-06/07 before the real vault lands. Decimals offset 12 (18-dp shares).
contract MockPulseVault is ERC4626, IPulseVault {
    VaultParams internal _params;

    constructor(address asset_) ERC20("Pulse Vault Share (mock)", "pvAUSD") ERC4626(IERC20(asset_)) {}

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
