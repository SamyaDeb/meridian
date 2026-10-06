// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IOrderBook} from "../../../src/interfaces/IOrderBook.sol";
import {RecordingEngine} from "../../unit/OrderBookEngine.t.sol";

/// @notice WS-01 handler for WS-08 invariants I6 (book integrity) and I7 (margin reservation), MATH_SPEC §9.
///         Drives an OrderBook wired to a RecordingEngine with 4 actors on a 24-tick window (so both sides fit
///         in one getDepth call) and keeps a ghost list of resting order ids. `checkI6()` / `checkI7()` revert
///         with the violated clause; call them from `invariant_*` functions.
/// @dev I7 compares against RecordingEngine.reservedWad, which is exact when lotSize·tickSize is a multiple of
///      1e18 (true for both deployed books). Against the real ClearingHouse, WS-08 checks I7 on CH state instead.
contract OrderBookHandler is CommonBase, StdUtils {
    uint32 public constant TICK_LO = 1000;
    uint32 public constant N_TICKS = 24;
    uint256 internal constant N_ACTORS = 4;
    uint8 internal constant POST_ONLY = 1;
    uint8 internal constant IOC = 2;
    uint8 internal constant REDUCE_ONLY = 4;

    IOrderBook public immutable ob;
    RecordingEngine public immutable eng;
    address[N_ACTORS] public actors;
    uint64[] internal _live; // ghost: ids that may still rest (pruned via getOrder)

    mapping(bytes32 => uint256) public calls;

    constructor(IOrderBook ob_, RecordingEngine eng_) {
        ob = ob_;
        eng = eng_;
        for (uint256 i; i < N_ACTORS; ++i) {
            actors[i] = address(uint160(0xA11CE + i));
        }
    }

    // ─── actions ──────────────────────────────────────────────────────────────────────────────────────

    function placeLimit(uint256 actorSeed, bool isBid, uint256 tickSeed, uint256 lotsSeed, uint256 flagSeed) external {
        address a = _actor(actorSeed);
        uint8[4] memory flags = [0, POST_ONLY, IOC, REDUCE_ONLY];
        vm.prank(a);
        try ob.placeLimitOrder(isBid, _tick(tickSeed), uint64(bound(lotsSeed, 1, 20)), flags[flagSeed % 4]) returns (
            uint64 id, uint64
        ) {
            if (id != 0) _live.push(id);
            ++calls["placeLimit"];
        } catch {
            ++calls["placeLimit.reverted"]; // PostOnlyWouldCross / TooManyOpenOrders
        }
        _prune();
    }

    function placeMarket(uint256 actorSeed, bool isBid, uint256 lotsSeed, uint256 limitSeed, uint256 minSeed) external {
        uint64 lots = uint64(bound(lotsSeed, 1, 60));
        vm.prank(_actor(actorSeed));
        try ob.placeMarketOrder(isBid, lots, _tick(limitSeed), uint64(bound(minSeed, 0, lots)), false) {
            ++calls["placeMarket"];
        } catch {
            ++calls["placeMarket.reverted"]; // NoLiquidity / SlippageExceeded
        }
        _prune();
    }

    function cancel(uint256 idxSeed) external {
        if (_live.length == 0) return;
        uint64 id = _live[idxSeed % _live.length];
        vm.prank(ob.getOrder(id).maker);
        ob.cancelOrder(id);
        ++calls["cancel"];
        _prune();
    }

    function replace(uint256 idxSeed, uint256 tickSeed, uint256 lotsSeed) external {
        if (_live.length == 0) return;
        uint64 id = _live[idxSeed % _live.length];
        vm.prank(ob.getOrder(id).maker);
        try ob.replaceOrder(id, _tick(tickSeed), uint64(bound(lotsSeed, 1, 20)), 0) returns (uint64 nid, uint64) {
            if (nid != 0) _live.push(nid);
            ++calls["replace"];
        } catch {
            ++calls["replace.reverted"];
        }
        _prune();
    }

    /// @dev Makes an actor fail settleMakerFill, so matching evicts its orders.
    function toggleFailMaker(uint256 actorSeed) external {
        address a = _actor(actorSeed);
        eng.setFailMaker(a, !eng.failMaker(a));
        ++calls["toggleFailMaker"];
    }

    /// @dev CR-007 "market refuses risk" mode: settleMakerFill returns Skip for this actor's orders (checked before
    ///      the fail mode), so matching stops at them and they must keep lots, FIFO place and reservation (I6, I7).
    function toggleSkipMaker(uint256 actorSeed) external {
        address a = _actor(actorSeed);
        eng.setSkipMaker(a, !eng.skipMaker(a));
        ++calls["toggleSkipMaker"];
    }

    // ─── invariants ───────────────────────────────────────────────────────────────────────────────────

    /// @notice I6: bestBid < bestAsk; level totals and counts = Σ resting orders; bitmap bit ⇔ level non-empty
    ///         (via getDepth, which walks the bitmaps); best prices = extreme non-empty levels; open-order counts.
    function checkI6() external view {
        uint32 bb = ob.bestBid();
        uint32 ba = ob.bestAsk();
        if (bb != 0 && ba != type(uint32).max) require(bb < ba, "I6: bestBid >= bestAsk");

        uint64[N_TICKS] memory sum;
        uint32[N_TICKS] memory cnt;
        uint8[N_TICKS] memory side; // 1 bid, 2 ask
        uint256[N_ACTORS] memory perActor;
        for (uint256 i; i < _live.length; ++i) {
            IOrderBook.OrderView memory o = ob.getOrder(_live[i]);
            if (o.remainingLots == 0) continue;
            require(o.tick >= TICK_LO && o.tick < TICK_LO + N_TICKS, "I6: order outside window");
            uint256 k = o.tick - TICK_LO;
            uint8 s = o.isBid ? 1 : 2;
            require(side[k] == 0 || side[k] == s, "I6: both sides on one level");
            side[k] = s;
            sum[k] += o.remainingLots;
            ++cnt[k];
            ++perActor[_actorIndex(o.maker)];
        }
        for (uint256 i; i < N_ACTORS; ++i) {
            require(ob.openOrderCount(actors[i]) == perActor[i], "I6: openOrderCount != resting orders");
        }

        (uint32[] memory bt, uint64[] memory bl) = ob.getDepth(true, 32);
        (uint32[] memory at, uint64[] memory al) = ob.getDepth(false, 32);
        uint256 nBid;
        uint256 nAsk;
        uint32 maxBid;
        uint32 minAsk = type(uint32).max;
        for (uint256 k; k < N_TICKS; ++k) {
            uint32 t = TICK_LO + uint32(k);
            (uint64 lots, uint32 c) = ob.getLevel(t);
            require(lots == sum[k], "I6: level totalLots != sum of orders");
            require(c == cnt[k], "I6: level orderCount != number of orders");
            if (side[k] == 1) {
                require(
                    nBid < bt.length && bt[bt.length - 1 - nBid] == t && bl[bl.length - 1 - nBid] == lots, "I6: bid bit"
                );
                ++nBid;
                maxBid = t;
            } else if (side[k] == 2) {
                require(nAsk < at.length && at[nAsk] == t && al[nAsk] == lots, "I6: ask bit");
                ++nAsk;
                if (minAsk == type(uint32).max) minAsk = t;
            }
        }
        require(nBid == bt.length && nAsk == at.length, "I6: bitmap bit on an empty level");
        require(bb == maxBid, "I6: bestBid != highest bid level");
        require(ba == minAsk, "I6: bestAsk != lowest ask level");
    }

    /// @notice I7: each actor's reservation = Σ size·price of its resting orders.
    function checkI7() external view {
        uint256 lot = ob.lotSize();
        uint256 tickSize = ob.tickSize();
        uint256[N_ACTORS] memory expected;
        for (uint256 i; i < _live.length; ++i) {
            IOrderBook.OrderView memory o = ob.getOrder(_live[i]);
            if (o.remainingLots == 0) continue;
            expected[_actorIndex(o.maker)] += uint256(o.remainingLots) * lot * (uint256(o.tick) * tickSize) / 1e18;
        }
        for (uint256 i; i < N_ACTORS; ++i) {
            require(eng.reservedWad(actors[i]) == expected[i], "I7: reservation != sum of resting orders");
        }
    }

    function liveCount() external view returns (uint256) {
        return _live.length;
    }

    // ─── helpers ──────────────────────────────────────────────────────────────────────────────────────

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % N_ACTORS];
    }

    function _actorIndex(address a) internal view returns (uint256 i) {
        for (; i < N_ACTORS; ++i) {
            if (actors[i] == a) return i;
        }
        revert("unknown maker");
    }

    function _tick(uint256 seed) internal pure returns (uint32) {
        return TICK_LO + uint32(seed % N_TICKS);
    }

    /// @dev Drop ids that no longer rest (filled, cancelled, evicted, self-trade expired or replaced).
    function _prune() internal {
        uint256 i;
        while (i < _live.length) {
            if (ob.getOrder(_live[i]).remainingLots == 0) {
                _live[i] = _live[_live.length - 1];
                _live.pop();
            } else {
                ++i;
            }
        }
    }
}
