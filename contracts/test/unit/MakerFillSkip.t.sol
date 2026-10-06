// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {FundingSwapMarket} from "../../src/swaps/FundingSwapMarket.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {IOrderBook} from "../../src/interfaces/IOrderBook.sol";
import {RiskParams, FundingParams, SwapParams} from "../../src/interfaces/PulseTypes.sol";
import {IntegrationBase} from "./Integration.t.sol";

/// @notice CR-007 (audit M-2) on the REAL OrderBook + ClearingHouse: while the oracle is stale or the market is
///         paused, an increasing maker at the head is Skipped (order untouched, `MakerFillSkipped`) and matching
///         stops; reducing makers ahead of it still fill; margin failures still evict.
contract MakerFillSkipPerpTest is IntegrationBase {
    MockOracleAdapter internal oracle;

    uint32 internal constant BID1 = MID0 - 10; // mm's best bid (increasing for mm: it is flat)
    uint32 internal constant BID2 = MID0 - 20;

    function _oracle() internal override returns (address) {
        oracle = new MockOracleAdapter(I0);
        return address(oracle);
    }

    /// alice opens `lots` long against dave (dave short), then dave rests a reducing bid of `bidLots` at `bidTick`.
    function _aliceLongDaveBid(uint64 lots, uint32 bidTick, uint64 bidLots) internal returns (uint64 daveBid) {
        _fund(alice, 1000e6);
        _fund(dave, 1000e6);
        vm.prank(dave);
        ob.placeLimitOrder(false, MID0 + 5, lots, 0);
        vm.prank(alice);
        ob.placeMarketOrder(true, lots, MID0 + 5, lots, false);
        assertEq(ch.getPosition(alice).size, int256(uint256(lots) * LOT));
        vm.prank(dave);
        (daveBid,) = ob.placeLimitOrder(true, bidTick, bidLots, 0);
    }

    struct BookSnap {
        uint64 mmLots;
        uint64 levelLots;
        uint32 levelCount;
        uint256 mmReserved;
        uint256 mmOpen;
        uint32 bestBid;
        uint32 bestAsk;
        uint256 lastPx;
        uint64 lastBlk;
    }

    function _snap() internal view returns (BookSnap memory s) {
        s.mmLots = ob.getOrder(mmIds[0]).remainingLots;
        (s.levelLots, s.levelCount) = ob.getLevel(BID1);
        s.mmReserved = ch.getAccount(mm).reservedOrderMargin;
        s.mmOpen = ob.openOrderCount(mm);
        (s.bestBid, s.bestAsk) = (ob.bestBid(), ob.bestAsk());
        (s.lastPx, s.lastBlk) = ob.lastTrade();
    }

    function _assertUntouched(BookSnap memory a) internal view {
        BookSnap memory b = _snap();
        assertEq(b.mmLots, 100, "mm order still rests with the same lots");
        assertEq(b.mmLots, a.mmLots);
        assertEq(b.levelLots, a.levelLots, "level total");
        assertEq(b.levelCount, a.levelCount, "level count");
        assertEq(b.mmReserved, a.mmReserved, "reservation kept");
        assertEq(b.mmOpen, a.mmOpen, "open-order count");
        assertEq(b.bestBid, a.bestBid, "bestBid");
        assertEq(b.bestAsk, a.bestAsk, "bestAsk: taker remainder did not rest");
        assertEq(b.lastPx, a.lastPx, "no trade printed");
        assertEq(b.lastBlk, a.lastBlk);
    }

    function test_stale_reduceOnlyTaker_skipsIncreasingMaker_stops() public {
        uint64 daveBid = _aliceLongDaveBid(5, MID0 - 15, 5); // dave's reducing bid sits one level deeper
        oracle.setStale(true);
        _roll(1);
        BookSnap memory s = _snap();
        vm.expectEmit(address(ob));
        emit IOrderBook.MakerFillSkipped(mmIds[0], mm);
        vm.prank(alice);
        (uint64 filled, uint256 avg) = ob.placeMarketOrder(false, 5, 1, 0, true);
        assertEq(filled, 0);
        assertEq(avg, 0);
        _assertUntouched(s);
        assertEq(ob.getOrder(daveBid).remainingLots, 5, "deeper level that would have filled is untouched");
        assertEq(ch.getPosition(alice).size, 5 * int256(LOT), "alice unchanged");
        _assertI2();
    }

    function test_paused_limitTaker_skips_remainderDoesNotRest() public {
        uint64 daveBid = _aliceLongDaveBid(5, MID0 - 15, 5);
        vm.prank(owner);
        ch.setPaused(true);
        _roll(1);
        BookSnap memory s = _snap();
        vm.recordLogs();
        vm.prank(alice);
        (uint64 id, uint64 filled) = ob.placeLimitOrder(false, BID2, 5, 0); // crosses mm and dave
        assertEq(id, 0, "crossing remainder never rests");
        assertEq(filled, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(ob)) continue; // the CH's own funding events
            ++n;
            assertEq(logs[i].topics[0], IOrderBook.MakerFillSkipped.selector, "book emits only MakerFillSkipped");
            assertEq(uint256(logs[i].topics[1]), mmIds[0]);
        }
        assertEq(n, 1);
        _assertUntouched(s);
        assertEq(ob.getOrder(daveBid).remainingLots, 5);
    }

    function test_stale_mixed_reducingMakerFills_thenSkipStops() public {
        uint64 daveBid = _aliceLongDaveBid(5, MID0 - 5, 3); // dave's reducing bid is the best bid
        oracle.setStale(true);
        _roll(1);
        vm.expectEmit(address(ob));
        emit IOrderBook.Trade(daveBid, dave, alice, false, MID0 - 5, 3, uint256(MID0 - 5) * TICK, 3 * LOT);
        vm.expectEmit(address(ob));
        emit IOrderBook.MakerFillSkipped(mmIds[0], mm);
        vm.prank(alice);
        (uint64 filled,) = ob.placeMarketOrder(false, 5, 1, 0, true);
        assertEq(filled, 3, "filled up to the first increasing maker");
        assertEq(ch.getPosition(alice).size, 2 * int256(LOT));
        assertEq(ch.getPosition(dave).size, -2 * int256(LOT));
        assertEq(ob.getOrder(daveBid).remainingLots, 0);
        assertEq(ob.getOrder(mmIds[0]).remainingLots, 100);
        assertEq(ch.getPosition(mm).size, 0);
        (uint256 px, uint64 blk) = ob.lastTrade();
        assertEq(px, uint256(MID0 - 5) * TICK, "lastTrade = the last real fill");
        assertEq(blk, block.number);
        assertEq(ob.bestBid(), BID1);
        _assertI2();
    }

    function test_stale_marketOrder_minFilledAfterSkip_reverts() public {
        uint64 daveBid = _aliceLongDaveBid(5, MID0 - 15, 5);
        oracle.setStale(true);
        _roll(1);
        BookSnap memory s = _snap();
        vm.prank(alice);
        vm.expectRevert(IOrderBook.SlippageExceeded.selector);
        ob.placeMarketOrder(false, 5, 1, 5, true);
        _assertUntouched(s);
        assertEq(ob.getOrder(daveBid).remainingLots, 5);
    }

    /// A maker that can't carry the fill is still evicted (reservation released) and matching continues.
    function test_marginFailure_stillEvicts() public {
        _fund(carol, 1e6);
        vm.prank(carol);
        (uint64 cid,) = ob.placeLimitOrder(true, MID0 - 5, 1, 0); // 100 MON at 0.028995, ~0.58 reserved
        assertGt(ch.getAccount(carol).reservedOrderMargin, 0);
        oracle.setPrice(0.015e18); // carol's bid is now ~1.4 AUSD under water on 1 AUSD
        _roll(1);
        _fund(bob, 1000e6);
        vm.expectEmit(address(ob));
        emit IOrderBook.OrderEvicted(cid, carol, 1);
        vm.expectEmit(address(ob));
        emit IOrderBook.Trade(mmIds[0], mm, bob, false, BID1, 1, uint256(BID1) * TICK, LOT);
        vm.prank(bob);
        (uint64 filled,) = ob.placeMarketOrder(false, 1, 1, 1, false);
        assertEq(filled, 1);
        assertEq(ch.getAccount(carol).reservedOrderMargin, 0, "evicted remainder released");
        assertEq(ob.openOrderCount(carol), 0);
        assertEq(ch.getPosition(carol).size, 0);
        _assertI2();
    }
}

/// @notice CR-007 on the REAL OrderBook + FundingSwapMarket (over the real perp CH): paused ⇒ Skip with ΣK and Σq
///         unchanged; matured ⇒ Evict.
contract MakerFillSkipSwapTest is Test {
    uint256 constant I0 = 0.029e18;
    uint256 constant STICK = 1e14; // 1 bp APR
    uint256 constant SLOT = 1000e18;

    MockERC20 ausd;
    MockOracleAdapter oracle;
    InsuranceFund fund;
    ClearingHouse ch;
    OrderBook ob;
    FundingSwapMarket fs;
    OrderBook sob;
    address owner = makeAddr("owner");
    address sam = makeAddr("sam"); // swap MM
    address alice = makeAddr("alice");
    address dave = makeAddr("dave");
    uint256 maturity;
    uint64 samBid;
    uint64 daveBid;

    function setUp() public {
        vm.roll(1_000_000);
        vm.warp(1_790_000_000);
        ausd = new MockERC20("Test AUSD", "tAUSD", 6);
        oracle = new MockOracleAdapter(I0);
        fund = new InsuranceFund(address(ausd), owner);
        ch = new ClearingHouse(
            address(ausd),
            address(oracle),
            address(fund),
            RiskParams(0.2e18, 0.1e18, 0.0005e18, -0.0001e18, 0.01e18, 0.5e18, 250_000e18, 25_000e18),
            FundingParams(0.002e18, 3_472_222_222, 555_555_555_556, 555_555_556, 300, 0.05e18),
            owner
        );
        ob = new OrderBook(address(ch), 1e12, 100e18);
        maturity = block.timestamp + 30 days;
        fs = new FundingSwapMarket(
            address(ch),
            address(ausd),
            address(fund),
            uint64(maturity),
            SwapParams(0.05e18, 86_400, 1.5e18, 0.002e18, -0.0005e18, 0.2e18, 0.5e18, 2_000_000e18, 200_000e18 * 10),
            owner
        );
        sob = new OrderBook(address(fs), STICK, SLOT);
        vm.startPrank(owner);
        ch.setOrderBook(address(ob));
        fs.setOrderBook(address(sob));
        fund.setMarketAuthorized(address(ch), true);
        fund.setMarketAuthorized(address(fs), true);
        vm.stopPrank();
        _swapFund(sam, 100_000e6);
        _swapFund(alice, 10_000e6);
        _swapFund(dave, 10_000e6);
    }

    function _swapFund(address who, uint256 amt) internal {
        ausd.mint(who, amt);
        vm.startPrank(who);
        ausd.approve(address(fs), amt);
        fs.deposit(amt);
        vm.stopPrank();
    }

    /// alice long 10 lots against dave; dave rests a reducing bid (`daveTick`, 2 lots); sam an increasing bid at 11.8%.
    function _setup(uint32 daveTick) internal {
        vm.prank(dave);
        sob.placeLimitOrder(false, 11_250, 10, 0);
        vm.prank(alice);
        sob.placeMarketOrder(true, 10, 11_250, 10, false);
        vm.prank(dave);
        (daveBid,) = sob.placeLimitOrder(true, daveTick, 2, 0);
        vm.prank(sam);
        (samBid,) = sob.placeLimitOrder(true, 11_180, 100, 0);
    }

    function _sums() internal view returns (int256 sq, int256 sk) {
        address[3] memory who = [sam, alice, dave];
        for (uint256 i; i < 3; ++i) {
            sq += fs.getPosition(who[i]).size;
            sk += fs.getPosition(who[i]).fixedAprNotional;
        }
    }

    function test_paused_skip_sumsUnchanged() public {
        _setup(11_150); // dave deeper than sam
        vm.prank(owner);
        fs.setPaused(true);
        (uint256 lo0, uint256 so0) = fs.openInterest();
        uint256 res = fs.getAccount(sam).reservedOrderMargin;
        int256 kSam = fs.getPosition(sam).fixedAprNotional;
        vm.expectEmit(address(sob));
        emit IOrderBook.MakerFillSkipped(samBid, sam);
        vm.prank(alice);
        (uint64 filled,) = sob.placeMarketOrder(false, 10, 1, 0, true);
        assertEq(filled, 0);
        assertEq(sob.getOrder(samBid).remainingLots, 100, "sam's order rests");
        assertEq(sob.getOrder(daveBid).remainingLots, 2, "deeper level untouched");
        assertEq(fs.getAccount(sam).reservedOrderMargin, res, "reservation kept");
        assertEq(fs.getPosition(sam).fixedAprNotional, kSam);
        assertEq(fs.getPosition(sam).size, 0);
        (uint256 lo1, uint256 so1) = fs.openInterest();
        assertEq(lo1, lo0);
        assertEq(so1, so0);
        (int256 sq, int256 sk) = _sums();
        assertEq(sq, 0, "sum q");
        assertEq(sk, 0, "sum K");
    }

    function test_paused_mixed_partialFill_sumKZero() public {
        _setup(11_190); // dave's reducing bid ahead of sam
        vm.prank(owner);
        fs.setPaused(true);
        vm.expectEmit(address(sob));
        emit IOrderBook.MakerFillSkipped(samBid, sam);
        vm.prank(alice);
        (uint64 filled,) = sob.placeMarketOrder(false, 10, 1, 0, true);
        assertEq(filled, 2);
        assertEq(fs.getPosition(alice).size, 8 * int256(SLOT));
        assertEq(fs.getPosition(dave).size, -8 * int256(SLOT));
        assertEq(sob.getOrder(samBid).remainingLots, 100);
        (int256 sq, int256 sk) = _sums();
        assertEq(sq, 0, "sum q");
        assertEq(sk, 0, "sum K: the taker got exactly minus the filled makers' kDeltas");
        (uint256 lo, uint256 so) = fs.openInterest();
        assertEq(lo, so);
        assertEq(lo, 8 * SLOT);
    }

    function test_matured_evicts_thenReducingMakerFills() public {
        _setup(11_150);
        vm.warp(maturity);
        vm.expectEmit(address(sob));
        emit IOrderBook.OrderEvicted(samBid, sam, 100);
        vm.prank(alice);
        (uint64 filled,) = sob.placeMarketOrder(false, 10, 1, 0, true);
        assertEq(filled, 2, "dave's reducing bid fills after sam's eviction");
        assertEq(sob.getOrder(samBid).remainingLots, 0);
        assertEq(fs.getAccount(sam).reservedOrderMargin, 0, "evicted reservation released");
        assertEq(sob.openOrderCount(sam), 0);
        (int256 sq, int256 sk) = _sums();
        assertEq(sq, 0);
        assertEq(sk, 0);
    }
}
