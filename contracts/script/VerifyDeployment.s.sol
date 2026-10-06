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
import {IMarginEngine} from "../src/interfaces/IMarginEngine.sol";
import {IOrderBook} from "../src/interfaces/IOrderBook.sol";
import {IMeridianVault} from "../src/interfaces/IMeridianVault.sol";
import {IFundingSwapMarket} from "../src/interfaces/IFundingSwapMarket.sol";
import {MeridianVault} from "../src/vault/MeridianVault.sol";
import {KuruHedger} from "../src/vault/KuruHedger.sol";
import {ClearingHouse} from "../src/clearing/ClearingHouse.sol";
import {FundingSwapMarket} from "../src/swaps/FundingSwapMarket.sol";
import {PythChainlinkOracleAdapter} from "../src/oracle/PythChainlinkOracleAdapter.sol";
import {TestnetKeeperOracle} from "../src/oracle/TestnetKeeperOracle.sol";
import {RiskParams, VaultParams, SwapParams} from "../src/interfaces/MeridianTypes.sol";

/// @notice READ-ONLY post-deploy check of a DeployMeridian record against `script/config/<chainid>.json` (Phase 3 P2;
///         mainnet day step "verify"; testnet relaunch P4.5). Never broadcasts. Checks: every Ownable's owner =
///         EXPECTED_OWNER (mainnet: the Safe, never the deployer; on a fork the labelled stand-in; testnet with
///         `ownerIsDeployer`: the deployer); the deployer holds no vault role; the keeper and the MM are registered as
///         decided (vault keeper; skew provider, PHASES decision 11); caps and params equal the config; the vault is
///         idle (skewCapacity 0, decision 17); wiring (CH↔OB, swap↔OB, IF authorisations, factory registry); not
///         paused; the oracle returns a fresh live price; the labelled demo market (testnet) is wired and keeper-fed.
///         Vault and swaps are checked only when the record lists them (testnet relaunch P4.5: no vault).
///         Hardening (P4.4): the P2 mark premium bound (10 bps per block, credited for ≤ 20 blocks) and CR-007
///         (`MakerFillSkipped` in every book's bytecode; a paused engine answers Skip) are checked by BEHAVIOUR on the
///         deployed bytecode, in this script's local simulation only (mocked oracle/book views, pranked owner/book,
///         state snapshot reverted): nothing reaches the chain.
///   DEPLOYMENTS_FILE=dry-run/143-fork.json EXPECTED_OWNER=0x… DEPLOYER_ADDRESS=0x… KEEPER_ADDRESS=0x… MM_ADDRESS=0x… \
///     forge script script/VerifyDeployment.s.sol --rpc-url <rpc>
///   Prints one PASS/FAIL line per check and reverts at the end if any check failed.
contract VerifyDeployment is DeployBase {
    using stdJson for string;

    uint256 internal constant MAINNET = 143;
    /// @dev P2 (MarkPriceLib, PHASES 37): basis step per block (fraction of the index) and the elapsed-block cap.
    uint256 internal constant MARK_STEP = 0.001e18;
    uint256 internal constant MARK_MAX_ELAPSED = 20;

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
        address demoCh;
        address demoOb;
        address demoOracle;
        string symbol;
        string demoSymbol;
        string oracleKind;
    }

    Addrs internal x;
    string internal dep;

    function run() external {
        require(!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast), "VerifyDeployment is read-only: never --broadcast");
        _loadConfig();
        dep = vm.readFile(
            string.concat(vm.projectRoot(), "/../deployments/", vm.envOr("DEPLOYMENTS_FILE", string("143.json")))
        );
        require(dep.readUint(".chainId") == block.chainid, "deployments file is for another chain");
        x.owner = vm.envAddress("EXPECTED_OWNER");
        x.deployer = vm.envAddress("DEPLOYER_ADDRESS");
        x.keeper = vm.envAddress("KEEPER_ADDRESS");
        x.mm = vm.envAddress("MM_ADDRESS");
        // mainnet: the Safe, never the deployer; testnet with `ownerIsDeployer` (config): the deployer by design
        bool ownerMayBeDeployer = block.chainid != MAINNET && cfg.readBoolOr(".ownerIsDeployer", false);
        require(
            x.owner != address(0) && (x.owner != x.deployer || ownerMayBeDeployer),
            "EXPECTED_OWNER must be set and differ from the deployer"
        );
        x.ch = dep.readAddress(".contracts.ClearingHouse");
        x.ob = dep.readAddress(".contracts.OrderBook");
        x.oracle = dep.readAddress(".contracts.OracleAdapter");
        x.fund = dep.readAddress(".contracts.InsuranceFund");
        x.factory = dep.readAddress(".contracts.MarketFactory");
        x.vault = _optDep(".contracts.MeridianVault");
        x.hedger = _optDep(".contracts.KuruHedger");
        x.swap = _optDep(".contracts.FundingSwapMarket");
        x.sob = _optDep(".contracts.SwapOrderBook");
        x.symbol = dep.readString(".symbol");
        x.oracleKind = dep.readStringOr(".oracleKind", "pyth");
        if (vm.keyExistsJson(dep, ".demoMarket")) {
            x.demoCh = dep.readAddress(".demoMarket.ClearingHouse");
            x.demoOb = dep.readAddress(".demoMarket.OrderBook");
            x.demoOracle = dep.readAddress(".demoMarket.OracleAdapter");
            x.demoSymbol = dep.readString(".demoMarket.symbol");
        }
        console2.log("chain / block", block.chainid, block.number);
        console2.log("expected owner", x.owner);
        if (x.vault == address(0)) console2.log("SKIP vault checks: no MeridianVault in the record");
        if (x.swap == address(0)) console2.log("SKIP swap checks: no FundingSwapMarket in the record");

        _ownership();
        _roles();
        _wiring();
        _params();
        _oracle();
        _demo();
        _hardening(); // last; every simulated change is reverted to a state snapshot

        console2.log("checks passed / failed", passes, failures);
        require(failures == 0, "VerifyDeployment: FAILED");
    }

    function _optDep(string memory key) internal view returns (address) {
        return vm.keyExistsJson(dep, key) ? dep.readAddress(key) : address(0);
    }

    function _owned(address a, string memory name) internal {
        _check(a.code.length > 0, string.concat(name, " has code"));
        _check(Ownable(a).owner() == x.owner, string.concat(name, ".owner() == expected owner"));
    }

    /// @dev Ownables → the expected owner; the OrderBooks have no owner. MockKuruHedger (testnet) is not Ownable.
    function _ownership() internal {
        _owned(x.fund, "InsuranceFund");
        _owned(x.factory, "MarketFactory");
        _owned(x.oracle, "OracleAdapter");
        _owned(x.ch, "ClearingHouse");
        _check(x.ob.code.length > 0, "OrderBook has code (no owner by design)");
        if (x.swap != address(0)) {
            _owned(x.swap, "FundingSwapMarket");
            _check(x.sob.code.length > 0, "SwapOrderBook has code (no owner by design)");
        }
        if (x.vault != address(0)) {
            _owned(x.vault, "MeridianVault");
            if (_hedgerIsMock()) _check(x.hedger.code.length > 0, "KuruHedger (labelled mock) has code");
            else _owned(x.hedger, "KuruHedger");
        }
        if (x.demoCh != address(0)) {
            _owned(x.demoOracle, "demo OracleAdapter");
            _owned(x.demoCh, "demo ClearingHouse");
            _check(x.demoOb.code.length > 0, "demo OrderBook has code");
        }
    }

    function _hedgerIsMock() internal view returns (bool) {
        string[] memory mocks = dep.readStringArray(".mockContracts");
        for (uint256 i; i < mocks.length; ++i) {
            if (keccak256(bytes(mocks[i])) == keccak256("KuruHedger")) return true;
        }
        return false;
    }

    /// @dev The deployer holds no vault role; keeper + MM as decided (decision 11).
    function _roles() internal {
        if (x.vault == address(0)) return;
        MeridianVault v = MeridianVault(x.vault);
        _check(!v.isKeeper(x.deployer), "deployer is not a vault keeper");
        _check(v.isKeeper(x.keeper), "KEEPER_ADDRESS is a vault keeper");
        _check(v.skewProviders(0) == x.mm, "MM_ADDRESS is skew provider #0 (decision 11)");
        try v.skewProviders(1) returns (address extra) {
            _check(extra == address(0), "exactly one skew provider");
        } catch {
            _check(true, "exactly one skew provider");
        }
        if (!_hedgerIsMock()) {
            _check(KuruHedger(payable(x.hedger)).vault() == x.vault, "hedger.vault() == vault (one-shot)");
        }
    }

    function _wiring() internal {
        _check(IClearingHouse(x.ch).orderBook() == x.ob, "CH.orderBook() == OB");
        _check(IInsuranceFund(x.fund).isAuthorized(x.ch), "IF authorises the perp CH");
        _registry(x.symbol, x.ch, x.ob, x.oracle);
        _check(!ClearingHouse(x.ch).paused(), "CH not paused");
        if (x.swap == address(0)) return;
        _check(IFundingSwapMarket(x.swap).orderBook() == x.sob, "swap.orderBook() == swap OB");
        _check(IInsuranceFund(x.fund).isAuthorized(x.swap), "IF authorises the swap market");
        _check(!FundingSwapMarket(x.swap).paused(), "swap market not paused");
    }

    function _registry(string memory symbol, address ch, address ob, address oracle) internal {
        IMarketFactory.Market memory m = IMarketFactory(x.factory).getMarket(keccak256(bytes(symbol)));
        _check(
            m.clearingHouse == ch && m.orderBook == ob && m.oracle == oracle && m.active,
            string.concat("factory registry: ", symbol)
        );
    }

    /// @dev Caps and params == config; the vault is idle (decision 17).
    function _params() internal {
        _perpParams(x.ch, "perp");
        if (x.vault != address(0)) _vaultParamsCheck();
        if (x.swap == address(0)) return;
        SwapParams memory sp = IFundingSwapMarket(x.swap).swapParams();
        _check(keccak256(abi.encode(sp)) == keccak256(abi.encode(_swapParams())), "SwapParams == config (all fields)");
        uint256 mat = IFundingSwapMarket(x.swap).maturity();
        _check(mat > block.timestamp && mat <= block.timestamp + 30 days, "swap maturity within 30 d of now");
        console2.log("swap maturity (unix s)", mat);
        // a pre-B-01 swap market has no such constant: FAIL, don't abort the whole run
        try FundingSwapMarket(x.swap).MARK_MAX_STEP_PER_BLOCK() returns (int256 step) {
            _check(step == 0.005e18, "swap mark bound 0.5 pt/block (decision 18)");
        } catch {
            _check(false, "swap mark bound 0.5 pt/block (decision 18)");
        }
    }

    function _perpParams(address ch, string memory label) internal {
        RiskParams memory r = IClearingHouse(ch).riskParams();
        RiskParams memory rc = _riskParams();
        _check(
            r.maxPositionSize == rc.maxPositionSize && r.maxPositionSize > 0,
            string.concat(label, " maxPositionSize == config")
        );
        _check(
            r.maxOpenInterest == rc.maxOpenInterest && r.maxOpenInterest > 0,
            string.concat(label, " maxOpenInterest == config")
        );
        _check(
            keccak256(abi.encode(r)) == keccak256(abi.encode(rc)), string.concat(label, " RiskParams == config (all)")
        );
        _check(
            keccak256(abi.encode(IClearingHouse(ch).fundingParams())) == keccak256(abi.encode(_fundingParams())),
            string.concat(label, " FundingParams == config (all)")
        );
    }

    function _vaultParamsCheck() internal {
        MeridianVault v = MeridianVault(x.vault);
        VaultParams memory vp = v.vaultParams();
        if (_isVaultV2()) return _vaultV2Check(v, vp);
        _check(vp.depositCap == _vaultParams().depositCap, "vault depositCap == config");
        _check(vp.skewCapacity == 0, "vault skewCapacity == 0 (idle launch, decision 17)");
        _check(keccak256(abi.encode(vp)) == keccak256(abi.encode(_vaultParams())), "VaultParams == config (all fields)");
        _check(v.shortCapacity() == 0, "vault shortCapacity() == 0 (cannot hedge)");
        _check(
            uint8(v.needsRebalance()) == uint8(IMeridianVault.RebalanceReason.None), "vault needsRebalance() == None"
        );
    }

    /// @dev CR-014 bytecode (DeployVaultV2) answers `claimableAssets()`; a v1 vault reverts.
    function _isVaultV2() internal view returns (bool) {
        try IMeridianVault(x.vault).claimableAssets() returns (uint256) {
            return true;
        } catch {
            return false;
        }
    }

    /// @dev Vault v2 at deploy (P5.3i): config params with the hedge off and the launch cap (Found #17), an empty
    ///      queue, the A-09 cooldown, and on 143 a Flow-only hedger (no direct market: an empty route fails loudly).
    function _vaultV2Check(MeridianVault v, VaultParams memory vp) internal {
        VaultParams memory want = _vaultV2DeployParams();
        _check(vp.skewCapacity == 0, "vault v2 skewCapacity == 0 at deploy (Found #17)");
        _check(vp.depositCap == 1200e6, "vault v2 depositCap == 1,200 AUSD (decision 12)");
        _check(keccak256(abi.encode(vp)) == keccak256(abi.encode(want)), "vault v2 params == config (hedge off, cap)");
        _check(v.shortCapacity() == 0, "vault shortCapacity() == 0 (cannot hedge at deploy)");
        _check(v.claimableAssets() == 0 && v.pendingRedeemShares() == 0, "vault v2 queue empty at deploy");
        _check(v.MIN_FORCED_INTERVAL_BLOCKS() == 10, "vault v2 forced-path cooldown 10 blocks (A-09)");
        _check(v.isKeeper(x.keeper), "vault v2 keeper registered");
        if (_hedgerIsMock()) {
            _check(block.chainid != MAINNET, "mock hedger only off mainnet");
        } else {
            _check(
                KuruHedger(payable(x.hedger)).kuruMarket() == address(0), "hedger has no direct Kuru market (Flow only)"
            );
            _check(
                KuruHedger(payable(x.hedger)).flowEntrypoint() == _optAddress(".kuru.flowEntrypoint"),
                "hedger flowEntrypoint == config"
            );
        }
    }

    /// @dev Oracle params == config and a fresh live price. `pyth`: feed, Pyth contract and guard; `keeper-fed`
    ///      (testnet only): staleness / deviation == config and KEEPER_ADDRESS is a feeder.
    function _oracle() internal {
        if (keccak256(bytes(x.oracleKind)) == keccak256("keeper-fed")) {
            _keeperFed(x.oracle, "oracle");
        } else {
            PythChainlinkOracleAdapter a = PythChainlinkOracleAdapter(x.oracle);
            _check(a.maxStaleness() == cfg.readUint(".params.oracle.maxStalenessSec"), "oracle maxStaleness == config");
            _check(a.maxDeviation() == _u(".params.oracle.maxDeviationWad"), "oracle maxDeviation == config");
            _check(address(a.pyth()) == cfg.readAddress(".pyth.contract"), "oracle Pyth == config (R12)");
            _check(a.priceId() == cfg.readBytes32(".pyth.monUsdFeedId"), "oracle feed id == config (R12)");
            _check(
                address(a.secondary()) == cfg.readAddress(".chainlink.monUsd"),
                "oracle guard == Chainlink MON/USD (R11)"
            );
        }
        _fresh(x.oracle, "oracle");
    }

    function _keeperFed(address oracle, string memory label) internal {
        require(block.chainid != MAINNET, "keeper-fed oracle on mainnet");
        TestnetKeeperOracle o = TestnetKeeperOracle(oracle);
        _check(
            o.maxStaleness() == cfg.readUint(".params.oracle.keeperFedMaxStalenessSec"),
            string.concat(label, " (keeper-fed) maxStaleness == config")
        );
        _check(
            o.maxDeviation() == _u(".params.oracle.maxDeviationWad"),
            string.concat(label, " (keeper-fed) maxDeviation == config")
        );
        _check(o.isFeeder(x.keeper), string.concat(label, ": KEEPER_ADDRESS is a feeder"));
    }

    /// @dev A keeper-fed oracle is fresh only while its keeper runs: FRESH_ORACLE_OPTIONAL=1 reports a stale price
    ///      instead of failing (testnet verify right after the deploy, before the keeper starts).
    function _fresh(address oracle, string memory label) internal {
        (bool ok, uint256 px, uint256 at) = IOracleAdapter(oracle).tryGetIndexPrice();
        string memory what = string.concat(label, " returns a fresh price (tryGetIndexPrice ok)");
        if (!ok && vm.envOr("FRESH_ORACLE_OPTIONAL", false)) console2.log("INFO (not counted): stale,", what);
        else _check(ok && px > 0, what);
        console2.log(
            "index price (WAD) / publish time / age s", px, at, block.timestamp > at ? block.timestamp - at : 0
        );
    }

    /// @dev The labelled test market (testnet only): wiring, registry, IF authorisation, params, keeper-fed oracle.
    function _demo() internal {
        if (x.demoCh == address(0)) return;
        require(block.chainid != MAINNET, "demo market on mainnet");
        _check(IClearingHouse(x.demoCh).orderBook() == x.demoOb, "demo CH.orderBook() == demo OB");
        _check(IInsuranceFund(x.fund).isAuthorized(x.demoCh), "IF authorises the demo CH");
        _registry(x.demoSymbol, x.demoCh, x.demoOb, x.demoOracle);
        _check(!ClearingHouse(x.demoCh).paused(), "demo CH not paused");
        _perpParams(x.demoCh, "demo");
        _keeperFed(x.demoOracle, "demo oracle");
        _fresh(x.demoOracle, "demo oracle");
    }

    // ═══ Hardening (P2 + CR-007) by behaviour, local simulation only ════════════════════════════════════════

    function _hardening() internal {
        bytes32 topic = IOrderBook.MakerFillSkipped.selector;
        _markBound(x.ch, x.ob, x.oracle, "perp");
        _check(_hasWord(x.ob.code, topic), "CR-007: OrderBook bytecode emits MakerFillSkipped");
        _skipWhenPaused(x.ch, x.ob, x.oracle, 30_000, "perp CH");
        if (x.demoCh != address(0)) {
            _markBound(x.demoCh, x.demoOb, x.demoOracle, "demo");
            _check(_hasWord(x.demoOb.code, topic), "CR-007: demo OrderBook bytecode emits MakerFillSkipped");
            _skipWhenPaused(x.demoCh, x.demoOb, x.demoOracle, 30_000, "demo CH");
        }
        if (x.swap != address(0)) {
            _check(_hasWord(x.sob.code, topic), "CR-007: SwapOrderBook bytecode emits MakerFillSkipped");
            _skipWhenPaused(x.swap, x.sob, x.oracle, 11_200, "swap market"); // tick 11,200 = 12% APR
        }
    }

    /// @dev P2 (MATH_SPEC §2.1, PHASES 37) on the DEPLOYED ClearingHouse: oracle fresh at I (mocked); a first touch on
    ///      a neutral book fixes m0; then a book manipulated to I·1.10 (bid, ask, a fresh last trade; before P2 the mark
    ///      jumped to the band edge I·1.05 in one block) must move the next block's mark by exactly one step (10 bps),
    ///      and after a 1,000-block gap by exactly MARK_MAX_ELAPSED steps (2%). vm.mockCall / vm.roll / the touch run
    ///      in the local simulation and are reverted; nothing reaches the chain.
    function _markBound(address ch, address ob, address oracle, string memory label) internal {
        uint256 ts = IOrderBook(ob).tickSize();
        uint256 index = (0.03e18 / ts) * ts; // tick-aligned; any value works, the bound is relative to the index
        uint256 hi = index * 110 / 100;
        uint256 snap = vm.snapshotState();
        vm.mockCall(
            oracle,
            abi.encodeWithSelector(IOracleAdapter.tryGetIndexPrice.selector),
            abi.encode(true, index, block.timestamp)
        );
        _mockBook(ob, index / ts - 1, index / ts + 1, 0, 0);
        vm.roll(block.number + 1);
        IClearingHouse(ch).updateFunding();
        uint256 m0 = IClearingHouse(ch).markPrice();
        vm.roll(block.number + 1);
        _mockBook(ob, hi / ts, hi / ts + 1, hi, block.number - 1);
        uint256 m1 = IClearingHouse(ch).markPrice();
        vm.roll(block.number + 999); // 1,000 blocks since the touch: credited for at most MARK_MAX_ELAPSED
        _mockBook(ob, hi / ts, hi / ts + 1, hi, block.number - 1);
        uint256 m20 = IClearingHouse(ch).markPrice();
        vm.clearMockedCalls();
        vm.revertToStateAndDelete(snap);
        console2.log(string.concat(label, " mark (index 0.03e18): neutral / +1 block / +1,000 blocks"), m0, m1, m20);
        _check(
            _near(m1, m0 + index * MARK_STEP / 1e18),
            string.concat("P2: ", label, " mark basis moves 10 bps in one block (pre-P2: to the +5% band edge)")
        );
        _check(
            _near(m20, m0 + index * MARK_STEP * MARK_MAX_ELAPSED / 1e18),
            string.concat("P2: ", label, " mark basis credited for <= 20 blocks (2% after a 1,000-block gap)")
        );
    }

    function _mockBook(address ob, uint256 bidTick, uint256 askTick, uint256 lastPx, uint256 lastBlk) internal {
        vm.mockCall(ob, abi.encodeWithSelector(IOrderBook.bestBid.selector), abi.encode(uint32(bidTick)));
        vm.mockCall(ob, abi.encodeWithSelector(IOrderBook.bestAsk.selector), abi.encode(uint32(askTick)));
        vm.mockCall(ob, abi.encodeWithSelector(IOrderBook.lastTrade.selector), abi.encode(lastPx, uint64(lastBlk)));
    }

    /// @dev Equal up to the premium truncation (MATH_SPEC §2.1 rounds neutral): ≤ 0.1 bp of the value, far below a step.
    function _near(uint256 got, uint256 want) internal pure returns (bool) {
        uint256 d = got > want ? got - want : want - got;
        return d <= 2 + want / 1e5;
    }

    /// @dev CR-007 on the DEPLOYED engine: the owner pauses it (simulation, oracle mocked fresh so only the pause
    ///      applies) and the book (pranked) settles an increasing maker fill for a fresh account. The answer must be
    ///      Skip (2); a pre-CR-007 engine returns `false`, which decodes as 0. Reverted to a snapshot afterwards.
    function _skipWhenPaused(address engine, address book, address oracle, uint256 tick, string memory label) internal {
        uint256 snap = vm.snapshotState();
        vm.mockCall(
            oracle,
            abi.encodeWithSelector(IOracleAdapter.tryGetIndexPrice.selector),
            abi.encode(true, uint256(0.03e18), block.timestamp)
        );
        uint256 price = IOrderBook(book).tickSize() * tick; // before the prank (a call here would consume it)
        vm.prank(x.owner);
        ClearingHouse(engine).setPaused(true); // same selector on FundingSwapMarket
        bool skip;
        vm.prank(book);
        try IMarginEngine(engine).settleMakerFill(address(0xC0FFEE), true, 1000e18, price) returns (
            IMarginEngine.MakerFillResult r
        ) {
            skip = r == IMarginEngine.MakerFillResult.Skip;
        } catch {}
        vm.clearMockedCalls();
        vm.revertToStateAndDelete(snap);
        _check(skip, string.concat("CR-007: paused ", label, " answers Skip to an increasing maker fill"));
    }

    /// @dev True if `word` appears in `code` right after a PUSH32 opcode (how solc embeds an event topic).
    function _hasWord(bytes memory code, bytes32 word) internal pure returns (bool) {
        for (uint256 i; i + 33 <= code.length; ++i) {
            if (code[i] != 0x7f) continue;
            bytes32 w;
            assembly {
                w := mload(add(add(code, 0x21), i))
            }
            if (w == word) return true;
        }
        return false;
    }
}
