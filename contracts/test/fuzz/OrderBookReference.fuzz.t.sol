// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {IOrderBook} from "../../src/interfaces/IOrderBook.sol";
import {MeridianConstants} from "../../src/interfaces/MeridianTypes.sol";
import {RecordingEngine} from "../unit/OrderBookEngine.t.sol";

/// @notice WS-01 required test (A1 §2): random place / cancel / market sequences against a naive Solidity
///         reference model (unsorted array, linear best-price/FIFO search). After every op we compare every
///         fill (maker order id, tick, lots, in order), self-trade expiries, evictions, the taker's aggregate
///         notional (↑ buy / ↓ sell), best bid/ask, level totals and counts, and every resting order.
contract OrderBookReferenceFuzzTest is Test {
    // Deployed perp units by default (Σ size·price always a multiple of 1e18); the odd-units subclass makes the
    // taker-notional rounding observable.
    uint256 internal tickSize = 1e12;
    uint256 internal lotSize = 100e18;
    uint32 internal constant BASE = 1000;
    uint32 internal constant SPAN = 8; // ticks BASE−SPAN .. BASE+SPAN
    uint256 internal constant N_ACTORS = 4; // actor 3 can be made to fail its maker margin check (evictions)
    uint256 internal constant OPS = 48;

    struct MOrder {
        uint64 id;
        address maker;
        bool isBid;
        uint32 tick;
        uint64 lots;
        uint256 seq;
        bool live;
    }

    // expected events of one op: kind 0 = Trade, 1 = OrderCancelled (self-trade expiry), 2 = OrderEvicted
    struct Ev {
        uint8 kind;
        uint64 id;
        uint32 tick;
        uint64 lots;
    }

    RecordingEngine internal engine;
    OrderBook internal ob;
    address[N_ACTORS] internal actors;
    MOrder[] internal mo;
    Ev[] internal exp;
    uint256 internal seqCounter;

    function setUp() public virtual {
        engine = new RecordingEngine();
        ob = new OrderBook(address(engine), tickSize, lotSize);
        engine.setOrderBook(address(ob));
        for (uint256 i; i < N_ACTORS; ++i) {
            actors[i] = address(uint160(0xA000 + i));
        }
    }

    /// forge-config: default.fuzz.runs = 300
    function testFuzz_matchesReferenceModel(uint256 seed) public {
        for (uint256 i; i < OPS; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 kind = r % 10;
            if (kind < 5) _opLimit(r);
            else if (kind < 7) _opMarket(r);
            else if (kind < 9) _opCancel(r);
            else engine.setFailMaker(actors[3], (r >> 8) & 1 == 1);
            _compareBook();
        }
    }

    // ─── ops ──────────────────────────────────────────────────────────────────
    function _opLimit(uint256 r) internal {
        address taker = actors[(r >> 8) % N_ACTORS];
        bool isBid = (r >> 16) & 1 == 1;
        uint32 tick = BASE - SPAN + uint32((r >> 24) % (2 * SPAN + 1));
        uint64 lots = _lots(r >> 40);
        uint8 flags = [uint8(0), 0, 0, 1, 2, 4][(r >> 80) % 6];
        bool rests = flags & 6 == 0;

        if (flags & 1 != 0 && _crosses(isBid, tick)) {
            vm.prank(taker);
            vm.expectRevert(IOrderBook.PostOnlyWouldCross.selector);
            ob.placeLimitOrder(isBid, tick, lots, flags);
            return;
        }
        (uint64 mFilled, uint256 mRaw) = _modelMatch(taker, isBid, tick, lots);
        uint256 takerCalls = engine.takerCalls();
        vm.recordLogs();
        vm.prank(taker);
        (uint64 id, uint64 filled) = ob.placeLimitOrder(isBid, tick, lots, flags);
        _compareEvents(vm.getRecordedLogs());
        assertEq(filled, mFilled, "filled");
        _checkTaker(takerCalls, taker, isBid, mFilled, mRaw);

        bool shouldRest = lots > mFilled && rests && !_crosses(isBid, tick);
        assertEq(id != 0, shouldRest, "rests iff remainder, resting flags and no cross");
        if (shouldRest) mo.push(MOrder(id, taker, isBid, tick, lots - mFilled, ++seqCounter, true));
    }

    function _opMarket(uint256 r) internal {
        address taker = actors[(r >> 8) % N_ACTORS];
        bool isBid = (r >> 16) & 1 == 1;
        uint64 lots = _lots(r >> 40);
        uint32 limit = isBid ? BASE + SPAN : BASE - SPAN;
        if ((r >> 80) % 4 == 0) limit = BASE; // sometimes a tight limit
        bool reduceOnly = (r >> 90) % 5 == 0;
        if (_best(!isBid) == type(uint256).max) {
            vm.prank(taker);
            vm.expectRevert(IOrderBook.NoLiquidity.selector);
            ob.placeMarketOrder(isBid, lots, limit, 0, reduceOnly);
            return;
        }
        (uint64 mFilled, uint256 mRaw) = _modelMatch(taker, isBid, limit, lots);
        uint256 takerCalls = engine.takerCalls();
        vm.recordLogs();
        vm.prank(taker);
        (uint64 filled, uint256 avg) = ob.placeMarketOrder(isBid, lots, limit, 0, reduceOnly);
        _compareEvents(vm.getRecordedLogs());
        assertEq(filled, mFilled, "market filled");
        if (mFilled != 0) assertEq(avg, mRaw / (uint256(mFilled) * lotSize), "VWAP rounds down");
        _checkTaker(takerCalls, taker, isBid, mFilled, mRaw);
        if (mFilled != 0) assertEq(engine.lastReduceOnly(), reduceOnly);
    }

    function _opCancel(uint256 r) internal {
        uint256 live;
        for (uint256 i; i < mo.length; ++i) {
            if (mo[i].live) ++live;
        }
        if (live == 0) return;
        uint256 pick = (r >> 8) % live;
        for (uint256 i; i < mo.length; ++i) {
            if (!mo[i].live) continue;
            if (pick != 0) {
                --pick;
                continue;
            }
            vm.prank(mo[i].maker);
            ob.cancelOrder(mo[i].id);
            mo[i].live = false;
            vm.prank(mo[i].maker);
            vm.expectRevert(IOrderBook.OrderNotFound.selector);
            ob.cancelOrder(mo[i].id);
            return;
        }
    }

    function _lots(uint256 r) internal pure returns (uint64) {
        return r % 8 == 0 ? uint64(1 + (r >> 3) % 600) : uint64(1 + (r >> 3) % 20);
    }

    // ─── reference model ──────────────────────────────────────────────────────
    /// @return j index of the best live order on the given side (max tick for bids, min for asks; FIFO), or max
    function _best(bool bids) internal view returns (uint256 j) {
        j = type(uint256).max;
        for (uint256 i; i < mo.length; ++i) {
            MOrder storage o = mo[i];
            if (!o.live || o.isBid != bids) continue;
            if (j == type(uint256).max) {
                j = i;
                continue;
            }
            MOrder storage b = mo[j];
            bool better = bids ? o.tick > b.tick : o.tick < b.tick;
            if (better || (o.tick == b.tick && o.seq < b.seq)) j = i;
        }
    }

    function _crosses(bool isBid, uint32 tick) internal view returns (bool) {
        uint256 j = _best(!isBid);
        if (j == type(uint256).max) return false;
        return isBid ? tick >= mo[j].tick : tick <= mo[j].tick;
    }

    function _modelMatch(address taker, bool isBid, uint32 limit, uint64 lots)
        internal
        returns (uint64 filled, uint256 raw)
    {
        delete exp;
        uint64 remaining = lots;
        for (uint256 visits; remaining != 0 && visits < MeridianConstants.MAX_FILLS_PER_ORDER; ++visits) {
            uint256 j = _best(!isBid);
            if (j == type(uint256).max) break;
            MOrder storage o = mo[j];
            if (isBid ? o.tick > limit : o.tick < limit) break;
            if (o.maker == taker) {
                exp.push(Ev(1, o.id, o.tick, o.lots));
                o.live = false;
                continue;
            }
            if (engine.failMaker(o.maker)) {
                exp.push(Ev(2, o.id, o.tick, o.lots));
                o.live = false;
                continue;
            }
            uint64 f = remaining < o.lots ? remaining : o.lots;
            exp.push(Ev(0, o.id, o.tick, f));
            raw += uint256(f) * lotSize * (uint256(o.tick) * tickSize);
            o.lots -= f;
            if (o.lots == 0) o.live = false;
            remaining -= f;
        }
        filled = lots - remaining;
    }

    // ─── comparisons ──────────────────────────────────────────────────────────
    function _compareEvents(Vm.Log[] memory logs) internal view {
        uint256 k;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(ob)) continue;
            bytes32 t0 = logs[i].topics[0];
            if (t0 == IOrderBook.Trade.selector) {
                (, uint32 tick, uint64 lots, uint256 price, uint256 size) =
                    abi.decode(logs[i].data, (bool, uint32, uint64, uint256, uint256));
                Ev memory e = exp[k++];
                assertEq(e.kind, 0, "expected a Trade");
                assertEq(uint64(uint256(logs[i].topics[1])), e.id, "fill maker order id");
                assertEq(tick, e.tick, "fill tick");
                assertEq(lots, e.lots, "fill lots");
                assertEq(price, uint256(tick) * tickSize);
                assertEq(size, uint256(lots) * lotSize);
            } else if (t0 == IOrderBook.OrderCancelled.selector || t0 == IOrderBook.OrderEvicted.selector) {
                Ev memory e = exp[k++];
                assertEq(e.kind, t0 == IOrderBook.OrderCancelled.selector ? 1 : 2, "expiry/eviction kind");
                assertEq(uint64(uint256(logs[i].topics[1])), e.id, "dropped order id");
                assertEq(abi.decode(logs[i].data, (uint64)), e.lots, "dropped lots");
            }
        }
        assertEq(k, exp.length, "all expected events seen");
    }

    function _checkTaker(uint256 callsBefore, address taker, bool isBid, uint64 filled, uint256 raw) internal view {
        if (filled == 0) {
            assertEq(engine.takerCalls(), callsBefore, "no taker fill when nothing filled");
            return;
        }
        assertEq(engine.takerCalls(), callsBefore + 1, "exactly one taker fill");
        assertEq(engine.makerCallsAtTakerSettle(), engine.makerCalls(), "taker settles after every maker");
        assertEq(engine.lastTaker(), taker);
        assertEq(engine.lastTakerIsBid(), isBid);
        assertEq(engine.lastTakerSize(), uint256(filled) * lotSize);
        uint256 q = raw / 1e18;
        uint256 expN = isBid && q * 1e18 != raw ? q + 1 : q;
        assertEq(engine.lastTakerNotional(), expN, "taker notional: up for buys, down for sells");
    }

    function _compareBook() internal view {
        uint256 jb = _best(true);
        uint256 ja = _best(false);
        assertEq(ob.bestBid(), jb == type(uint256).max ? 0 : mo[jb].tick, "bestBid");
        assertEq(ob.bestAsk(), ja == type(uint256).max ? type(uint32).max : mo[ja].tick, "bestAsk");
        if (jb != type(uint256).max && ja != type(uint256).max) assertLt(mo[jb].tick, mo[ja].tick, "I6 uncrossed");
        for (uint32 t = BASE - SPAN; t <= BASE + SPAN; ++t) {
            uint64 lots;
            uint32 count;
            for (uint256 i; i < mo.length; ++i) {
                if (mo[i].live && mo[i].tick == t) {
                    lots += mo[i].lots;
                    ++count;
                }
            }
            (uint64 obLots, uint32 obCount) = ob.getLevel(t);
            assertEq(obLots, lots, "level lots");
            assertEq(obCount, count, "level count");
        }
        uint256[N_ACTORS] memory open;
        for (uint256 i; i < mo.length; ++i) {
            IOrderBook.OrderView memory v = ob.getOrder(mo[i].id);
            if (!mo[i].live) {
                assertEq(v.remainingLots, 0, "dead order gone");
                continue;
            }
            assertEq(v.maker, mo[i].maker);
            assertEq(v.isBid, mo[i].isBid);
            assertEq(v.tick, mo[i].tick);
            assertEq(v.remainingLots, mo[i].lots, "resting lots");
            ++open[uint160(mo[i].maker) - 0xA000];
        }
        for (uint256 a; a < N_ACTORS; ++a) {
            assertEq(ob.openOrderCount(actors[a]), open[a], "openOrderCount");
        }
    }
}

/// @notice Same model with units where Σ size·price is not a multiple of 1e18, so the taker notional's rounding
///         (↑ for a buy, ↓ for a sell) is exercised on every fill.
/// forge-config: default.fuzz.runs = 300
contract OrderBookReferenceOddUnitsFuzzTest is OrderBookReferenceFuzzTest {
    function setUp() public override {
        tickSize = 7;
        lotSize = 3;
        super.setUp();
    }
}
