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
import {IPythMinimal} from "../src/interfaces/external/IPythMinimal.sol";
import {AggregatorV3Interface} from "../src/interfaces/external/AggregatorV3Interface.sol";
import {IInsuranceFund} from "../src/interfaces/IInsuranceFund.sol";
import {IFundingSwapMarket} from "../src/interfaces/IFundingSwapMarket.sol";

/// @notice Pulse deployment for Monad testnet (10143) and mainnet (143), ARCHITECTURE §7 order.
///   Dry-run:  forge script script/DeployPulse.s.sol --fork-url $MONAD_TESTNET_RPC_URL --code-size-limit 131072
///   Deploy:   … --rpc-url $MONAD_TESTNET_RPC_URL --broadcast --slow --code-size-limit 131072
///   env: DEPLOYER_PK (required), KEEPER_ADDRESS (feeder of the keeper-fed oracles; optional),
///        DEPLOY_VAULT / DEPLOY_SWAPS (Phase 4, default false), DEPLOY_CRE_RECEIVER (should-tier, default false).
/// @dev Config (`script/config/<chainid>.json`):
///      - `tokens.AUSD` null ⇒ a 6-dp MockERC20 "tAUSD" (refused on mainnet).
///      - `oracle.kind`: "pyth" = PythChainlinkOracleAdapter (Chainlink guard off when `chainlink.monUsd` is null);
///        "keeper-fed" = TestnetKeeperOracle (TESTNET ONLY, its constructor refuses every chain but 10143/31337).
///      - `owner` null + `ownerIsDeployer` true ⇒ testnet owner = deployer. Mainnet requires the Safe (Ownable:
///        `transferOwnership` is immediate, so the Safe address must be right).
///      - `demoMarket.enabled` ⇒ a second, clearly labelled test market (own OB + CH + keeper-fed oracle, shared IF)
///        used only for the crash/liquidation demo, so the main market's price and parameters are never forced.
contract DeployPulse is DeployBase {
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
        vm.startBroadcast(pk);
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

    /// @dev Steps 8–9, Phase 4. TODO(WS-04): constructor args once PulseVault/KuruHedger merge.
    function _deployVault() internal {
        d.hedger = deployCode(
            "KuruHedger.sol:KuruHedger",
            abi.encode(d.wmon, d.ausd, cfg.readAddress(".kuru.flowEntrypoint"), cfg.readAddress(".kuru.monAusdMarket"))
        );
        d.vault = deployCode(
            "PulseVault.sol:PulseVault", abi.encode(d.ausd, d.perp.clearingHouse, d.perp.orderBook, d.hedger)
        );
    }

    /// @dev Steps 10–13, Phase 4. TODO(WS-05): constructor args once FundingSwapMarket merges.
    function _deploySwaps() internal {
        uint256 maturity = cfg.readUintOr(".params.swap.maturity", 0);
        require(maturity > block.timestamp, "VERIFY: set params.swap.maturity");
        d.swapMarket = deployCode(
            "FundingSwapMarket.sol:FundingSwapMarket",
            abi.encode(d.perp.clearingHouse, d.ausd, d.insuranceFund, uint64(maturity), _swapParams(), deployer)
        );
        d.swapOrderBook = deployCode(
            "OrderBook.sol:OrderBook",
            abi.encode(d.swapMarket, _u(".params.swap.tickSizeWad"), _u(".params.swap.lotSizeWad"))
        );
        IFundingSwapMarket(d.swapMarket).setOrderBook(d.swapOrderBook);
        IInsuranceFund(d.insuranceFund).setMarketAuthorized(d.swapMarket, true);
        if (vm.envOr("DEPLOY_CRE_RECEIVER", false)) {
            d.keeperReceiver = deployCode(
                "PulseKeeperReceiver.sol:PulseKeeperReceiver", abi.encode(cfg.readAddress(".cre.keystoneForwarder"))
            );
        }
    }

    /// @dev Testnet (owner = deployer): nothing to do. Mainnet: every owned contract to the Safe.
    function _handOver() internal {
        if (owner == deployer) return;
        address[8] memory owned = [
            d.insuranceFund,
            d.marketFactory,
            d.perp.oracle,
            d.perp.clearingHouse,
            d.demo.oracle,
            d.demo.clearingHouse,
            d.swapMarket,
            d.vault
        ];
        for (uint256 i; i < owned.length; ++i) {
            if (owned[i] == address(0)) continue;
            (bool ok,) = owned[i].call(abi.encodeWithSignature("transferOwnership(address)", owner));
            require(ok, "transferOwnership failed");
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
        _ser(c, "PulseVault", d.vault);
        _ser(c, "FundingSwapMarket", d.swapMarket);
        _ser(c, "SwapOrderBook", d.swapOrderBook);
        _ser(c, "PulseKeeperReceiver", d.keeperReceiver);
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
        string[] memory mocks = new string[](ausdIsMock ? 1 : 0);
        if (ausdIsMock) mocks[0] = "AUSD";
        root.serialize("mockContracts", mocks);
        root.serialize("chainId", block.chainid);
        root.serialize("startBlock", startBlock);
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
