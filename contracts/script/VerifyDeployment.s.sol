// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {DeployBase} from "./DeployBase.s.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IClearingHouse} from "../src/interfaces/IClearingHouse.sol";
import {IOracleAdapter} from "../src/interfaces/IOracleAdapter.sol";
import {IInsuranceFund} from "../src/interfaces/IInsuranceFund.sol";
import {IMarketFactory} from "../src/interfaces/IMarketFactory.sol";
import {IPulseVault} from "../src/interfaces/IPulseVault.sol";
import {IFundingSwapMarket} from "../src/interfaces/IFundingSwapMarket.sol";
import {PulseVault} from "../src/vault/PulseVault.sol";
import {KuruHedger} from "../src/vault/KuruHedger.sol";
import {ClearingHouse} from "../src/clearing/ClearingHouse.sol";
import {FundingSwapMarket} from "../src/swaps/FundingSwapMarket.sol";
import {PythChainlinkOracleAdapter} from "../src/oracle/PythChainlinkOracleAdapter.sol";
import {RiskParams, VaultParams, SwapParams} from "../src/interfaces/PulseTypes.sol";

/// @notice READ-ONLY post-deploy check of a DeployPulse record against `script/config/<chainid>.json` (Phase 3 P2;
///         mainnet day step "verify"). Never broadcasts. Checks: every Ownable's owner = EXPECTED_OWNER (the Safe; on
///         a fork the labelled stand-in) and ≠ the deployer; the deployer holds no vault role; the keeper and the MM
///         are registered as decided (vault keeper; skew provider, PHASES decision 11); caps and params equal the
///         config; the vault is idle (skewCapacity 0, decision 17); wiring (CH↔OB, swap↔OB, IF authorisations,
///         factory registry); not paused; the oracle returns a fresh live price.
///   DEPLOYMENTS_FILE=dry-run/143-fork.json EXPECTED_OWNER=0x… DEPLOYER_ADDRESS=0x… KEEPER_ADDRESS=0x… MM_ADDRESS=0x… \
///     forge script script/VerifyDeployment.s.sol --rpc-url <rpc>
///   Prints one PASS/FAIL line per check and reverts at the end if any check failed.
contract VerifyDeployment is DeployBase {
    using stdJson for string;

    uint256 internal failures;
    uint256 internal passes;

    function _check(bool ok, string memory what) internal {
        if (ok) {
            passes++;
            console2.log("PASS", what);
        } else {
            failures++;
            console2.log("FAIL", what);
        }
    }

    struct Addrs {
        address owner;
        address deployer;
        address keeper;
        address mm;
        address ch;
        address ob;
        address oracle;
        address fund;
        address factory;
        address vault;
        address hedger;
        address swap;
        address sob;
        string symbol;
    }

    Addrs internal x;

    function run() external {
        require(!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast), "VerifyDeployment is read-only: never --broadcast");
        _loadConfig();
        string memory dep = vm.readFile(
            string.concat(vm.projectRoot(), "/../deployments/", vm.envOr("DEPLOYMENTS_FILE", string("143.json")))
        );
        require(dep.readUint(".chainId") == block.chainid, "deployments file is for another chain");
        x.owner = vm.envAddress("EXPECTED_OWNER");
        x.deployer = vm.envAddress("DEPLOYER_ADDRESS");
        x.keeper = vm.envAddress("KEEPER_ADDRESS");
        x.mm = vm.envAddress("MM_ADDRESS");
        require(
            x.owner != address(0) && x.owner != x.deployer, "EXPECTED_OWNER must be set and differ from the deployer"
        );
        x.ch = dep.readAddress(".contracts.ClearingHouse");
        x.ob = dep.readAddress(".contracts.OrderBook");
        x.oracle = dep.readAddress(".contracts.OracleAdapter");
        x.fund = dep.readAddress(".contracts.InsuranceFund");
        x.factory = dep.readAddress(".contracts.MarketFactory");
        x.vault = dep.readAddress(".contracts.PulseVault");
        x.hedger = dep.readAddress(".contracts.KuruHedger");
        x.swap = dep.readAddress(".contracts.FundingSwapMarket");
        x.sob = dep.readAddress(".contracts.SwapOrderBook");
        x.symbol = dep.readString(".symbol");
        console2.log("chain / block", block.chainid, block.number);
        console2.log("expected owner", x.owner);

        _ownership();
        _roles();
        _wiring();
        _params();
        _oracle();

        console2.log("checks passed / failed", passes, failures);
        require(failures == 0, "VerifyDeployment: FAILED");
    }

    /// @dev 7 Ownables → the Safe; the OrderBooks have no owner.
    function _ownership() internal {
        address[7] memory owned = [x.fund, x.factory, x.oracle, x.ch, x.swap, x.vault, x.hedger];
        string[7] memory names = [
            "InsuranceFund",
            "MarketFactory",
            "OracleAdapter",
            "ClearingHouse",
            "FundingSwapMarket",
            "PulseVault",
            "KuruHedger"
        ];
        for (uint256 i; i < owned.length; ++i) {
            _check(owned[i].code.length > 0, string.concat(names[i], " has code"));
            _check(Ownable(owned[i]).owner() == x.owner, string.concat(names[i], ".owner() == expected owner"));
        }
        _check(x.ob.code.length > 0 && x.sob.code.length > 0, "both OrderBooks have code (no owner by design)");
    }

    /// @dev The deployer holds no role; keeper + MM as decided (decision 11).
    function _roles() internal {
        PulseVault v = PulseVault(x.vault);
        _check(!v.isKeeper(x.deployer), "deployer is not a vault keeper");
        _check(v.isKeeper(x.keeper), "KEEPER_ADDRESS is a vault keeper");
        _check(v.skewProviders(0) == x.mm, "MM_ADDRESS is skew provider #0 (decision 11)");
        try v.skewProviders(1) returns (address extra) {
            _check(extra == address(0), "exactly one skew provider");
        } catch {
            _check(true, "exactly one skew provider");
        }
        _check(KuruHedger(payable(x.hedger)).vault() == x.vault, "hedger.vault() == vault (one-shot)");
    }

    function _wiring() internal {
        _check(IClearingHouse(x.ch).orderBook() == x.ob, "CH.orderBook() == OB");
        _check(IFundingSwapMarket(x.swap).orderBook() == x.sob, "swap.orderBook() == swap OB");
        _check(IInsuranceFund(x.fund).isAuthorized(x.ch), "IF authorises the perp CH");
        _check(IInsuranceFund(x.fund).isAuthorized(x.swap), "IF authorises the swap market");
        IMarketFactory.Market memory m = IMarketFactory(x.factory).getMarket(keccak256(bytes(x.symbol)));
        _check(
            m.clearingHouse == x.ch && m.orderBook == x.ob && m.oracle == x.oracle && m.active,
            "factory registry: MON-PERP"
        );
        _check(!ClearingHouse(x.ch).paused(), "CH not paused");
    }

    /// @dev Caps and params == config; the vault is idle (decision 17).
    function _params() internal {
        RiskParams memory r = IClearingHouse(x.ch).riskParams();
        RiskParams memory rc = _riskParams();
        _check(r.maxPositionSize == rc.maxPositionSize && r.maxPositionSize > 0, "perp maxPositionSize == config");
        _check(r.maxOpenInterest == rc.maxOpenInterest && r.maxOpenInterest > 0, "perp maxOpenInterest == config");
        _check(keccak256(abi.encode(r)) == keccak256(abi.encode(rc)), "perp RiskParams == config (all fields)");
        _check(
            keccak256(abi.encode(IClearingHouse(x.ch).fundingParams())) == keccak256(abi.encode(_fundingParams())),
            "perp FundingParams == config (all fields)"
        );
        PulseVault v = PulseVault(x.vault);
        VaultParams memory vp = v.vaultParams();
        _check(vp.depositCap == _vaultParams().depositCap, "vault depositCap == config");
        _check(vp.skewCapacity == 0, "vault skewCapacity == 0 (idle launch, decision 17)");
        _check(keccak256(abi.encode(vp)) == keccak256(abi.encode(_vaultParams())), "VaultParams == config (all fields)");
        _check(v.shortCapacity() == 0, "vault shortCapacity() == 0 (cannot hedge)");
        _check(uint8(v.needsRebalance()) == uint8(IPulseVault.RebalanceReason.None), "vault needsRebalance() == None");
        SwapParams memory sp = IFundingSwapMarket(x.swap).swapParams();
        _check(keccak256(abi.encode(sp)) == keccak256(abi.encode(_swapParams())), "SwapParams == config (all fields)");
        uint256 mat = IFundingSwapMarket(x.swap).maturity();
        _check(mat > block.timestamp && mat <= block.timestamp + 30 days, "swap maturity within 30 d of now");
        console2.log("swap maturity (unix s)", mat);
        _check(
            FundingSwapMarket(x.swap).MARK_MAX_STEP_PER_BLOCK() == 0.005e18,
            "swap mark bound 0.5 pt/block (decision 18)"
        );
    }

    /// @dev Oracle params == config and a fresh live price.
    function _oracle() internal {
        PythChainlinkOracleAdapter a = PythChainlinkOracleAdapter(x.oracle);
        _check(a.maxStaleness() == cfg.readUint(".params.oracle.maxStalenessSec"), "oracle maxStaleness == config");
        _check(a.maxDeviation() == _u(".params.oracle.maxDeviationWad"), "oracle maxDeviation == config");
        _check(address(a.pyth()) == cfg.readAddress(".pyth.contract"), "oracle Pyth == config (R12)");
        _check(a.priceId() == cfg.readBytes32(".pyth.monUsdFeedId"), "oracle feed id == config (R12)");
        _check(
            address(a.secondary()) == cfg.readAddress(".chainlink.monUsd"), "oracle guard == Chainlink MON/USD (R11)"
        );
        (bool ok, uint256 px, uint256 at) = IOracleAdapter(x.oracle).tryGetIndexPrice();
        _check(ok && px > 0, "oracle returns a fresh price (tryGetIndexPrice ok)");
        console2.log(
            "index price (WAD) / publish time / age s", px, at, block.timestamp > at ? block.timestamp - at : 0
        );
    }
}
