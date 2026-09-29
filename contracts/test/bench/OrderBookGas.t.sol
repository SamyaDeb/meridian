// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {IOrderBook} from "../../src/interfaces/IOrderBook.sol";
import {IMarginEngine} from "../../src/interfaces/IMarginEngine.sol";

/// @dev Hooks that do nothing, so the numbers are the book's own cost ("excluding CH cost", WS-01 acceptance).
contract NoopEngine is IMarginEngine {
    address public orderBook;

    function setOrderBook(address ob) external {
        orderBook = ob;
    }

    function reserveOrderMargin(address, bool, uint256, uint256) external {}
    function releaseOrderMargin(address, bool, uint256, uint256) external {}

    function settleMakerFill(address, bool, uint256, uint256) external pure returns (bool) {
        return true;
    }

    function settleTakerFill(address, bool, uint256, uint256, bool) external {}
}

/// @notice BENCHMARKS B1: OrderBook gas on a warm book at an existing level. Writes bench-out/orderbook_gas.csv.
/// @dev Each measured call starts with the book's and the engine's accounts and storage cold (`vm.cool`), the book
///      address re-warmed (a tx's `to` is always warm), so every number is one transaction's execution gas minus
///      the 21k base and calldata. EVM (Cancun) schedule with no refunds counted; Monad's MIP-8 page pricing
///      differs and is measured on testnet by WS-08 (B3).
contract OrderBookGasBench is Test {
    uint256 constant TICK = 1e12; // 1e-6 AUSD (MON-PERP)
    uint256 constant LOT = 100e18; // 100 MON
    uint32 constant BID = 1000; // best bid level (existing)
    uint32 constant ASK = 1021; // best ask level (existing)
    string constant CSV = "./bench-out/orderbook_gas.csv";

    OrderBook ob;
    NoopEngine eng;
    address mm = makeAddr("mm");
    address taker = makeAddr("taker");
    string csv;

    function setUp() public {
        eng = new NoopEngine();
        ob = new OrderBook(address(eng), TICK, LOT);
        eng.setOrderBook(address(ob));
        // warm book: 20 bid and 20 ask levels, two LP orders each
        for (uint32 i; i < 20; ++i) {
            for (uint160 j; j < 2; ++j) {
                vm.prank(address(0x1000 + j));
                ob.placeLimitOrder(true, BID - i, 1, 0);
                vm.prank(address(0x2000 + j));
                ob.placeLimitOrder(false, ASK + i, 1, 0);
            }
        }
        // mm has traded before: its openOrderCount slot and the free list are already in use
        vm.startPrank(mm);
        (uint64 id,) = ob.placeLimitOrder(true, BID, 1, 0);
        ob.placeLimitOrder(false, ASK + 5, 1, 0);
        ob.cancelOrder(id);
        vm.stopPrank();
    }

    function test_bench_orderBookGas() public {
        csv = "op,gas,target\n";

        uint256 place = _row("place", 60_000, _placeBid(BID - 1));
        uint64 id = _lastId;
        uint256 cancel = _row("cancel", 35_000, _gas(mm, abi.encodeCall(IOrderBook.cancelOrder, (id))));
        _row("place+cancel", 100_000, place + cancel);

        _placeBid(BID - 2);
        uint256 replace = _gas(mm, abi.encodeCall(IOrderBook.replaceOrder, (_lastId, BID - 3, 2, 0)));
        _row("replace", 100_000, replace);

        uint256 g1;
        uint256 g32;
        uint256[4] memory ks = [uint256(1), 4, 16, 32];
        for (uint256 i; i < ks.length; ++i) {
            uint256 g = _kFill(ks[i]);
            _row(string.concat("match_", vm.toString(ks[i]), "_fill"), 0, g);
            if (ks[i] == 1) g1 = g;
            if (ks[i] == 32) g32 = g;
        }
        _row("per_extra_fill", 30_000, (g32 - g1) / 31);

        vm.createDir("./bench-out", true);
        vm.writeFile(CSV, csv);
        console.log(csv);
    }

    uint64 internal _lastId;

    function _placeBid(uint32 tick) internal returns (uint256 g) {
        bytes memory ret;
        (g, ret) = _call(mm, abi.encodeCall(IOrderBook.placeLimitOrder, (true, tick, 1, 0)));
        (_lastId,) = abi.decode(ret, (uint64, uint64));
    }

    /// @dev k one-lot maker orders from distinct makers join the best ask level (behind the two LP orders); a
    ///      market buy of k lots fills exactly k orders and the level stays non-empty.
    function _kFill(uint256 k) internal returns (uint256 g) {
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < k; ++i) {
            vm.prank(address(uint160(0x3000 + i)));
            ob.placeLimitOrder(false, ASK, 1, 0);
        }
        g = _gas(taker, abi.encodeCall(IOrderBook.placeMarketOrder, (true, uint64(k), ASK, uint64(k), false)));
        (uint64 lots,) = ob.getLevel(ASK);
        assertEq(lots, 2, "exactly k fills");
        vm.revertToState(snap);
    }

    function _gas(address who, bytes memory data) internal returns (uint256 g) {
        (g,) = _call(who, data);
    }

    function _call(address who, bytes memory data) internal returns (uint256 g, bytes memory ret) {
        vm.cool(address(ob));
        vm.cool(address(eng));
        ob.tickSize(); // immutable: warms the account only
        vm.prank(who);
        uint256 g0 = gasleft();
        bool ok;
        (ok, ret) = address(ob).call(data);
        g = g0 - gasleft();
        assertTrue(ok, "bench call reverted");
    }

    function _row(string memory op, uint256 target, uint256 g) internal returns (uint256) {
        csv = string.concat(csv, op, ",", vm.toString(g), ",", target == 0 ? "" : vm.toString(target), "\n");
        if (target != 0) assertLt(g, target + 1, op);
        return g;
    }
}
