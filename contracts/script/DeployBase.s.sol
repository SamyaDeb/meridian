// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {RiskParams, FundingParams, SwapParams, VaultParams} from "../src/interfaces/MeridianTypes.sol";

/// @notice Shared config loading for the deploy scripts. Reads `script/config/<chainid>.json`
///         (addresses from ARCHITECTURE §0, params from MATH_SPEC; WAD values are decimal strings).
abstract contract DeployBase is Script {
    using stdJson for string;

    string internal cfg;

    /// @dev `DEPLOY_CONFIG` (a path under script/config/, e.g. "tmp/143-test.json") replaces `<chainid>.json` for
    ///      fork tests and rehearsals only: it is refused in a real broadcast to mainnet (143).
    function _loadConfig() internal {
        string memory alt = vm.envOr("DEPLOY_CONFIG", string(""));
        if (bytes(alt).length != 0) {
            require(
                block.chainid != 143 || !vm.isContext(VmSafe.ForgeContext.ScriptBroadcast),
                "DEPLOY_CONFIG is refused in a mainnet broadcast"
            );
        } else {
            alt = string.concat(vm.toString(block.chainid), ".json");
        }
        cfg = vm.readFile(string.concat(vm.projectRoot(), "/script/config/", alt));
        require(cfg.readUint(".chainId") == block.chainid, "config chainId mismatch");
    }

    /// @dev `DEPLOYMENTS_OUT` (a file name under ../deployments, e.g. "anvil-10143.json") keeps a local rehearsal on
    ///      a chain-id-10143 anvil from overwriting the real testnet record deployments/10143.json.
    function _deploymentsPath() internal view returns (string memory) {
        string memory name = vm.envOr("DEPLOYMENTS_OUT", string.concat(vm.toString(block.chainid), ".json"));
        return string.concat(vm.projectRoot(), "/../deployments/", name);
    }

    /// @dev Address at `key`, or address(0) when the key is absent or JSON `null` (the config's "VERIFY" marker).
    function _optAddress(string memory key) internal view returns (address) {
        if (!vm.keyExistsJson(cfg, key)) return address(0);
        bytes memory raw = vm.parseJson(cfg, key);
        if (raw.length != 32) return address(0);
        return abi.decode(raw, (address));
    }

    /// @dev Unsigned number at `key`, or 0 when the key is absent or JSON `null`.
    function _optUint(string memory key) internal view returns (uint256) {
        if (!vm.keyExistsJson(cfg, key)) return 0;
        bytes memory raw = vm.parseJson(cfg, key);
        if (raw.length != 32) return 0;
        return abi.decode(raw, (uint256));
    }

    function _u(string memory key) internal view returns (uint256) {
        return vm.parseUint(cfg.readString(key));
    }

    function _i(string memory key) internal view returns (int256) {
        return vm.parseInt(cfg.readString(key));
    }

    function _riskParams() internal view returns (RiskParams memory p) {
        string memory k = ".params.perp.risk.";
        p.imr = _u(string.concat(k, "imr"));
        p.mmr = _u(string.concat(k, "mmr"));
        p.takerFee = _u(string.concat(k, "takerFee"));
        p.makerFee = _i(string.concat(k, "makerFee"));
        p.liqPenalty = _u(string.concat(k, "liqPenalty"));
        p.keeperShare = _u(string.concat(k, "keeperShare"));
        p.maxOpenInterest = _u(string.concat(k, "maxOpenInterest"));
        p.maxPositionSize = _u(string.concat(k, "maxPositionSize"));
    }

    function _fundingParams() internal view returns (FundingParams memory p) {
        string memory k = ".params.perp.funding.";
        p.alpha = _u(string.concat(k, "alpha"));
        p.interestRate = _i(string.concat(k, "interestRate"));
        p.rateCap = _u(string.concat(k, "rateCap"));
        p.maxRateChangePerBlock = _u(string.concat(k, "maxRateChangePerBlock"));
        p.blockTimeMs = cfg.readUint(string.concat(k, "blockTimeMs"));
        p.premiumBandWad = _u(string.concat(k, "premiumBandWad"));
    }

    function _swapParams() internal view returns (SwapParams memory p) {
        string memory k = ".params.swap.params.";
        p.aprMoveBuffer = _u(string.concat(k, "aprMoveBuffer"));
        p.liqHorizonSec = cfg.readUint(string.concat(k, "liqHorizonSec"));
        p.imMultiplier = _u(string.concat(k, "imMultiplier"));
        p.takerFeeApr = _u(string.concat(k, "takerFeeApr"));
        p.makerFeeApr = _i(string.concat(k, "makerFeeApr"));
        p.liqPenalty = _u(string.concat(k, "liqPenalty"));
        p.keeperShare = _u(string.concat(k, "keeperShare"));
        p.maxOpenInterest = _u(string.concat(k, "maxOpenInterest"));
        p.maxPositionSize = _u(string.concat(k, "maxPositionSize"));
    }

    function _vaultParams() internal view returns (VaultParams memory p) {
        string memory k = ".params.vault.";
        p.leverage = _u(string.concat(k, "leverage"));
        p.driftBand = _u(string.concat(k, "driftBand"));
        p.targetMarginRatio = _u(string.concat(k, "targetMarginRatio"));
        p.minMarginRatio = _u(string.concat(k, "minMarginRatio"));
        p.exitHorizonSec = cfg.readUint(string.concat(k, "exitHorizonSec"));
        p.roundTripFee = _u(string.concat(k, "roundTripFee"));
        p.maxSlippage = _u(string.concat(k, "maxSlippage"));
        p.idleBuffer = _u(string.concat(k, "idleBuffer"));
        p.depositCap = _u(string.concat(k, "depositCap"));
        p.skewCapacity = _u(string.concat(k, "skewCapacity"));
        p.entryHorizonSec = cfg.readUint(string.concat(k, "entryHorizonSec"));
        p.maxSliceAssets = _u(string.concat(k, "maxSliceAssets"));
    }

    /// @dev Vault v2 at deploy (HARDENING_PLAN P5.3i, HARDENING_LOOP Found #17): the config's params with the hedge off
    ///      (`skewCapacity` 0) and the launch cap (`depositCap` 1,200 AUSD, PHASES decision 12) on every chain. The
    ///      owner raises skewCapacity later with `setVaultParams` (P6 step 3).
    function _vaultV2DeployParams() internal view returns (VaultParams memory p) {
        p = _vaultParams();
        p.skewCapacity = 0;
        p.depositCap = 1200e6;
    }
}
