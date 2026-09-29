// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {IOrderBook} from "../../src/interfaces/IOrderBook.sol";
import {IMarginEngine} from "../../src/interfaces/IMarginEngine.sol";
import {PulseConstants} from "../../src/interfaces/PulseTypes.sol";
import {TickBitmap} from "../../src/orderbook/libraries/TickBitmap.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {RecordingEngine} from "./OrderBookEngine.t.sol";

contract OrderBookTest is Test {
    OrderBook ob;
    RecordingEngine eng;

    uint256 constant TICK = 1e12; // 1e-6 AUSD (perp)
    uint256 constant LOT = 100e18; // 100 MON
    uint8 constant POST_ONLY = 1;
    uint8 constant IOC = 2;
    uint8 constant REDUCE_ONLY = 4;
    uint32 constant NO_ASK = type(uint32).max;
    // `forge inspect OrderBook storage-layout`: _levels[tick] = 1 slot, _orders[slot] = 2 slots
    uint256 constant LEVELS_BASE = 131_588;
    uint256 constant ORDERS_BASE = 16_908_804;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    function setUp() public {
        eng = new RecordingEngine();
        ob = new OrderBook(address(eng), TICK, LOT);
        eng.setOrderBook(address(ob));
    }

    function _limit(address who, bool isBid, uint32 tick, uint64 lots) internal returns (uint64 id, uint64 filled) {
        vm.prank(who);
        return ob.placeLimitOrder(isBid, tick, lots, 0);
    }

    function _px(uint32 tick) internal pure returns (uint256) {
        return uint256(tick) * TICK;
    }

    // ─── constructor & views ──────────────────────────────────────────────────────────────────────────
    function test_constructor() public view {
        assertEq(ob.clearingHouse(), address(eng));
        assertEq(ob.tickSize(), TICK);
        assertEq(ob.lotSize(), LOT);
        assertEq(ob.bestBid(), 0);
        assertEq(ob.bestAsk(), NO_ASK);
        (uint256 mid, bool valid) = ob.midPrice();
        assertEq(mid, 0);
        assertFalse(valid);
        (uint256 p, uint64 b) = ob.lastTrade();
        assertEq(p, 0);
        assertEq(b, 0);
    }

    function test_constructor_revertsOnZeroParams() public {
        vm.expectRevert(IOrderBook.InvalidSize.selector);
        new OrderBook(address(eng), 0, LOT);
        vm.expectRevert(IOrderBook.InvalidSize.selector);
        new OrderBook(address(eng), TICK, 0);
    }

    // ─── resting ──────────────────────────────────────────────────────────────────────────────────────
    function test_place_rests_reservesAndIndexes() public {
        vm.expectEmit(address(ob));
        emit IOrderBook.OrderPlaced(uint64(1 << 32 | 1), alice, true, 29_000, 5, 0);
        (uint64 id, uint64 filled) = _limit(alice, true, 29_000, 5);
        assertEq(filled, 0);
        assertEq(id, uint64(1 << 32 | 1), "orderId = seq<<32 | slot");
        assertEq(ob.bestBid(), 29_000);
        (uint64 lots, uint32 count) = ob.getLevel(29_000);
        assertEq(lots, 5);
        assertEq(count, 1);
        assertEq(ob.openOrderCount(alice), 1);
        assertEq(eng.reservedWad(alice), 5 * LOT * _px(29_000) / 1e18);
        IOrderBook.OrderView memory o = ob.getOrder(id);
        assertEq(o.maker, alice);
        assertTrue(o.isBid);
        assertEq(o.tick, 29_000);
        assertEq(o.remainingLots, 5);
        assertEq(o.placedBlock, block.number);
    }

    function test_place_bestPricesTrackBothSides() public {
        _limit(alice, true, 100, 1);
        _limit(alice, true, 102, 1);
        _limit(alice, true, 101, 1);
        _limit(bob, false, 110, 1);
        _limit(bob, false, 105, 1);
        assertEq(ob.bestBid(), 102);
        assertEq(ob.bestAsk(), 105);
        (uint256 mid, bool valid) = ob.midPrice();
        assertTrue(valid);
        assertEq(mid, (102 + 105) * TICK / 2);
        (uint32[] memory t, uint64[] memory l) = ob.getDepth(true, 5);
        assertEq(t.length, 3);
        assertEq(t[0], 102);
        assertEq(t[1], 101);
        assertEq(t[2], 100);
        assertEq(l[0], 1);
        (t,) = ob.getDepth(false, 1);
        assertEq(t.length, 1);
        assertEq(t[0], 105);
    }

    function test_place_reverts() public {
        vm.startPrank(alice);
        vm.expectRevert(IOrderBook.InvalidTick.selector);
        ob.placeLimitOrder(true, 0, 1, 0);
        vm.expectRevert(IOrderBook.InvalidTick.selector);
        ob.placeLimitOrder(true, uint32(TickBitmap.MAX_TICK + 1), 1, 0);
        vm.expectRevert(IOrderBook.InvalidSize.selector);
        ob.placeLimitOrder(true, 100, 0, 0);
        vm.stopPrank();
        eng.setRejectReserve(alice, true);
        vm.prank(alice);
        vm.expectRevert(IMarginEngine.InsufficientMargin.selector);
        ob.placeLimitOrder(true, 100, 1, 0);
    }

    function test_place_openOrderCap() public {
        for (uint256 i; i < PulseConstants.MAX_OPEN_ORDERS_PER_ACCOUNT; ++i) {
            _limit(alice, true, uint32(100 + i), 1);
        }
        vm.prank(alice);
        vm.expectRevert(IOrderBook.TooManyOpenOrders.selector);
        ob.placeLimitOrder(true, 50, 1, 0);
        // taking liquidity (IOC) is still allowed at the cap
        _limit(bob, false, 200, 1);
        vm.prank(alice);
        (, uint64 filled) = ob.placeLimitOrder(true, 200, 1, IOC);
        assertEq(filled, 1);
    }

    function test_postOnly() public {
        _limit(bob, false, 105, 1);
        vm.prank(alice);
        vm.expectRevert(IOrderBook.PostOnlyWouldCross.selector);
        ob.placeLimitOrder(true, 105, 1, POST_ONLY);
        vm.prank(alice);
        (uint64 id,) = ob.placeLimitOrder(true, 104, 1, POST_ONLY);
        assertGt(id, 0);
    }

    // ─── price-time priority ──────────────────────────────────────────────────────────────────────────
    function test_priority_fifoWithinLevel() public {
        (uint64 a,) = _limit(alice, false, 105, 2);
        (uint64 b,) = _limit(bob, false, 105, 2);
        vm.expectEmit(address(ob));
        emit IOrderBook.Trade(a, alice, carol, true, 105, 2, _px(105), 2 * LOT);
        vm.expectEmit(address(ob));
        emit IOrderBook.Trade(b, bob, carol, true, 105, 1, _px(105), LOT);
        (uint64 id, uint64 filled) = _limit(carol, true, 105, 3);
        assertEq(filled, 3);
        assertEq(id, 0, "fully filled: nothing rests");
        assertEq(ob.getOrder(a).remainingLots, 0, "first in, first filled");
        assertEq(ob.getOrder(b).remainingLots, 1);
        (uint64 lots, uint32 count) = ob.getLevel(105);
        assertEq(lots, 1);
        assertEq(count, 1);
    }

    function test_priority_betterPriceFirst() public {
        (uint64 hi,) = _limit(alice, false, 106, 1);
        (uint64 lo,) = _limit(bob, false, 105, 1);
        vm.expectEmit(address(ob));
        emit IOrderBook.Trade(lo, bob, carol, true, 105, 1, _px(105), LOT);
        vm.expectEmit(address(ob));
        emit IOrderBook.Trade(hi, alice, carol, true, 106, 1, _px(106), LOT);
        _limit(carol, true, 110, 2);
        assertEq(ob.bestAsk(), NO_ASK);
    }

    function test_priority_bidsHighestFirst() public {
        _limit(alice, true, 100, 1);
        (uint64 best,) = _limit(bob, true, 101, 1);
        vm.expectEmit(address(ob));
        emit IOrderBook.Trade(best, bob, carol, false, 101, 1, _px(101), LOT);
        _limit(carol, false, 100, 1);
        assertEq(ob.bestBid(), 100);
    }

    // ─── matching & settlement protocol ───────────────────────────────────────────────────────────────
    function test_match_takerSettledOnceWithAggregate() public {
        _limit(alice, false, 105, 1);
        _limit(bob, false, 107, 2);
        (uint64 id, uint64 filled) = _limit(carol, true, 108, 5);
        assertEq(filled, 3);
        assertEq(eng.takerCalls(), 1);
        assertEq(eng.lastTaker(), carol);
        assertTrue(eng.lastTakerIsBid());
        assertEq(eng.lastTakerSize(), 3 * LOT);
        assertEq(eng.lastTakerNotional(), (LOT * _px(105) + 2 * LOT * _px(107)) / 1e18);
        assertFalse(eng.lastReduceOnly());
        // remainder (2 lots) rests at 108 with a reservation for the remainder only
        assertGt(id, 0);
        assertEq(ob.getOrder(id).remainingLots, 2);
        assertEq(ob.bestBid(), 108);
        assertEq(ob.bestAsk(), NO_ASK);
        assertEq(eng.reservedWad(carol), 2 * LOT * _px(108) / 1e18);
        assertEq(eng.reservedWad(alice), 0, "maker reservation consumed by the fill");
        assertEq(eng.reservedWad(bob), 0);
        assertEq(eng.position(carol), int256(3 * LOT));
        assertEq(eng.position(alice) + eng.position(bob), -int256(3 * LOT));
        (uint256 p, uint64 b) = ob.lastTrade();
        assertEq(p, _px(107));
        assertEq(b, block.number);
    }

    function test_match_noFillNoTakerSettle() public {
        _limit(alice, false, 105, 1);
        _limit(carol, true, 104, 1);
        assertEq(eng.takerCalls(), 0);
    }

    function test_match_evictsFailingMakerAndContinues() public {
        (uint64 a,) = _limit(alice, false, 105, 2);
        (uint64 b,) = _limit(bob, false, 105, 1);
        eng.setFailMaker(alice, true);
        vm.expectEmit(address(ob));
        emit IOrderBook.OrderEvicted(a, alice, 2);
        vm.expectEmit(address(ob));
        emit IOrderBook.Trade(b, bob, carol, true, 105, 1, _px(105), LOT);
        (, uint64 filled) = _limit(carol, true, 105, 1);
        assertEq(filled, 1);
        assertEq(eng.reservedWad(alice), 0, "evicted remainder released");
        assertEq(ob.openOrderCount(alice), 0);
        assertEq(ob.getOrder(a).remainingLots, 0);
        (uint64 lots, uint32 count) = ob.getLevel(105);
        assertEq(lots, 0);
        assertEq(count, 0);
        assertEq(ob.bestAsk(), NO_ASK);
    }

    function test_match_boundedByMaxFills_remainderDroppedWhileCrossing() public {
        uint256 n = PulseConstants.MAX_FILLS_PER_ORDER + 8;
        for (uint256 i; i < n; ++i) {
            _limit(address(uint160(0x1000 + i)), false, 105, 1);
        }
        (uint64 id, uint64 filled) = _limit(carol, true, 105, uint64(n));
        assertEq(filled, PulseConstants.MAX_FILLS_PER_ORDER);
        assertEq(id, 0, "remainder would cross: never rests (bestBid < bestAsk)");
        assertEq(ob.bestAsk(), 105);
        assertEq(ob.bestBid(), 0);
        (uint64 lots,) = ob.getLevel(105);
        assertEq(lots, 8);
        assertEq(eng.reservedWad(carol), 0);
    }

    function test_match_selfTradeExpiresRestingOrder() public {
        (uint64 own,) = _limit(alice, false, 105, 2);
        (uint64 other,) = _limit(bob, false, 105, 1);
        vm.expectEmit(address(ob));
        emit IOrderBook.OrderCancelled(own, alice, 2);
        vm.expectEmit(address(ob));
        emit IOrderBook.Trade(other, bob, alice, true, 105, 1, _px(105), LOT);
        (, uint64 filled) = _limit(alice, true, 105, 1);
        assertEq(filled, 1);
        assertEq(eng.reservedWad(alice), 0);
        assertEq(ob.openOrderCount(alice), 0);
    }

    function test_ioc_dropsRemainder() public {
        _limit(alice, false, 105, 1);
        vm.prank(carol);
        (uint64 id, uint64 filled) = ob.placeLimitOrder(true, 105, 3, IOC);
        assertEq(id, 0);
        assertEq(filled, 1);
        assertEq(ob.bestBid(), 0);
        assertEq(ob.openOrderCount(carol), 0);
    }

    function test_reduceOnly_passedToEngine_neverRests() public {
        _limit(alice, false, 105, 1);
        vm.prank(carol);
        (uint64 id, uint64 filled) = ob.placeLimitOrder(true, 105, 3, REDUCE_ONLY);
        assertEq(filled, 1);
        assertEq(id, 0);
        assertTrue(eng.lastReduceOnly());
    }

    // ─── market orders ────────────────────────────────────────────────────────────────────────────────
    function test_market_fillsWithinLimit() public {
        _limit(alice, false, 100, 1);
        _limit(bob, false, 104, 1);
        _limit(dave, false, 110, 1);
        vm.prank(carol);
        (uint64 filled, uint256 avg) = ob.placeMarketOrder(true, 5, 105, 2, false);
        assertEq(filled, 2);
        assertEq(avg, (_px(100) + _px(104)) / 2);
        assertEq(ob.bestAsk(), 110);
        assertEq(ob.openOrderCount(carol), 0);
    }

    function test_market_sellSide() public {
        _limit(alice, true, 100, 1);
        vm.prank(carol);
        (uint64 filled, uint256 avg) = ob.placeMarketOrder(false, 1, 1, 1, true);
        assertEq(filled, 1);
        assertEq(avg, _px(100));
        assertTrue(eng.lastReduceOnly());
        assertFalse(eng.lastTakerIsBid());
    }

    function test_market_reverts() public {
        vm.startPrank(carol);
        vm.expectRevert(IOrderBook.InvalidSize.selector);
        ob.placeMarketOrder(true, 0, 105, 0, false);
        vm.expectRevert(IOrderBook.NoLiquidity.selector);
        ob.placeMarketOrder(true, 1, 105, 0, false);
        vm.stopPrank();
        _limit(alice, false, 106, 1);
        vm.prank(carol);
        vm.expectRevert(IOrderBook.SlippageExceeded.selector);
        ob.placeMarketOrder(true, 1, 105, 1, false);
    }

    // ─── cancel ───────────────────────────────────────────────────────────────────────────────────────
    function test_cancel_releasesAndUnlinks() public {
        (uint64 a,) = _limit(alice, true, 100, 1);
        (uint64 b,) = _limit(alice, true, 100, 2);
        (uint64 c,) = _limit(alice, true, 100, 3);
        vm.expectEmit(address(ob));
        emit IOrderBook.OrderCancelled(b, alice, 2);
        vm.prank(alice);
        ob.cancelOrder(b); // middle of the FIFO
        (uint64 lots, uint32 count) = ob.getLevel(100);
        assertEq(lots, 4);
        assertEq(count, 2);
        assertEq(eng.reservedWad(alice), 4 * LOT * _px(100) / 1e18);
        assertEq(ob.openOrderCount(alice), 2);
        // FIFO intact: a then c
        vm.expectEmit(address(ob));
        emit IOrderBook.Trade(a, alice, bob, false, 100, 1, _px(100), LOT);
        vm.expectEmit(address(ob));
        emit IOrderBook.Trade(c, alice, bob, false, 100, 3, _px(100), 3 * LOT);
        _limit(bob, false, 100, 4);
        assertEq(ob.bestBid(), 0);
    }

    function test_cancel_bestLevelRecomputed() public {
        _limit(alice, true, 100, 1);
        (uint64 top,) = _limit(alice, true, 90_000, 1);
        vm.prank(alice);
        ob.cancelOrder(top);
        assertEq(ob.bestBid(), 100);
        (uint64 lo,) = _limit(bob, false, 200, 1);
        (uint64 hi,) = _limit(bob, false, 1_000_000, 1);
        vm.prank(bob);
        ob.cancelOrder(lo);
        assertEq(ob.bestAsk(), 1_000_000);
        vm.prank(bob);
        ob.cancelOrder(hi);
        assertEq(ob.bestAsk(), NO_ASK);
    }

    function test_cancel_reverts() public {
        (uint64 a,) = _limit(alice, true, 100, 1);
        vm.prank(bob);
        vm.expectRevert(IOrderBook.NotOrderOwner.selector);
        ob.cancelOrder(a);
        vm.prank(alice);
        vm.expectRevert(IOrderBook.OrderNotFound.selector);
        ob.cancelOrder(a + 1);
        vm.prank(alice);
        ob.cancelOrder(a);
        vm.prank(alice);
        vm.expectRevert(IOrderBook.OrderNotFound.selector);
        ob.cancelOrder(a); // already cancelled
        vm.prank(alice);
        vm.expectRevert(IOrderBook.OrderNotFound.selector);
        ob.cancelOrder(0);
    }

    function test_cancel_staleIdAfterSlotReuse() public {
        (uint64 a,) = _limit(alice, true, 100, 1);
        vm.prank(alice);
        ob.cancelOrder(a);
        (uint64 b,) = _limit(alice, true, 100, 1);
        assertEq(uint32(b), uint32(a), "slot recycled");
        assertGt(b, a, "ids strictly increase");
        vm.prank(alice);
        vm.expectRevert(IOrderBook.OrderNotFound.selector);
        ob.cancelOrder(a); // old id must not cancel the new occupant
    }

    function test_cancelOrders_batch() public {
        uint64[] memory ids = new uint64[](3);
        for (uint256 i; i < 3; ++i) {
            (ids[i],) = _limit(alice, false, uint32(200 + i), 1);
        }
        vm.prank(alice);
        ob.cancelOrders(ids);
        assertEq(ob.openOrderCount(alice), 0);
        assertEq(ob.bestAsk(), NO_ASK);
        uint64[] memory tooMany = new uint64[](PulseConstants.MAX_BATCH + 1);
        vm.prank(alice);
        vm.expectRevert(IOrderBook.BatchTooLarge.selector);
        ob.cancelOrders(tooMany);
    }

    // ─── replace ──────────────────────────────────────────────────────────────────────────────────────
    function test_replace_movesOrderAndReusesSlot() public {
        (uint64 a,) = _limit(alice, true, 100, 1);
        vm.prank(alice);
        (uint64 b, uint64 filled) = ob.replaceOrder(a, 101, 3, 0);
        assertEq(filled, 0);
        assertEq(uint32(b), uint32(a), "same storage slot");
        assertGt(b, a);
        assertEq(ob.getOrder(a).remainingLots, 0);
        assertEq(ob.getOrder(b).remainingLots, 3);
        assertEq(ob.bestBid(), 101);
        (uint64 lots,) = ob.getLevel(100);
        assertEq(lots, 0);
        assertEq(eng.reservedWad(alice), 3 * LOT * _px(101) / 1e18);
        assertEq(ob.openOrderCount(alice), 1);
    }

    function test_replace_canCross() public {
        _limit(bob, false, 105, 1);
        (uint64 a,) = _limit(alice, true, 100, 2);
        vm.prank(alice);
        (uint64 b, uint64 filled) = ob.replaceOrder(a, 105, 2, 0);
        assertEq(filled, 1);
        assertEq(ob.getOrder(b).remainingLots, 1);
    }

    function test_replace_reverts() public {
        (uint64 a,) = _limit(alice, true, 100, 1);
        vm.prank(bob);
        vm.expectRevert(IOrderBook.NotOrderOwner.selector);
        ob.replaceOrder(a, 101, 1, 0);
        vm.prank(alice);
        vm.expectRevert(IOrderBook.OrderNotFound.selector);
        ob.replaceOrder(a + 7, 101, 1, 0);
    }

    // ─── views ────────────────────────────────────────────────────────────────────────────────────────
    function test_getDepth_bounds() public {
        vm.expectRevert(IOrderBook.BatchTooLarge.selector);
        ob.getDepth(true, PulseConstants.MAX_BATCH + 1);
        (uint32[] memory t,) = ob.getDepth(true, 3);
        assertEq(t.length, 0);
        assertEq(ob.getOrder(12_345).maker, address(0));
        (uint64 lots, uint32 count) = ob.getLevel(type(uint32).max);
        assertEq(lots + count, 0);
    }

    function test_onlyEngineCanBeHookedByBook() public {
        vm.expectRevert(IMarginEngine.OnlyOrderBook.selector);
        eng.settleTakerFill(alice, true, 1, 1, false);
    }

    // ─── audit: settlement protocol ───────────────────────────────────────────────────────────────────
    function test_match_takerSettledOnceAfterAllMakerFills() public {
        _limit(alice, false, 105, 1);
        _limit(bob, false, 106, 1);
        _limit(dave, false, 107, 1);
        _limit(carol, true, 107, 3);
        assertEq(eng.makerCalls(), 3);
        assertEq(eng.takerCalls(), 1);
        assertEq(eng.makerCallsAtTakerSettle(), 3, "taker settled after every maker fill");
    }

    function test_match_allMakersEvicted_noTakerSettle_orderRests() public {
        (uint64 a,) = _limit(alice, false, 105, 1);
        (uint64 b,) = _limit(bob, false, 105, 1);
        eng.setFailMaker(alice, true);
        eng.setFailMaker(bob, true);
        vm.expectEmit(address(ob));
        emit IOrderBook.OrderEvicted(a, alice, 1);
        vm.expectEmit(address(ob));
        emit IOrderBook.OrderEvicted(b, bob, 1);
        (uint64 id, uint64 filled) = _limit(carol, true, 105, 2);
        assertEq(filled, 0);
        assertEq(eng.takerCalls(), 0, "no settleTakerFill when filled == 0");
        assertGt(id, 0, "book no longer crosses: order rests");
        assertEq(ob.bestBid(), 105);
        assertEq(ob.bestAsk(), NO_ASK);
        (uint256 p,) = ob.lastTrade();
        assertEq(p, 0, "evictions are not trades");
    }

    function test_match_evictionsCountTowardFillCap() public {
        uint256 cap = PulseConstants.MAX_FILLS_PER_ORDER;
        for (uint256 i; i < cap; ++i) {
            address m = address(uint160(0x1000 + i));
            _limit(m, false, 105, 1);
            eng.setFailMaker(m, true);
        }
        _limit(alice, false, 105, 1); // healthy maker behind 32 failing ones
        (uint64 id, uint64 filled) = _limit(carol, true, 105, 1);
        assertEq(eng.makerCalls(), cap, "at most MAX_FILLS_PER_ORDER hook calls");
        assertEq(filled, 0);
        assertEq(id, 0, "remainder still crosses alice: dropped");
        assertEq(eng.takerCalls(), 0);
        assertEq(ob.bestAsk(), 105);
        (uint64 lots, uint32 count) = ob.getLevel(105);
        assertEq(lots, 1);
        assertEq(count, 1);
    }

    function test_match_capReached_remainderRestsWhenNoLongerCrossing() public {
        uint256 cap = PulseConstants.MAX_FILLS_PER_ORDER;
        for (uint256 i; i < cap; ++i) {
            _limit(address(uint160(0x1000 + i)), false, 105, 1);
        }
        (uint64 id, uint64 filled) = _limit(carol, true, 105, uint64(cap + 8));
        assertEq(filled, cap);
        assertGt(id, 0, "limit remainder rests");
        assertEq(ob.getOrder(id).remainingLots, 8);
        assertEq(ob.bestBid(), 105);
        assertEq(ob.bestAsk(), NO_ASK);
        assertEq(eng.reservedWad(carol), 8 * LOT * _px(105) / 1e18);
    }

    // ─── audit: flags ─────────────────────────────────────────────────────────────────────────────────
    function test_postOnly_sellSideAndNonCrossingEqualBookEdge() public {
        _limit(bob, true, 100, 1);
        vm.prank(alice);
        vm.expectRevert(IOrderBook.PostOnlyWouldCross.selector);
        ob.placeLimitOrder(false, 100, 1, POST_ONLY);
        vm.prank(alice);
        vm.expectRevert(IOrderBook.PostOnlyWouldCross.selector);
        ob.placeLimitOrder(false, 99, 1, POST_ONLY);
        vm.prank(alice);
        (uint64 id, uint64 filled) = ob.placeLimitOrder(false, 101, 1, POST_ONLY);
        assertGt(id, 0);
        assertEq(filled, 0);
        assertEq(eng.makerCalls(), 0);
    }

    function test_ioc_nothingToFill_neverRestsNorReserves() public {
        vm.prank(carol);
        (uint64 id, uint64 filled) = ob.placeLimitOrder(true, 105, 3, IOC);
        assertEq(id, 0);
        assertEq(filled, 0);
        assertEq(ob.bestBid(), 0);
        assertEq(eng.reservedWad(carol), 0);
        assertEq(eng.takerCalls(), 0);
    }

    function test_reduceOnly_notSetWithoutFlag_andNothingRestsOnNoFill() public {
        _limit(alice, false, 105, 1);
        _limit(carol, true, 105, 1);
        assertFalse(eng.lastReduceOnly());
        vm.prank(carol);
        (uint64 id, uint64 filled) = ob.placeLimitOrder(true, 104, 1, REDUCE_ONLY);
        assertEq(id + filled, 0);
        assertEq(ob.bestBid(), 0);
    }

    function test_market_sellHonoursLimitTickAndMinFilled() public {
        _limit(alice, true, 100, 1);
        _limit(bob, true, 98, 1);
        _limit(dave, true, 95, 1);
        vm.prank(carol);
        vm.expectRevert(IOrderBook.SlippageExceeded.selector);
        ob.placeMarketOrder(false, 3, 98, 3, false);
        vm.prank(carol);
        (uint64 filled, uint256 avg) = ob.placeMarketOrder(false, 3, 98, 2, false);
        assertEq(filled, 2, "stops at limitTick (worst acceptable price)");
        assertEq(avg, (_px(100) + _px(98)) / 2);
        assertEq(ob.bestBid(), 95);
        assertEq(eng.takerCalls(), 1);
        assertEq(eng.lastTakerNotional(), (LOT * _px(100) + LOT * _px(98)) / 1e18);
    }

    function test_market_zeroFillWithZeroMin_noTakerSettle() public {
        _limit(alice, false, 110, 1);
        vm.prank(carol);
        (uint64 filled, uint256 avg) = ob.placeMarketOrder(true, 1, 105, 0, false);
        assertEq(filled, 0);
        assertEq(avg, 0);
        assertEq(eng.takerCalls(), 0);
    }

    // ─── audit: replace, views ────────────────────────────────────────────────────────────────────────
    function test_replace_atOpenOrderCap() public {
        uint64 last;
        for (uint256 i; i < PulseConstants.MAX_OPEN_ORDERS_PER_ACCOUNT; ++i) {
            (last,) = _limit(alice, true, uint32(100 + i), 1);
        }
        vm.prank(alice);
        (uint64 id,) = ob.replaceOrder(last, 50, 2, 0);
        assertGt(id, 0, "replace frees its own slot before the cap check");
        assertEq(ob.openOrderCount(alice), PulseConstants.MAX_OPEN_ORDERS_PER_ACCOUNT);
    }

    function test_replace_losesTimePriority() public {
        (uint64 a,) = _limit(alice, false, 105, 1);
        (uint64 b,) = _limit(bob, false, 105, 1);
        vm.prank(alice);
        (uint64 a2,) = ob.replaceOrder(a, 105, 1, 0);
        vm.expectEmit(address(ob));
        emit IOrderBook.Trade(b, bob, carol, true, 105, 1, _px(105), LOT);
        _limit(carol, true, 105, 1);
        assertEq(ob.getOrder(a2).remainingLots, 1);
    }

    function test_getDepth_capsAtMaxBatch() public {
        for (uint256 i; i < 40; ++i) {
            _limit(address(uint160(0x1000 + i)), false, uint32(200 + 3 * i), 1);
        }
        (uint32[] memory t, uint64[] memory l) = ob.getDepth(false, PulseConstants.MAX_BATCH);
        assertEq(t.length, 32);
        assertEq(l.length, 32);
        for (uint256 i; i < 32; ++i) {
            assertEq(t[i], 200 + 3 * i, "ascending from bestAsk");
            assertEq(l[i], 1);
        }
    }

    function test_emptyBookSentinels_afterDrain() public {
        _limit(alice, true, 100, 1);
        _limit(bob, false, 101, 1);
        _limit(carol, false, 100, 1);
        _limit(carol, true, 101, 1);
        assertEq(ob.bestBid(), 0);
        assertEq(ob.bestAsk(), type(uint32).max);
        (, bool valid) = ob.midPrice();
        assertFalse(valid);
    }

    // ─── audit: MIP-8 slot recycling ──────────────────────────────────────────────────────────────────
    function test_slots_recycledViaFreeList() public {
        uint64[] memory ids = new uint64[](3);
        for (uint256 i; i < 3; ++i) {
            (ids[i],) = _limit(alice, true, uint32(100 + i), 1);
        }
        vm.prank(alice);
        ob.cancelOrders(ids);
        uint256 seen;
        for (uint256 i; i < 3; ++i) {
            (uint64 id,) = _limit(bob, false, uint32(200 + i), 1);
            uint32 slot = uint32(id);
            assertTrue(slot >= 1 && slot <= 3, "reused a freed slot, no fresh one");
            seen |= 1 << slot;
        }
        assertEq(seen, 0xE);
        (uint64 fresh,) = _limit(bob, false, 300, 1);
        assertEq(uint32(fresh), 4, "fresh slot only when the free list is empty");
    }

    function test_slots_neverZeroedOnCancelOrFill() public {
        (uint64 a,) = _limit(alice, true, 100, 1);
        vm.prank(alice);
        ob.cancelOrder(a);
        _assertNonZero(uint32(a), 100);
        (uint64 b,) = _limit(alice, false, 200, 1);
        _limit(bob, true, 200, 1); // full fill empties level 200
        _assertNonZero(uint32(b), 200);
    }

    function _assertNonZero(uint32 slot, uint32 tick) internal view {
        assertTrue(vm.load(address(ob), bytes32(ORDERS_BASE + 2 * uint256(slot))) != 0, "order word 0 zeroed");
        assertTrue(vm.load(address(ob), bytes32(ORDERS_BASE + 2 * uint256(slot) + 1)) != 0, "order word 1 zeroed");
        assertTrue(vm.load(address(ob), bytes32(LEVELS_BASE + tick)) != 0, "level slot zeroed");
    }

    // ─── audit: reentrancy ────────────────────────────────────────────────────────────────────────────
    function test_nonReentrant_allMutatingEntrypoints() public {
        (uint64 a,) = _limit(alice, false, 105, 1);
        uint64[] memory ids = new uint64[](1);
        ids[0] = a;
        bytes[5] memory calls = [
            abi.encodeCall(IOrderBook.placeLimitOrder, (true, 90, 1, 0)),
            abi.encodeCall(IOrderBook.placeMarketOrder, (true, 1, 105, 0, false)),
            abi.encodeCall(IOrderBook.cancelOrder, (a)),
            abi.encodeCall(IOrderBook.cancelOrders, (ids)),
            abi.encodeCall(IOrderBook.replaceOrder, (a, 106, 1, 0))
        ];
        for (uint256 i; i < calls.length; ++i) {
            eng.setReenter(calls[i]);
            // a crossing taker order reaches settleMakerFill, where the engine re-enters
            vm.prank(carol);
            vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
            ob.placeLimitOrder(true, 105, 1, 0);
            // a cancel reaches releaseOrderMargin
            vm.prank(alice);
            vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
            ob.cancelOrder(a);
        }
    }
}
