// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {IOrderBook} from "../../src/interfaces/IOrderBook.sol";
import {IClearingHouse} from "../../src/interfaces/IClearingHouse.sol";
import {RiskParams, FundingParams} from "../../src/interfaces/PulseTypes.sol";

/// @notice BENCHMARKS B1 on the REAL engine (A1 §3): OrderBook + ClearingHouse + mock oracle, MATH_SPEC defaults.
///         Writes bench-out/real_engine_gas.csv. Same method as OrderBookGas: every measured call starts with the
///         book, CH, oracle and token accounts and storage cold (`vm.cool`, only the call's `to` re-warmed), i.e.
///         one transaction's execution gas minus the 21k base and calldata, Ethereum (Cancun) schedule; Monad MIP-8
///         page pricing is measured on testnet (B3). Trading rows run in a block whose funding touch already
///         happened (the MM's steady state); the funding rows measure the first touch of a block on its own.
contract RealEngineGasBench is Test {
    uint256 constant TICK = 1e12;
    uint256 constant LOT = 100e18;
    uint32 constant BID = 28_990;
    uint32 constant ASK = 29_010;
    string constant CSV = "./bench-out/real_engine_gas.csv";

    MockERC20 ausd;
    MockOracleAdapter oracle;
    ClearingHouse ch;
    OrderBook ob;
    address owner = makeAddr("owner");
    address mm = makeAddr("mm");
    address taker = makeAddr("taker");
    string csv;
    uint64 internal _lastId;

    function setUp() public {
        vm.roll(1000);
        ausd = new MockERC20("Test AUSD", "tAUSD", 6);
        oracle = new MockOracleAdapter(0.029e18);
        InsuranceFund fund = new InsuranceFund(address(ausd), owner);
        ch = new ClearingHouse(
            address(ausd),
            address(oracle),
            address(fund),
            RiskParams(0.2e18, 0.1e18, 0.0005e18, -0.0001e18, 0.01e18, 0.5e18, 250_000e18, 25_000e18),
            FundingParams(0.002e18, 3_472_222_222, 555_555_555_556, 555_555_556, 300, 0.05e18),
            owner
        );
        ob = new OrderBook(address(ch), TICK, LOT);
        vm.startPrank(owner);
        ch.setOrderBook(address(ob));
        fund.setMarketAuthorized(address(ch), true);
        vm.stopPrank();
        _deposit(mm, 100_000e6);
        _deposit(taker, 100_000e6);
        for (uint160 j; j < 2; ++j) {
            _deposit(address(0x1000 + j), 10_000e6);
            _deposit(address(0x2000 + j), 10_000e6);
        }
        // warm book: 20 bid and 20 ask levels, two LP orders each
        for (uint32 i; i < 20; ++i) {
            for (uint160 j; j < 2; ++j) {
                vm.prank(address(0x1000 + j));
                ob.placeLimitOrder(true, BID - i, 1, 0);
                vm.prank(address(0x2000 + j));
                ob.placeLimitOrder(false, ASK + i, 1, 0);
            }
        }
        // mm and taker have traded before (their account slots, the free list and F/G are nonzero)
        vm.startPrank(mm);
        (uint64 id,) = ob.placeLimitOrder(true, BID, 1, 0);
        ob.placeLimitOrder(false, ASK + 5, 1, 0);
        ob.cancelOrder(id);
        vm.stopPrank();
        vm.prank(taker);
        ob.placeMarketOrder(true, 1, ASK, 1, false);
        vm.roll(block.number + 1);
        ch.updateFunding(); // this block's touch done: trading rows below are later txs in the block
    }

    function _deposit(address who, uint256 amt) internal {
        ausd.mint(who, amt);
        vm.startPrank(who);
        ausd.approve(address(ch), amt);
        ch.deposit(amt);
        vm.stopPrank();
    }

    function test_bench_realEngineGas() public {
        csv = "op,gas,target\n";
        uint256 place = _row("place", 0, _placeBid(BID - 1));
        uint256 cancel = _row("cancel", 0, _gas(mm, abi.encodeCall(IOrderBook.cancelOrder, (_lastId)), address(ob)));
        _row("place+cancel", 100_000, place + cancel);
        assertLt(place + cancel, 100_000, "place+cancel >= 100k");
        _placeBid(BID - 2);
        _row(
            "replace", 100_000, _gas(mm, abi.encodeCall(IOrderBook.replaceOrder, (_lastId, BID - 3, 2, 0)), address(ob))
        );

        uint256 g1;
        uint256 g32;
        uint256[4] memory ks = [uint256(1), 4, 16, 32];
        for (uint256 i; i < ks.length; ++i) {
            uint256 g = _kFill(ks[i]);
            _row(string.concat("match_", vm.toString(ks[i]), "_fill"), 0, g);
            if (ks[i] == 1) g1 = g;
            if (ks[i] == 32) g32 = g;
        }
        _row("per_extra_fill", 0, (g32 - g1) / 31);

        // The same first touch when the mark's premium bound binds (MATH_SPEC §2.1, the costliest mark path): the index
        // drops 2% while the book and the last trade stay at 0.029, so the live basis jumps +2% and is clamped to
        // +10 bps. Measured first, inside a snapshot, so both rows see identical (clean) storage.
        uint256 snap = vm.snapshotState();
        oracle.setPrice(0.02842e18);
        (uint256 bFirst, uint256 bNoop,) = _fundingTouch(block.number + 1);
        assertEq(ch.markPrice(), 0.02842e18 + 0.02842e15, "bound active");
        vm.revertToState(snap);
        (uint256 first, uint256 noop, uint256 later) = _fundingTouch(block.number + 1);
        _row("funding_first_touch_tx", 0, first);
        _row("funding_first_touch_incremental", 30_000, first - noop);
        _row("funding_later_touch_same_tx", 3000, later);
        uint256 ext = _externalViewGas();
        _row("funding_external_views_cold", 0, ext);
        _row("funding_ch_own_incremental", 30_000, first - noop - ext);
        assertLt(first - noop - ext, 30_000, "CH-own funding first touch >= 30k");
        _row("funding_ch_own_incremental_bound_active", 30_000, bFirst - bNoop - ext);
        assertLt(bFirst - bNoop - ext, 30_000, "CH-own funding first touch (premium bound active) >= 30k");
        // steady-state checkpoint: wrap the 1440-slot ring so the checkpoint overwrites a nonzero slot
        uint256 b = block.number;
        for (uint256 i; i < 1440; ++i) {
            b += 200;
            vm.roll(b);
            ch.updateFunding();
        }
        (uint256 ckFirst, uint256 ckNoop,) = _fundingTouch((b / 200 + 1) * 200);
        _row("funding_first_touch_checkpoint_tx", 0, ckFirst);
        _row("funding_first_touch_checkpoint_incremental", 40_000, ckFirst - ckNoop);
        _row("funding_ch_own_checkpoint_incremental", 40_000, ckFirst - ckNoop - ext);
        assertLt(ckFirst - ckNoop - ext, 40_000, "CH-own funding first touch on a checkpoint block >= 40k");
        assertLt(later, 3000, "later touch >= 3k");

        vm.createDir("./bench-out", true);
        vm.writeFile(CSV, csv);
        console.log(csv);
    }

    function _placeBid(uint32 tick) internal returns (uint256 g) {
        bytes memory ret;
        (g, ret) = _call(mm, abi.encodeCall(IOrderBook.placeLimitOrder, (true, tick, 1, 0)), address(ob));
        (_lastId,) = abi.decode(ret, (uint64, uint64));
    }

    /// k one-lot asks from k distinct funded makers at ASK+1; the LP asks left at ASK are taken first, so a market
    /// buy of k lots fills exactly k maker orders (the two LP orders behind them keep the level non-empty).
    function _kFill(uint256 k) internal returns (uint256 g) {
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < k; ++i) {
            address m = address(uint160(0x3000 + i));
            _deposit(m, 100e6);
            vm.prank(m);
            ob.placeLimitOrder(false, ASK + 1, 1, 0);
        }
        (uint64 atAsk,) = ob.getLevel(ASK);
        vm.prank(taker);
        ob.placeMarketOrder(true, atAsk, ASK, atAsk, false);
        g = _gas(
            taker,
            abi.encodeCall(IOrderBook.placeMarketOrder, (true, uint64(k), ASK + 1, uint64(k), false)),
            address(ob)
        );
        (uint64 lots,) = ob.getLevel(ASK + 1);
        assertEq(lots, 2, "exactly k fills");
        vm.revertToState(snap);
    }

    /// @return first cold first touch in block `blk` @return noop cold no-op touch @return later warm no-op touch
    function _fundingTouch(uint256 blk) internal returns (uint256 first, uint256 noop, uint256 later) {
        vm.roll(blk);
        first = _gas(address(this), abi.encodeCall(IClearingHouse.updateFunding, ()), address(ch));
        noop = _gas(address(this), abi.encodeCall(IClearingHouse.updateFunding, ()), address(ch));
        uint256 g0 = gasleft();
        ch.updateFunding();
        later = g0 - gasleft();
    }

    /// The external reads a first touch makes (oracle + 3 book views), all cold, to split CH-own gas from them.
    function _externalViewGas() internal returns (uint256 g) {
        vm.cool(address(ob));
        vm.cool(address(oracle));
        g = gasleft();
        oracle.tryGetIndexPrice();
        ob.bestBid();
        ob.bestAsk();
        ob.lastTrade();
        g -= gasleft();
    }

    function _gas(address who, bytes memory data, address to) internal returns (uint256 g) {
        (g,) = _call(who, data, to);
    }

    function _call(address who, bytes memory data, address to) internal returns (uint256 g, bytes memory ret) {
        vm.cool(address(ob));
        vm.cool(address(ch));
        vm.cool(address(oracle));
        vm.cool(address(ausd));
        // re-warm only the transaction's `to` account (always warm in a real tx); its storage stays cold
        if (to == address(ob)) ob.tickSize();
        else ch.collateralToken();
        vm.prank(who);
        uint256 g0 = gasleft();
        bool ok;
        (ok, ret) = to.call(data);
        g = g0 - gasleft();
        assertTrue(ok, "bench call reverted");
    }

    function _row(string memory op, uint256 target, uint256 g) internal returns (uint256) {
        csv = string.concat(csv, op, ",", vm.toString(g), ",", target == 0 ? "" : vm.toString(target), "\n");
        return g;
    }
}
