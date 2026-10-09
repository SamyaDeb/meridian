// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {DeployBase} from "./DeployBase.s.sol";
import {InsuranceFund} from "../src/clearing/InsuranceFund.sol";
import {ClearingHouse} from "../src/clearing/ClearingHouse.sol";
import {MarketFactory} from "../src/clearing/MarketFactory.sol";
import {OrderBook} from "../src/orderbook/OrderBook.sol";
import {TestnetKeeperOracle} from "../src/oracle/TestnetKeeperOracle.sol";
import {IMarketFactory} from "../src/interfaces/IMarketFactory.sol";

/// @notice K7 (PHASES decision 44): add one more perp market to an EXISTING deployment record. Standalone: no existing
///         contract changes. Config `markets.<MARKET_KEY>` (script/config/<chainid>.json) gives symbol, feed, tick/lot,
///         risk, funding and oracle params. Steps, in `DeployMeridian._deployMarket` order:
///         1. `TestnetKeeperOracle` (keeper-fed; TESTNET/ANVIL ONLY, its constructor refuses other chains), feeders =
///            the deployer + KEEPER_ADDRESS;
///         2. `ClearingHouse` (the record's tAUSD and InsuranceFund) + `OrderBook`, `setOrderBook`;
///         3. `InsuranceFund.setMarketAuthorized(ch, true)` and `MarketFactory.registerMarket` (the deployer must own both);
///         4. optional first price: SEED_PRICE_WAD (+ SEED_PUBLISH_TIME, unix s, default now);
///         5. hand-over of the oracle and CH to the record's owner when that isn't the deployer.
///         Record: appends `{symbol, ClearingHouse, OrderBook, OracleAdapter, keeper (the feeder), …, startBlock}` to `markets` and touches no
///         other key (`contracts.*`, `demoMarket`, `keeperAccounts`… stay as they are).
///   Dry-run: DEPLOYER_PK=… forge script script/AddMarket.s.sol --fork-url $MONAD_TESTNET_RPC_URL --code-size-limit 131072
///            (writes deployments/dry-run/add-market-<chainid>.json, labelled SIMULATION)
///   Deploy:  … --rpc-url $MONAD_TESTNET_RPC_URL --broadcast --slow --with-gas-price 110gwei --gas-estimate-multiplier 120
contract AddMarket is DeployBase {
    using stdJson for string;

    uint256 internal constant MAX_MARKETS = 8; // bound on the record's `markets` list (re-serialized on append)

    struct Args {
        string marketKey; // config key under `markets`, e.g. "eth"
        string recordIn; // file under deployments/
        string recordOut; // file under deployments/ ("" = dry-run file unless broadcasting)
        uint256 pk;
        address keeper;
        uint256 seedPriceWad;
        uint256 seedPublishTime;
    }

    struct Out {
        string symbol;
        address oracle;
        address clearingHouse;
        address orderBook;
        address baseAsset;
        address owner;
        uint256 startBlock;
        string path;
    }

    function run() external returns (Out memory) {
        Args memory a;
        a.marketKey = vm.envOr("MARKET_KEY", string("eth"));
        a.recordIn = vm.envOr("DEPLOYMENTS_FILE", string.concat(vm.toString(block.chainid), ".json"));
        a.recordOut = vm.envOr("DEPLOYMENTS_OUT", string(""));
        a.pk = vm.envUint("DEPLOYER_PK");
        a.keeper = vm.envOr("KEEPER_ADDRESS", address(0));
        a.seedPriceWad = vm.envOr("SEED_PRICE_WAD", uint256(0));
        a.seedPublishTime = vm.envOr("SEED_PUBLISH_TIME", uint256(0));
        return runWith(a);
    }

    /// @dev Entry point for tests (no process env, so parallel tests can't race on it).
    function runWith(Args memory a) public returns (Out memory o) {
        _loadConfig();
        string memory k = string.concat(".markets.", a.marketKey);
        require(vm.keyExistsJson(cfg, k), "MARKET_KEY: no markets.<key> in the config");
        string memory rec = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/", a.recordIn));
        require(rec.readUint(".chainId") == block.chainid, "record is for another chain");

        address factory = rec.readAddress(".contracts.MarketFactory");
        address fund = rec.readAddress(".contracts.InsuranceFund");
        address ausd = rec.readAddress(".contracts.AUSD");
        address deployer = vm.addr(a.pk);
        require(Ownable(factory).owner() == deployer, "the deployer must own the MarketFactory");
        require(Ownable(fund).owner() == deployer, "the deployer must own the InsuranceFund");
        o.owner = vm.keyExistsJson(rec, ".owner") ? rec.readAddress(".owner") : deployer;
        o.symbol = cfg.readString(string.concat(k, ".symbol"));
        o.baseAsset = _optAddress(string.concat(k, ".baseAsset"));
        require(
            keccak256(bytes(cfg.readString(string.concat(k, ".oracle.kind")))) == keccak256("keeper-fed"),
            "markets.<key>.oracle.kind: keeper-fed only"
        );
        _requireNew(factory, o.symbol);

        o.startBlock = block.number;
        vm.startBroadcast(a.pk);
        TestnetKeeperOracle oracle = new TestnetKeeperOracle(
            deployer,
            cfg.readUint(string.concat(k, ".oracle.maxStalenessSec")),
            _u(string.concat(k, ".oracle.maxDeviationWad")),
            cfg.readString(string.concat(k, ".feedSymbol"))
        );
        oracle.setFeeder(deployer, true); // lets the operator seed the first price by hand
        if (a.keeper != address(0) && a.keeper != deployer) oracle.setFeeder(a.keeper, true);
        ClearingHouse ch = new ClearingHouse(
            ausd,
            address(oracle),
            fund,
            _riskParamsAt(string.concat(k, ".risk.")),
            _fundingParamsAt(string.concat(k, ".funding.")),
            deployer
        );
        OrderBook ob =
            new OrderBook(address(ch), _u(string.concat(k, ".tickSizeWad")), _u(string.concat(k, ".lotSizeWad")));
        ch.setOrderBook(address(ob));
        InsuranceFund(fund).setMarketAuthorized(address(ch), true);
        MarketFactory(factory).registerMarket(o.symbol, address(ob), address(ch), address(oracle), o.baseAsset);
        if (a.seedPriceWad != 0) {
            oracle.pushPrice(a.seedPriceWad, a.seedPublishTime != 0 ? a.seedPublishTime : block.timestamp);
        }
        if (o.owner != deployer) {
            oracle.transferOwnership(o.owner);
            ch.transferOwnership(o.owner);
        }
        vm.stopBroadcast();

        o.oracle = address(oracle);
        o.clearingHouse = address(ch);
        o.orderBook = address(ob);
        _check(o, factory, fund);
        o.path = _write(rec, a, k, o);
        _log(o, a);
    }

    /// @dev Fails before any broadcast when the symbol is already registered (the factory would revert MarketExists).
    function _requireNew(address factory, string memory symbol) internal view {
        try IMarketFactory(factory).getMarket(keccak256(bytes(symbol))) returns (IMarketFactory.Market memory) {
            revert("market already registered");
        } catch {}
    }

    function _check(Out memory o, address factory, address fund) internal view {
        IMarketFactory.Market memory m = IMarketFactory(factory).getMarket(keccak256(bytes(o.symbol)));
        require(m.clearingHouse == o.clearingHouse && m.orderBook == o.orderBook && m.oracle == o.oracle, "registry");
        require(m.active, "registry: inactive");
        require(InsuranceFund(fund).isAuthorized(o.clearingHouse), "IF authorization");
        require(ClearingHouse(o.clearingHouse).orderBook() == o.orderBook, "CH -> OB");
        require(Ownable(o.clearingHouse).owner() == o.owner && Ownable(o.oracle).owner() == o.owner, "owner");
    }

    /// @dev Appends the market to the record's `markets` list (existing entries re-serialized field by field, bounded by
    ///      MAX_MARKETS) and writes ONLY that key. A simulation goes to deployments/dry-run/ unless `recordOut` is set.
    function _write(string memory rec, Args memory a, string memory k, Out memory o)
        internal
        returns (string memory path)
    {
        bool live = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);
        if (bytes(a.recordOut).length != 0) {
            path = string.concat(vm.projectRoot(), "/../deployments/", a.recordOut);
        } else if (live) {
            path = string.concat(vm.projectRoot(), "/../deployments/", a.recordIn);
        } else {
            path = string.concat(
                vm.projectRoot(), "/../deployments/dry-run/add-market-", vm.toString(block.chainid), ".json"
            );
        }
        if (!vm.exists(path) || keccak256(bytes(vm.readFile(path))) != keccak256(bytes(rec))) vm.writeFile(path, rec);
        if (!live && bytes(a.recordOut).length == 0) {
            vm.writeJson('"SIMULATION (forge script without --broadcast): addresses are not deployed"', path, "._label");
        }

        uint256 n;
        while (n < MAX_MARKETS && vm.keyExistsJson(rec, string.concat(".markets[", vm.toString(n), "].symbol"))) ++n;
        require(n < MAX_MARKETS, "record: markets list full");
        string memory arr = "[";
        for (uint256 i; i < n; ++i) {
            arr = string.concat(arr, _copyEntry(rec, i), ",");
        }
        arr = string.concat(arr, _newEntry(k, o, a.keeper), "]");
        vm.writeJson(arr, path, ".markets");
    }

    function _newEntry(string memory k, Out memory o, address keeper) internal returns (string memory) {
        string memory e = string.concat("market-", o.symbol, "-", vm.toString(o.startBlock));
        e.serialize("symbol", o.symbol);
        e.serialize("_label", string("TESTNET MARKET: keeper-fed oracle (Pyth via Hermes, pushed by the keeper)"));
        e.serialize("oracleKind", string("keeper-fed"));
        e.serialize("feedSymbol", cfg.readString(string.concat(k, ".feedSymbol")));
        e.serialize("pythFeedId", cfg.readBytes32(string.concat(k, ".pythFeedId")));
        e.serialize("tickSizeWad", cfg.readString(string.concat(k, ".tickSizeWad")));
        e.serialize("lotSizeWad", cfg.readString(string.concat(k, ".lotSizeWad")));
        e.serialize("baseAsset", o.baseAsset);
        e.serialize("keeper", keeper);
        e.serialize("OracleAdapter", o.oracle);
        e.serialize("ClearingHouse", o.clearingHouse);
        e.serialize("OrderBook", o.orderBook);
        return e.serialize("startBlock", o.startBlock);
    }

    function _copyEntry(string memory rec, uint256 i) internal returns (string memory) {
        string memory p = string.concat(".markets[", vm.toString(i), "].");
        string memory e = string.concat("market-copy-", vm.toString(i), "-", vm.toString(block.number));
        e.serialize("symbol", rec.readString(string.concat(p, "symbol")));
        e.serialize("_label", rec.readString(string.concat(p, "_label")));
        e.serialize("oracleKind", rec.readString(string.concat(p, "oracleKind")));
        e.serialize("feedSymbol", rec.readString(string.concat(p, "feedSymbol")));
        e.serialize("pythFeedId", rec.readBytes32(string.concat(p, "pythFeedId")));
        e.serialize("tickSizeWad", rec.readString(string.concat(p, "tickSizeWad")));
        e.serialize("lotSizeWad", rec.readString(string.concat(p, "lotSizeWad")));
        e.serialize("baseAsset", rec.readAddress(string.concat(p, "baseAsset")));
        e.serialize("keeper", rec.readAddressOr(string.concat(p, "keeper"), address(0)));
        e.serialize("OracleAdapter", rec.readAddress(string.concat(p, "OracleAdapter")));
        e.serialize("ClearingHouse", rec.readAddress(string.concat(p, "ClearingHouse")));
        e.serialize("OrderBook", rec.readAddress(string.concat(p, "OrderBook")));
        return e.serialize("startBlock", rec.readUint(string.concat(p, "startBlock")));
    }

    function _log(Out memory o, Args memory a) internal pure {
        console.log(o.symbol, "startBlock", o.startBlock);
        console.log("  oracle / CH / OB", o.oracle, o.clearingHouse, o.orderBook);
        console.log("  owner", o.owner);
        if (a.seedPriceWad == 0) {
            console.log("  oracle NOT seeded: start the keeper (MARKET=eth) or pushPrice by hand");
        }
        console.log("  record", o.path);
    }
}
