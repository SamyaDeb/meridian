// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {RiskParams, FundingParams, SwapParams, VaultParams} from "../src/interfaces/PulseTypes.sol";

/// @notice Shared config loading for the deploy scripts. Reads `script/config/<chainid>.json`
///         (addresses from ARCHITECTURE §0, params from MATH_SPEC; WAD values are decimal strings).
abstract contract DeployBase is Script {
    using stdJson for string;

    string internal cfg;

    function _loadConfig() internal {
        cfg = vm.readFile(string.concat(vm.projectRoot(), "/script/config/", vm.toString(block.chainid), ".json"));
        require(cfg.readUint(".chainId") == block.chainid, "config chainId mismatch");
    }

    function _deploymentsPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json");
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
}
