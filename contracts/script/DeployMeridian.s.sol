// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";
import {DeployBase} from "./DeployBase.s.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {InsuranceFund} from "../src/clearing/InsuranceFund.sol";
import {ClearingHouse} from "../src/clearing/ClearingHouse.sol";
import {MarketFactory} from "../src/clearing/MarketFactory.sol";
import {OrderBook} from "../src/orderbook/OrderBook.sol";
import {PythChainlinkOracleAdapter} from "../src/oracle/PythChainlinkOracleAdapter.sol";
import {TestnetKeeperOracle} from "../src/oracle/TestnetKeeperOracle.sol";
import {KuruHedger} from "../src/vault/KuruHedger.sol";
import {MeridianVault} from "../src/vault/MeridianVault.sol";
import {MockKuruHedger} from "../src/mocks/MockKuruHedger.sol";
import {IOracleAdapter} from "../src/interfaces/IOracleAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPythMinimal} from "../src/interfaces/external/IPythMinimal.sol";
import {AggregatorV3Interface} from "../src/interfaces/external/AggregatorV3Interface.sol";
import {FundingSwapMarket} from "../src/swaps/FundingSwapMarket.sol";

/// @notice Meridian deployment for Monad testnet (10143) and mainnet (143), ARCHITECTURE §7 order.
///   Dry-run:  forge script script/DeployMeridian.s.sol --fork-url $MONAD_TESTNET_RPC_URL --code-size-limit 131072
///   Deploy:   … --rpc-url $MONAD_TESTNET_RPC_URL --broadcast --slow --code-size-limit 131072
///   env: DEPLOYER_PK (required), KEEPER_ADDRESS (feeder of the keeper-fed oracles; optional),
///        DEPLOY_VAULT / DEPLOY_SWAPS (Phase 4, default false), DEPLOY_CRE_RECEIVER (should-tier, default false),
///        REUSE_DEPLOYMENT (a file name under deployments/, e.g. "10143.json"): keep that deployment's perp + demo market
///        (and any vault/swaps not being redeployed) and add only the requested yield layers; the merged record is
///        written to DEPLOYMENTS_OUT (default <chainid>.json). Phase 4 step 7: vault + swaps on the live testnet perp.
/// @dev Config (`script/config/<chainid>.json`):
///      - `tokens.AUSD` null ⇒ a 6-dp MockERC20 "tAUSD" (refused on mainnet).
///      - `oracle.kind`: "pyth" = PythChainlinkOracleAdapter (Chainlink guard off when `chainlink.monUsd` is null);
///        "keeper-fed" = TestnetKeeperOracle (TESTNET ONLY, its constructor refuses every chain but 10143/31337).
///      - `owner` null + `ownerIsDeployer` true ⇒ testnet owner = deployer. Mainnet requires the Safe (Ownable:
///        `transferOwnership` is immediate, so the Safe address must be right).
///      - `demoMarket.enabled` ⇒ a second, clearly labelled test market (own OB + CH + keeper-fed oracle, shared IF)
///        used only for the crash/liquidation demo, so the main market's price and parameters are never forced.
contract DeployMeridian is DeployBase {
    using stdJson for string;

    uint256 internal constant MAINNET = 143;

    struct Market {
        address oracle;
        address clearingHouse;
        address orderBook;
        string symbol;
        string oracleKind;
    }

    struct Deployed {
        address ausd;
        address wmon;
        address insuranceFund;
        address marketFactory;
        Market perp;
        Market demo;
        address hedger;
        address vault;
        address swapMarket;
        address swapOrderBook;
        address keeperReceiver;
    }

    Deployed internal d;
    address internal deployer;
    address internal owner;
    address internal keeper;
    bool internal ausdIsMock;
    bool internal hedgerIsMock;
    bool internal reusing;
    uint256 internal yieldLayersBlock; // REUSE_DEPLOYMENT: block the vault/swaps section was broadcast in

    function run() external returns (Deployed memory) {
        _loadConfig();
        uint256 pk = vm.envUint("DEPLOYER_PK");
        deployer = vm.addr(pk);
        keeper = vm.envOr("KEEPER_ADDRESS", address(0));
        owner = _optAddress(".owner");
        if (owner == address(0)) {
            require(cfg.readBoolOr(".ownerIsDeployer", false), "VERIFY: owner missing in config");
            require(block.chainid != MAINNET, "mainnet owner must be the Safe 2-of-3");
            owner = deployer;
        }
        d.wmon = cfg.readAddress(".tokens.WMON");
        d.ausd = _optAddress(".tokens.AUSD");
        require(d.wmon != address(0), "VERIFY: tokens.WMON missing in config");
        require(d.ausd != address(0) || block.chainid != MAINNET, "mainnet needs the real AUSD");

        uint256 startBlock = block.number;
        string memory reuse = vm.envOr("REUSE_DEPLOYMENT", string(""));
        reusing = bytes(reuse).length != 0;
        if (reusing) {
            yieldLayersBlock = block.number;
            startBlock = _loadExisting(reuse);
        }
        vm.startBroadcast(pk);
        if (!reusing) {
            if (d.ausd == address(0)) {
                d.ausd = address(new MockERC20("Test AUSD", "tAUSD", 6));
                ausdIsMock = true;
            }
            // 1. InsuranceFund (shared by every market) + registry
            d.insuranceFund = address(new InsuranceFund(d.ausd, deployer));
            d.marketFactory = address(new MarketFactory(deployer));
            // 2–7. the perp market
            d.perp = _deployMarket(cfg.readString(".params.perp.symbol"), cfg.readString(".params.oracle.kind"), false);
            if (cfg.readBoolOr(".demoMarket.enabled", false)) {
                require(block.chainid != MAINNET, "no test markets on mainnet");
                d.demo = _deployMarket(cfg.readString(".demoMarket.symbol"), "keeper-fed", true);
            }
        }
        // 8–9. vault (Phase 4)
        if (vm.envOr("DEPLOY_VAULT", false)) _deployVault();
        // 10–13. swaps (Phase 4)
        if (vm.envOr("DEPLOY_SWAPS", false)) _deploySwaps();
        _handOver();
        vm.stopBroadcast();
        _write(startBlock);
        _log();
        return d;
    }

    /// @dev REUSE_DEPLOYMENT: take every address of an existing record (same chain, deployed) instead of deploying the
    ///      perp. Vault / swap addresses are kept unless DEPLOY_VAULT / DEPLOY_SWAPS redeploy them. Returns its startBlock.
    function _loadExisting(string memory name) internal returns (uint256 startBlock) {
        string memory j = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/", name));
        require(j.readUint(".chainId") == block.chainid, "REUSE_DEPLOYMENT: chain id mismatch");
        require(j.readBoolOr(".deployed", false), "REUSE_DEPLOYMENT: not a broadcast deployment");
        require(j.readAddress(".owner") == deployer || block.chainid != MAINNET, "REUSE_DEPLOYMENT: owner must deploy");
        d.ausd = j.readAddress(".contracts.AUSD");
        d.wmon = j.readAddress(".contracts.WMON");
        d.insuranceFund = j.readAddress(".contracts.InsuranceFund");
        d.marketFactory = j.readAddress(".contracts.MarketFactory");
        d.perp = Market(
            j.readAddress(".contracts.OracleAdapter"),
            j.readAddress(".contracts.ClearingHouse"),
            j.readAddress(".contracts.OrderBook"),
            j.readString(".symbol"),
            j.readString(".oracleKind")
        );
        if (vm.keyExistsJson(j, ".demoMarket")) {
            d.demo = Market(
                j.readAddress(".demoMarket.OracleAdapter"),
                j.readAddress(".demoMarket.ClearingHouse"),
                j.readAddress(".demoMarket.OrderBook"),
                j.readString(".demoMarket.symbol"),
                j.readString(".demoMarket.oracleKind")
            );
        }
        if (!vm.envOr("DEPLOY_VAULT", false) && vm.keyExistsJson(j, ".contracts.MeridianVault")) {
            d.vault = j.readAddress(".contracts.MeridianVault");
            d.hedger = j.readAddress(".contracts.KuruHedger");
        }
        if (!vm.envOr("DEPLOY_SWAPS", false) && vm.keyExistsJson(j, ".contracts.FundingSwapMarket")) {
            d.swapMarket = j.readAddress(".contracts.FundingSwapMarket");
            d.swapOrderBook = j.readAddress(".contracts.SwapOrderBook");
        }
        string[] memory mocks = j.readStringArray(".mockContracts");
        for (uint256 i; i < mocks.length; ++i) {
            if (keccak256(bytes(mocks[i])) == keccak256("AUSD")) ausdIsMock = true;
            if (keccak256(bytes(mocks[i])) == keccak256("KuruHedger") && d.hedger != address(0)) hedgerIsMock = true;
        }
        startBlock = j.readUint(".startBlock");
        console.log("REUSE_DEPLOYMENT", name, "perp CH", d.perp.clearingHouse);
    }

    /// @dev IF (shared) → oracle → ClearingHouse → OrderBook → setOrderBook → IF authorisation → registry.
    function _deployMarket(string memory symbol, string memory kind, bool isTest) internal returns (Market memory m) {
        m.symbol = symbol;
        m.oracleKind = kind;
        m.oracle = _deployOracle(kind, isTest ? string.concat(symbol, " (TEST MARKET)") : "MON/USD");
        ClearingHouse ch =
            new ClearingHouse(d.ausd, m.oracle, d.insuranceFund, _riskParams(), _fundingParams(), deployer);
        OrderBook ob = new OrderBook(address(ch), _u(".params.perp.tickSizeWad"), _u(".params.perp.lotSizeWad"));
        ch.setOrderBook(address(ob));
        InsuranceFund(d.insuranceFund).setMarketAuthorized(address(ch), true);
        MarketFactory(d.marketFactory).registerMarket(symbol, address(ob), address(ch), m.oracle, d.wmon);
        m.clearingHouse = address(ch);
        m.orderBook = address(ob);
    }

    function _deployOracle(string memory kind, string memory label) internal returns (address) {
        uint256 maxDeviation = _u(".params.oracle.maxDeviationWad");
        if (keccak256(bytes(kind)) == keccak256("pyth")) {
            return address(
                new PythChainlinkOracleAdapter(
                    deployer,
                    IPythMinimal(cfg.readAddress(".pyth.contract")),
                    cfg.readBytes32(".pyth.monUsdFeedId"),
                    AggregatorV3Interface(_optAddress(".chainlink.monUsd")),
                    cfg.readUint(".params.oracle.maxStalenessSec"),
                    maxDeviation,
                    cfg.readUint(".params.oracle.chainlinkGuardStalenessSec"),
                    "MON/USD Pyth (Chainlink guard)"
                )
            );
        }
        require(keccak256(bytes(kind)) == keccak256("keeper-fed"), "oracle.kind: pyth | keeper-fed");
        TestnetKeeperOracle o = new TestnetKeeperOracle(
            deployer, cfg.readUint(".params.oracle.keeperFedMaxStalenessSec"), maxDeviation, label
        );
        o.setFeeder(deployer, true); // lets the operator seed the first price / run the demo crash by hand
        if (keeper != address(0)) o.setFeeder(keeper, true);
        return address(o);
    }

    /// @dev Steps 8–9 (Phase 4). Real KuruHedger when `kuru.flowEntrypoint` is set (mainnet: R16; `kuru.monAusdMarket`
    ///      may be null ⇒ Flow routes only). Testnet has no verified Kuru deployment ⇒ a clearly labelled
    ///      MockKuruHedger over a mock "tWMON" priced at the oracle index (refused on 143). Wiring: hedger.setVault,
    ///      keeper (`KEEPER_ADDRESS`), skew provider = the MM bot (`MM_ADDRESS`, MATH_SPEC §5.2 amendment).
    function _deployVault() internal {
        address flowEntry = _optAddress(".kuru.flowEntrypoint");
        address spotWmon = d.wmon;
        if (flowEntry == address(0)) {
            require(block.chainid != MAINNET, "VERIFY: kuru.flowEntrypoint for mainnet");
            spotWmon = address(new MockERC20("TEST Wrapped MON (vault mock)", "tWMON", 18));
            (bool ok, uint256 px,) = IOracleAdapter(d.perp.oracle).tryGetIndexPrice();
            d.hedger = address(new MockKuruHedger(spotWmon, d.ausd, ok ? px : 0.029e18));
            hedgerIsMock = true;
        } else {
            KuruHedger kh = new KuruHedger(deployer, d.wmon, d.ausd, flowEntry, _optAddress(".kuru.monAusdMarket"));
            d.hedger = address(kh);
        }
        address mmBot = vm.envOr("MM_ADDRESS", address(0));
        if (block.chainid == MAINNET) {
            // the vault needs its keeper and its skew provider at launch, and neither may be the deployer (hot keys)
            require(keeper != address(0) && mmBot != address(0), "mainnet vault: set KEEPER_ADDRESS and MM_ADDRESS");
            require(keeper != deployer && mmBot != deployer, "mainnet vault: keeper/MM must not be the deployer");
        }
        MeridianVault v = new MeridianVault(
            IERC20(d.ausd), d.perp.clearingHouse, d.perp.orderBook, d.hedger, _vaultParams(), deployer
        );
        d.vault = address(v);
        if (flowEntry != address(0)) KuruHedger(payable(d.hedger)).setVault(d.vault);
        if (keeper != address(0)) v.setKeeper(keeper, true);
        if (mmBot != address(0)) v.setSkewProvider(mmBot, true);
    }

    /// @dev Steps 10–13 (Phase 4). Maturity: now + `SWAP_MATURITY_IN_SEC` (test maturity, e.g. 3600 on testnet,
    ///      PHASES Phase 4), else `params.swap.maturity` (unix s), else now + `params.swap.maturityInSec`. Tick 1e14 = 1 bp APR, lot 1,000 MON (WS-05).
    function _deploySwaps() internal {
        uint256 inSec = vm.envOr("SWAP_MATURITY_IN_SEC", uint256(0));
        uint256 maturity = inSec != 0 ? 0 : _optUint(".params.swap.maturity");
        // MATH_SPEC §6.1: one 30-day contract from listing ⇒ config `maturityInSec` (2,592,000 on 143) from this block
        if (maturity == 0) inSec = inSec != 0 ? inSec : _optUint(".params.swap.maturityInSec");
        if (inSec != 0) maturity = block.timestamp + inSec;
        require(maturity > block.timestamp, "VERIFY: set params.swap.maturity(InSec) or SWAP_MATURITY_IN_SEC");
        FundingSwapMarket swap = new FundingSwapMarket(
            d.perp.clearingHouse, d.ausd, d.insuranceFund, uint64(maturity), _swapParams(), deployer
        );
        OrderBook sob = new OrderBook(address(swap), _u(".params.swap.tickSizeWad"), _u(".params.swap.lotSizeWad"));
        swap.setOrderBook(address(sob));
        InsuranceFund(d.insuranceFund).setMarketAuthorized(address(swap), true);
        d.swapMarket = address(swap);
        d.swapOrderBook = address(sob);
        if (vm.envOr("DEPLOY_CRE_RECEIVER", false)) {
            d.keeperReceiver = deployCode(
                "MeridianKeeperReceiver.sol:MeridianKeeperReceiver",
                abi.encode(cfg.readAddress(".cre.keystoneForwarder"))
            );
        }
    }

    /// @dev Testnet (owner = deployer): nothing to do. Mainnet: every owned contract to the Safe.
    function _handOver() internal {
        if (owner == deployer) return;
        if (reusing) {
            // the reused perp contracts were handed over by their own deploy: only what this run created
            address[3] memory fresh = [
                vm.envOr("DEPLOY_SWAPS", false) ? d.swapMarket : address(0),
                vm.envOr("DEPLOY_VAULT", false) ? d.vault : address(0),
                vm.envOr("DEPLOY_VAULT", false) && !hedgerIsMock ? d.hedger : address(0)
            ];
            for (uint256 i; i < fresh.length; ++i) {
                if (fresh[i] == address(0)) continue;
                (bool ok,) = fresh[i].call(abi.encodeWithSignature("transferOwnership(address)", owner));
                require(ok, "transferOwnership failed");
            }
            return;
        }
        address[9] memory owned = [
            d.insuranceFund,
            d.marketFactory,
            d.perp.oracle,
            d.perp.clearingHouse,
            d.demo.oracle,
            d.demo.clearingHouse,
            d.swapMarket,
            d.vault,
            hedgerIsMock ? address(0) : d.hedger // MockKuruHedger is not Ownable
        ];
        for (uint256 i; i < owned.length; ++i) {
            if (owned[i] == address(0)) continue;
            (bool ok,) = owned[i].call(abi.encodeWithSignature("transferOwnership(address)", owner));
            require(ok, "transferOwnership failed");
            require(Ownable(owned[i]).owner() == owner, "hand-over: owner not set");
        }
        // the deployer keeps no role: it is never a vault keeper on a handed-over deployment
        if (d.vault != address(0)) {
            require(!MeridianVault(d.vault).isKeeper(deployer), "hand-over: deployer is keeper");
        }
    }

    /// @dev Same keys as deployments/31337.json (consumers unchanged) + oracleKind, owner and the labelled demo market.
    function _write(uint256 startBlock) internal {
        string memory c = "contracts";
        // Only deployed contracts are written (the indexer/app treat a present key as "live").
        _ser(c, "AUSD", d.ausd);
        _ser(c, "WMON", d.wmon);
        _ser(c, "InsuranceFund", d.insuranceFund);
        _ser(c, "MarketFactory", d.marketFactory);
        _ser(c, "OracleAdapter", d.perp.oracle);
        _ser(c, "ClearingHouse", d.perp.clearingHouse);
        _ser(c, "KuruHedger", d.hedger);
        _ser(c, "MeridianVault", d.vault);
        _ser(c, "FundingSwapMarket", d.swapMarket);
        _ser(c, "SwapOrderBook", d.swapOrderBook);
        _ser(c, "MeridianKeeperReceiver", d.keeperReceiver);
        string memory contracts = c.serialize("OrderBook", d.perp.orderBook);

        string memory root = "root";
        if (d.demo.clearingHouse != address(0)) {
            string memory m = "demoMarket";
            m.serialize("symbol", d.demo.symbol);
            m.serialize("testMarket", true);
            m.serialize("_label", string("TEST MARKET: keeper-fed oracle, used only for the crash/liquidation demo"));
            m.serialize("oracleKind", d.demo.oracleKind);
            m.serialize("OracleAdapter", d.demo.oracle);
            m.serialize("ClearingHouse", d.demo.clearingHouse);
            root.serialize("demoMarket", m.serialize("OrderBook", d.demo.orderBook));
        }
        string[] memory mocks = new string[]((ausdIsMock ? 1 : 0) + (hedgerIsMock ? 1 : 0));
        if (ausdIsMock) mocks[0] = "AUSD";
        if (hedgerIsMock) mocks[mocks.length - 1] = "KuruHedger";
        root.serialize("mockContracts", mocks);
        root.serialize("chainId", block.chainid);
        root.serialize("startBlock", startBlock);
        if (yieldLayersBlock != 0) root.serialize("yieldLayersBlock", yieldLayersBlock);
        root.serialize("mocks", false);
        root.serialize("deployed", true);
        root.serialize("owner", owner);
        root.serialize("symbol", d.perp.symbol);
        root.serialize("oracleKind", d.perp.oracleKind);
        string memory out = root.serialize("contracts", contracts);
        out.write(_deploymentsPath());
    }

    function _ser(string memory obj, string memory key, address a) internal {
        if (a != address(0)) obj.serialize(key, a);
    }

    function _log() internal view {
        console.log("deployer / owner", deployer, owner);
        console.log("AUSD", d.ausd, ausdIsMock ? "(tAUSD mock)" : "");
        console.log("InsuranceFund", d.insuranceFund);
        console.log("MarketFactory", d.marketFactory);
        console.log(d.perp.symbol, d.perp.oracleKind);
        console.log("  oracle / CH / OB", d.perp.oracle, d.perp.clearingHouse, d.perp.orderBook);
        if (d.demo.clearingHouse != address(0)) {
            console.log(d.demo.symbol, "(TEST MARKET)");
            console.log("  oracle / CH / OB", d.demo.oracle, d.demo.clearingHouse, d.demo.orderBook);
        }
        console.log("ClearingHouse runtime bytes", d.perp.clearingHouse.code.length);
    }
}
