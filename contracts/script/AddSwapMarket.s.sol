// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {DeployBase} from "./DeployBase.s.sol";
import {InsuranceFund} from "../src/clearing/InsuranceFund.sol";
import {OrderBook} from "../src/orderbook/OrderBook.sol";
import {FundingSwapMarket} from "../src/swaps/FundingSwapMarket.sol";
import {PerplFundingSource} from "../src/oracle/PerplFundingSource.sol";

/// @notice PS (CR-017): add a SECOND funding-swap market to an existing deployment record, settling on Perpl's MON-perp
///         funding through `PerplFundingSource`. `FundingSwapMarket` is unchanged: the adapter is passed as its
///         `perpClearingHouse_`. Steps, in `DeployMeridian._deploySwaps` order:
///         1. `PerplFundingSource(exchange, perpId, fundingIntervalSec)` from `deployments/perpl.json` (the constructor
///            writes the first observation) and a first `poke()` (a no-op unless a funding event just applied);
///         2. `FundingSwapMarket(source, tAUSD, InsuranceFund, maturity, params.swap.params, deployer)` + its
///            `OrderBook` (params.swap tick 1 bp APR, lot 1,000 MON), `setOrderBook`;
///         3. `InsuranceFund.setMarketAuthorized(fs, true)` when the deployer owns the IF (else printed for the owner);
///         4. hand-over of the swap market to the record's owner when that isn't the deployer.
///         Maturity: now + SWAP_MATURITY_IN_SEC if set, else 30 days from listing (MATH_SPEC §6.1).
///         Record: appends `{symbol, fundingSource, perplPerpId, perplExchange, PerplFundingSource, FundingSwapMarket,
///         SwapOrderBook, maturity, startBlock, deployed}` to `swapMarkets` and touches no other key.
///   Dry-run: DEPLOYER_PK=… forge script script/AddSwapMarket.s.sol --fork-url $MONAD_TESTNET_RPC_URL
///            (writes deployments/dry-run/add-swap-market-<chainid>.json, labelled SIMULATION)
///   Deploy:  … --rpc-url $MONAD_TESTNET_RPC_URL --broadcast --slow --with-gas-price 110gwei --gas-estimate-multiplier 120
contract AddSwapMarket is DeployBase {
    using stdJson for string;

    uint256 internal constant MAX_SWAP_MARKETS = 8; // bound on the record's `swapMarkets` list (re-serialized on append)
    uint256 internal constant DEFAULT_MATURITY_SEC = 30 days; // MATH_SPEC §6.1

    struct Args {
        string symbol; // e.g. "MON-FUNDING-PERPL"
        string recordIn; // file under deployments/
        string recordOut; // file under deployments/ ("" = dry-run file unless broadcasting)
        uint256 pk;
        uint256 maturityInSec; // 0 = DEFAULT_MATURITY_SEC
    }

    struct Out {
        address source;
        address swapMarket;
        address swapOrderBook;
        address perplExchange;
        uint256 perplPerpId;
        uint256 maturity;
        uint256 startBlock;
        bool ifAuthorized;
        address owner;
        address ausd;
        address fund;
        uint256 intervalSec;
        string path;
    }

    function run() external returns (Out memory) {
        Args memory a;
        a.symbol = vm.envOr("SWAP_SYMBOL", string("MON-FUNDING-PERPL"));
        a.recordIn = vm.envOr("DEPLOYMENTS_FILE", string.concat(vm.toString(block.chainid), ".json"));
        a.recordOut = vm.envOr("DEPLOYMENTS_OUT", string(""));
        a.pk = vm.envUint("DEPLOYER_PK");
        a.maturityInSec = vm.envOr("SWAP_MATURITY_IN_SEC", uint256(0));
        return runWith(a);
    }

    /// @dev Entry point for tests (no process env).
    function runWith(Args memory a) public returns (Out memory o) {
        _loadConfig();
        string memory root = string.concat(vm.projectRoot(), "/../deployments/");
        string memory rec = vm.readFile(string.concat(root, a.recordIn));
        require(rec.readUint(".chainId") == block.chainid, "record is for another chain");
        _readPerpl(o, vm.readFile(string.concat(root, "perpl.json")));
        _requireNew(rec, a.symbol);
        o.ausd = rec.readAddress(".contracts.AUSD");
        o.fund = rec.readAddress(".contracts.InsuranceFund");
        address deployer = vm.addr(a.pk);
        o.owner = vm.keyExistsJson(rec, ".owner") ? rec.readAddress(".owner") : deployer;
        o.maturity = block.timestamp + (a.maturityInSec != 0 ? a.maturityInSec : DEFAULT_MATURITY_SEC);
        o.startBlock = block.number;
        o.ifAuthorized = Ownable(o.fund).owner() == deployer;
        _broadcast(a.pk, o, deployer);
        _check(o);
        o.path = _write(rec, a, o);
        _log(o);
    }

    function _readPerpl(Out memory o, string memory perpl) internal view {
        string memory c = string.concat(".chains.", vm.toString(block.chainid));
        o.perplExchange = perpl.readAddress(string.concat(c, ".exchange"));
        o.perplPerpId = perpl.readUint(string.concat(c, ".monMarketId"));
        o.intervalSec = perpl.readUint(string.concat(c, ".markets.", vm.toString(o.perplPerpId), ".fundingIntervalSec"));
        require(o.perplExchange.code.length != 0, "perpl exchange has no code on this chain");
    }

    function _broadcast(uint256 pk, Out memory o, address deployer) internal {
        vm.startBroadcast(pk);
        PerplFundingSource src = new PerplFundingSource(o.perplExchange, o.perplPerpId, o.intervalSec);
        src.poke();
        FundingSwapMarket fs =
            new FundingSwapMarket(address(src), o.ausd, o.fund, uint64(o.maturity), _swapParams(), deployer);
        OrderBook sob = new OrderBook(address(fs), _u(".params.swap.tickSizeWad"), _u(".params.swap.lotSizeWad"));
        fs.setOrderBook(address(sob));
        if (o.ifAuthorized) InsuranceFund(o.fund).setMarketAuthorized(address(fs), true);
        if (o.owner != deployer) fs.transferOwnership(o.owner);
        vm.stopBroadcast();
        (o.source, o.swapMarket, o.swapOrderBook) = (address(src), address(fs), address(sob));
    }

    function _requireNew(string memory rec, string memory symbol) internal view {
        for (uint256 i; i < MAX_SWAP_MARKETS; ++i) {
            string memory k = string.concat(".swapMarkets[", vm.toString(i), "].symbol");
            if (!vm.keyExistsJson(rec, k)) return;
            require(keccak256(bytes(rec.readString(k))) != keccak256(bytes(symbol)), "swap market already recorded");
        }
    }

    function _check(Out memory o) internal view {
        FundingSwapMarket fs = FundingSwapMarket(o.swapMarket);
        require(fs.perpClearingHouse() == o.source, "FS -> source");
        require(fs.collateralToken() == o.ausd && fs.insuranceFund() == o.fund, "FS wiring");
        require(fs.orderBook() == o.swapOrderBook, "FS -> OB");
        require(OrderBook(o.swapOrderBook).clearingHouse() == o.swapMarket, "OB -> FS");
        require(fs.owner() == o.owner, "owner");
        require(!o.ifAuthorized || InsuranceFund(o.fund).isAuthorized(o.swapMarket), "IF authorization");
        PerplFundingSource src = PerplFundingSource(o.source);
        require(src.exchange() == o.perplExchange && src.perpId() == o.perplPerpId, "source wiring");
        (,, uint64 feb) = src.latestObservation();
        require(feb != 0 && src.indexPrice() != 0, "source empty");
    }

    /// @dev Appends to the record's `swapMarkets` list (existing entries re-serialized field by field, bounded by
    ///      MAX_SWAP_MARKETS) and writes ONLY that key. A simulation goes to deployments/dry-run/ unless `recordOut` is set.
    function _write(string memory rec, Args memory a, Out memory o) internal returns (string memory path) {
        bool live = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);
        string memory root = string.concat(vm.projectRoot(), "/../deployments/");
        if (bytes(a.recordOut).length != 0) path = string.concat(root, a.recordOut);
        else if (live) path = string.concat(root, a.recordIn);
        else path = string.concat(root, "dry-run/add-swap-market-", vm.toString(block.chainid), ".json");
        if (!vm.exists(path) || keccak256(bytes(vm.readFile(path))) != keccak256(bytes(rec))) vm.writeFile(path, rec);
        if (!live && bytes(a.recordOut).length == 0) {
            vm.writeJson('"SIMULATION (forge script without --broadcast): addresses are not deployed"', path, "._label");
        }
        uint256 n;
        while (
            n < MAX_SWAP_MARKETS && vm.keyExistsJson(rec, string.concat(".swapMarkets[", vm.toString(n), "].symbol"))
        ) {
            ++n;
        }
        require(n < MAX_SWAP_MARKETS, "record: swapMarkets list full");
        string memory arr = "[";
        for (uint256 i; i < n; ++i) {
            arr = string.concat(arr, _copyEntry(rec, i), ",");
        }
        arr = string.concat(arr, _newEntry(a.symbol, o, live), "]");
        vm.writeJson(arr, path, ".swapMarkets");
    }

    function _newEntry(string memory symbol, Out memory o, bool live) internal returns (string memory) {
        string memory e = string.concat("swap-", symbol, "-", vm.toString(o.startBlock));
        e.serialize("symbol", symbol);
        e.serialize("_label", string("TESTNET SWAP MARKET: settles on Perpl's MON-perp funding (PerplFundingSource)"));
        e.serialize("fundingSource", string("perpl"));
        e.serialize("perplPerpId", o.perplPerpId);
        e.serialize("perplExchange", o.perplExchange);
        e.serialize("PerplFundingSource", o.source);
        e.serialize("FundingSwapMarket", o.swapMarket);
        e.serialize("SwapOrderBook", o.swapOrderBook);
        e.serialize("tickSizeWad", cfg.readString(".params.swap.tickSizeWad"));
        e.serialize("lotSizeWad", cfg.readString(".params.swap.lotSizeWad"));
        e.serialize("maturity", o.maturity);
        e.serialize("deployed", live);
        return e.serialize("startBlock", o.startBlock);
    }

    function _copyEntry(string memory rec, uint256 i) internal returns (string memory) {
        string memory p = string.concat(".swapMarkets[", vm.toString(i), "].");
        string memory e = string.concat("swap-copy-", vm.toString(i), "-", vm.toString(block.number));
        e.serialize("symbol", rec.readString(string.concat(p, "symbol")));
        e.serialize("_label", rec.readString(string.concat(p, "_label")));
        e.serialize("fundingSource", rec.readString(string.concat(p, "fundingSource")));
        e.serialize("perplPerpId", rec.readUint(string.concat(p, "perplPerpId")));
        e.serialize("perplExchange", rec.readAddress(string.concat(p, "perplExchange")));
        e.serialize("PerplFundingSource", rec.readAddress(string.concat(p, "PerplFundingSource")));
        e.serialize("FundingSwapMarket", rec.readAddress(string.concat(p, "FundingSwapMarket")));
        e.serialize("SwapOrderBook", rec.readAddress(string.concat(p, "SwapOrderBook")));
        e.serialize("tickSizeWad", rec.readString(string.concat(p, "tickSizeWad")));
        e.serialize("lotSizeWad", rec.readString(string.concat(p, "lotSizeWad")));
        e.serialize("maturity", rec.readUint(string.concat(p, "maturity")));
        e.serialize("deployed", rec.readBool(string.concat(p, "deployed")));
        return e.serialize("startBlock", rec.readUint(string.concat(p, "startBlock")));
    }

    function _log(Out memory o) internal pure {
        console.log("swap market startBlock", o.startBlock, "maturity", o.maturity);
        console.log("  source / FS / OB", o.source, o.swapMarket, o.swapOrderBook);
        console.log("  perpl exchange / perp", o.perplExchange, o.perplPerpId);
        console.log("  owner", o.owner);
        if (!o.ifAuthorized) {
            console.log("  OWNER ACTION: InsuranceFund.setMarketAuthorized(FS, true) on", o.fund);
        }
        console.log("  record", o.path);
    }
}
