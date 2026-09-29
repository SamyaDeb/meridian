// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IOrderBook} from "../interfaces/IOrderBook.sol";
import {IMarginEngine} from "../interfaces/IMarginEngine.sol";
import {PulseConstants} from "../interfaces/PulseTypes.sol";
import {TickBitmap} from "./libraries/TickBitmap.sol";

/// @title OrderBook — fully onchain, instrument-agnostic CLOB with price-time priority
/// @notice Matches prices and sizes and settles every fill synchronously in its IMarginEngine (the perp
///         ClearingHouse, or the FundingSwapMarket where price = 1 + APR). Protocol: INTERFACES §2.2.
///
/// ─── Storage design (MIP-8, ARCHITECTURE R5 / §3) ─────────────────────────────────────────────────────────
/// MIP-8 prices storage per 4 KB page (128 slots): first write to a page in a tx 2,800 gas, later writes to
/// the same page 0; each zero→nonzero slot 17,000; no refunds. So: (1) keep hot state contiguous, (2) never
/// zero and re-create slots, recycle them.
///   slot 0            Header {bestBid32 | bestAsk32 | lastTradeTick32 | lastTradeBlock64 | seq32 | freeHead32 |
///                     nextSlot32}: one slot, read and written by every trade.
///   openOrderCount    mapping(address ⇒ uint256): per account (the only hashed, per-user slot).
///   bids, asks        TickBitmap (root + 256 mid + 65,536 leaf words, static ⇒ contiguous). A tick's level holds
///                     one side at a time (bestBid < bestAsk), so two bitmaps share one `levels` array.
///   levels[2^24]      Level {head32 | tail32 | totalLots64 | orderCount32 | used8}, one slot, indexed by tick: a
///                     static array, so 128 adjacent ticks share one page (the MM quoting ±N ticks touches 1–2 pages).
///                     `used` is set on first insert and never cleared, so an emptied level stays a nonzero slot and
///                     re-opening it is a nonzero→nonzero write (no 17k).
///   orders[2^32]      Order, two adjacent slots (always the same page):
///                       s0 {maker160 | lots64 | next32}   s1 {orderId64 | prev32 | tick32 | placedBlock64 | isBid8}
///                     `prev` makes cancel an O(1) unlink from anywhere in the FIFO, so there are no tombstones for a
///                     taker to skip. The second slot is free under MIP-8 (same page) and holds the orderId check.
///                     Freed slots go on a free list (via `next`) and are never zeroed (`lots = 0` marks them free),
///                     so a place/cancel cycle writes only nonzero→nonzero slots: no 17k growth cost after warm-up.
/// Order ids: `orderId = seq << 32 | slot` with a global seq ⇒ strictly increasing, never reused (INTERFACES §2.6),
/// and O(1) lookup. A stale id whose slot was recycled fails the stored `orderId` check (OrderNotFound).
///
/// ─── Matching rules ─────────────────────────────────────────────────────────────────────────────────────────
/// - ≤ MAX_FILLS_PER_ORDER maker orders are visited per taker order (fills, evictions and self-trade expiries
///   all count), so every external call is bounded.
/// - `settleMakerFill` returning false ⇒ the maker order is evicted (its remainder released) and matching continues.
/// - `settleTakerFill` once at the end with Σsize and Σnotional. Σnotional is summed exactly as Σ size·price and
///   divided once: rounded up for a taker buy and down for a taker sell (against the taker). For the deployed
///   books (lot a whole number of base units, tick ≥ 1e-18·1e18) the division is exact.
/// - Self-trade: the resting order of the same account is expired (cancelled, OrderCancelled) instead of filled.
/// - If the fill cap stops matching while the remainder still crosses, the remainder is dropped (never rests), so
///   bestBid < bestAsk always holds (I6).
/// - IOC and REDUCE_ONLY never rest (reduce-only is enforced by the engine on the taker fill; a resting reduce-only
///   order could not be re-checked at maker-fill time).
/// - Pause: enforced by the engine's hooks (reserve/settle revert when paused, release never does), so cancels
///   always work.
contract OrderBook is IOrderBook, ReentrancyGuardTransient {
    using TickBitmap for TickBitmap.Bitmap;

    uint8 internal constant FLAG_POST_ONLY = 1;
    uint8 internal constant FLAG_IOC = 2;
    uint8 internal constant FLAG_REDUCE_ONLY = 4;
    uint32 internal constant NO_ASK = type(uint32).max;

    struct Header {
        uint32 bestBid;
        uint32 bestAsk;
        uint32 lastTradeTick;
        uint64 lastTradeBlock;
        uint32 seq;
        uint32 freeHead;
        uint32 nextSlot;
    }

    struct Level {
        uint32 head;
        uint32 tail;
        uint64 totalLots;
        uint32 orderCount;
        bool used; // never cleared: keeps the slot nonzero (MIP-8)
    }

    struct Order {
        // slot 0
        address maker;
        uint64 lots;
        uint32 next;
        // slot 1
        uint64 orderId;
        uint32 prev;
        uint32 tick;
        uint64 placedBlock;
        bool isBid;
    }

    IMarginEngine internal immutable _engine;
    uint256 public immutable tickSize;
    uint256 public immutable lotSize;

    Header internal _h;
    mapping(address => uint256) public openOrderCount;
    TickBitmap.Bitmap internal _bids;
    TickBitmap.Bitmap internal _asks;
    Level[1 << 24] internal _levels;
    Order[1 << 32] internal _orders;

    /// @param engine_ the IMarginEngine (perp ClearingHouse or FundingSwapMarket) this book settles into
    /// @param tickSize_ price increment, WAD
    /// @param lotSize_ size increment, base WAD
    constructor(address engine_, uint256 tickSize_, uint256 lotSize_) {
        if (tickSize_ == 0 || lotSize_ == 0) revert InvalidSize();
        _engine = IMarginEngine(engine_);
        tickSize = tickSize_;
        lotSize = lotSize_;
        _h.bestAsk = NO_ASK;
        _h.nextSlot = 1; // slot 0 = null link
    }

    // ─── Trading ──────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IOrderBook
    function placeLimitOrder(bool isBid, uint32 tick, uint64 lots, uint8 flags)
        external
        nonReentrant
        returns (uint64 orderId, uint64 filledLots)
    {
        return _place(isBid, tick, lots, flags);
    }

    /// @inheritdoc IOrderBook
    function placeMarketOrder(bool isBid, uint64 lots, uint32 limitTick, uint64 minFilledLots, bool reduceOnly)
        external
        nonReentrant
        returns (uint64 filledLots, uint256 avgPriceWad)
    {
        if (lots == 0) revert InvalidSize();
        if (isBid ? _h.bestAsk == NO_ASK : _h.bestBid == 0) revert NoLiquidity();
        uint256 notionalRaw;
        (filledLots, notionalRaw) = _match(isBid, limitTick, lots);
        if (filledLots < minFilledLots) revert SlippageExceeded();
        if (filledLots != 0) {
            uint256 size = uint256(filledLots) * lotSize;
            _engine.settleTakerFill(msg.sender, isBid, size, _notional(notionalRaw, isBid), reduceOnly);
            avgPriceWad = notionalRaw / size; // informational VWAP, rounds down
        }
    }

    /// @inheritdoc IOrderBook
    function cancelOrder(uint64 orderId) external nonReentrant {
        _cancel(orderId);
    }

    /// @inheritdoc IOrderBook
    function cancelOrders(uint64[] calldata orderIds) external nonReentrant {
        uint256 n = orderIds.length;
        if (n > PulseConstants.MAX_BATCH) revert BatchTooLarge();
        for (uint256 i; i < n; ++i) {
            _cancel(orderIds[i]);
        }
    }

    /// @inheritdoc IOrderBook
    function replaceOrder(uint64 orderId, uint32 newTick, uint64 newLots, uint8 flags)
        external
        nonReentrant
        returns (uint64 newOrderId, uint64 filledLots)
    {
        bool isBid = _cancel(orderId);
        return _place(isBid, newTick, newLots, flags);
    }

    // ─── Views ────────────────────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IOrderBook
    function clearingHouse() external view returns (address) {
        return address(_engine);
    }

    /// @inheritdoc IOrderBook
    function bestBid() external view returns (uint32) {
        return _h.bestBid;
    }

    /// @inheritdoc IOrderBook
    function bestAsk() external view returns (uint32) {
        return _h.bestAsk;
    }

    /// @inheritdoc IOrderBook
    function midPrice() external view returns (uint256 midWad, bool valid) {
        Header memory h = _h;
        if (h.bestBid == 0 || h.bestAsk == NO_ASK) return (0, false);
        return ((uint256(h.bestBid) + h.bestAsk) * tickSize / 2, true);
    }

    /// @inheritdoc IOrderBook
    function lastTrade() external view returns (uint256 priceWad, uint64 blockNumber) {
        return (uint256(_h.lastTradeTick) * tickSize, _h.lastTradeBlock);
    }

    /// @inheritdoc IOrderBook
    function getOrder(uint64 orderId) external view returns (OrderView memory v) {
        Order storage o = _orders[uint32(orderId)];
        if (orderId == 0 || o.orderId != orderId || o.lots == 0) return v;
        return
            OrderView({maker: o.maker, isBid: o.isBid, tick: o.tick, remainingLots: o.lots, placedBlock: o.placedBlock});
    }

    /// @inheritdoc IOrderBook
    function getLevel(uint32 tick) external view returns (uint64 totalLots, uint32 orderCount) {
        if (tick > TickBitmap.MAX_TICK) return (0, 0);
        Level storage l = _levels[tick];
        return (l.totalLots, l.orderCount);
    }

    /// @inheritdoc IOrderBook
    function getDepth(bool isBid, uint256 maxLevels)
        external
        view
        returns (uint32[] memory ticks, uint64[] memory lots)
    {
        if (maxLevels > PulseConstants.MAX_BATCH) {
            revert BatchTooLarge();
        }
        uint32[] memory t = new uint32[](maxLevels);
        uint64[] memory l = new uint64[](maxLevels);
        TickBitmap.Bitmap storage bm = isBid ? _bids : _asks;
        uint256 n;
        uint256 cursor = isBid ? _h.bestBid : _h.bestAsk;
        bool found = isBid ? cursor != 0 : cursor != NO_ASK;
        while (found && n < maxLevels) {
            t[n] = uint32(cursor);
            l[n] = _levels[cursor].totalLots;
            ++n;
            if (isBid) {
                if (cursor == 0) break;
                (cursor, found) = bm.nextAtOrBelow(cursor - 1);
            } else {
                if (cursor == TickBitmap.MAX_TICK) break;
                (cursor, found) = bm.nextAtOrAbove(cursor + 1);
            }
        }
        assembly {
            mstore(t, n)
            mstore(l, n)
        }
        return (t, l);
    }

    // ─── Internal: placement ──────────────────────────────────────────────────────────────────────────────

    function _place(bool isBid, uint32 tick, uint64 lots, uint8 flags)
        internal
        returns (uint64 orderId, uint64 filled)
    {
        if (tick == 0 || tick > TickBitmap.MAX_TICK) revert InvalidTick();
        if (lots == 0) revert InvalidSize();
        bool rests = flags & (FLAG_IOC | FLAG_REDUCE_ONLY) == 0;
        if (rests && openOrderCount[msg.sender] >= PulseConstants.MAX_OPEN_ORDERS_PER_ACCOUNT) {
            revert TooManyOpenOrders();
        }
        if (flags & FLAG_POST_ONLY != 0 && _crosses(isBid, tick)) revert PostOnlyWouldCross();

        uint256 notionalRaw;
        (filled, notionalRaw) = _match(isBid, tick, lots);
        if (filled != 0) {
            _engine.settleTakerFill(
                msg.sender,
                isBid,
                uint256(filled) * lotSize,
                _notional(notionalRaw, isBid),
                flags & FLAG_REDUCE_ONLY != 0
            );
        }

        uint64 remaining = lots - filled;
        if (remaining == 0 || !rests || _crosses(isBid, tick)) return (0, filled);

        _engine.reserveOrderMargin(msg.sender, isBid, uint256(remaining) * lotSize, uint256(tick) * tickSize);
        orderId = _insert(msg.sender, isBid, tick, remaining);
        emit OrderPlaced(orderId, msg.sender, isBid, tick, remaining, flags);
    }

    function _crosses(bool isBid, uint32 tick) internal view returns (bool) {
        return isBid ? (_h.bestAsk != NO_ASK && tick >= _h.bestAsk) : (_h.bestBid != 0 && tick <= _h.bestBid);
    }

    function _insert(address maker, bool isBid, uint32 tick, uint64 lots) internal returns (uint64 orderId) {
        Header memory h = _h;
        uint32 slot;
        if (h.freeHead != 0) {
            slot = h.freeHead;
            h.freeHead = _orders[slot].next;
        } else {
            slot = h.nextSlot++;
        }
        orderId = (uint64(++h.seq) << 32) | slot;

        Level storage lvl = _levels[tick];
        uint32 tail = lvl.tail;
        _orders[slot] = Order({
            maker: maker,
            lots: lots,
            next: 0,
            orderId: orderId,
            prev: tail,
            tick: tick,
            placedBlock: uint64(block.number),
            isBid: isBid
        });
        if (tail != 0) {
            _orders[tail].next = slot;
        } else {
            lvl.head = slot;
            lvl.used = true;
            (isBid ? _bids : _asks).set(tick);
            if (isBid ? tick > h.bestBid : tick < h.bestAsk) {
                if (isBid) h.bestBid = tick;
                else h.bestAsk = tick;
            }
        }
        lvl.tail = slot;
        lvl.totalLots += lots;
        ++lvl.orderCount;
        _h = h;
        ++openOrderCount[maker];
    }

    // ─── Internal: matching ───────────────────────────────────────────────────────────────────────────────

    /// @return filled lots filled
    /// @return notionalRaw Σ sizeWad·priceWad (not yet divided by 1e18)
    function _match(bool isBid, uint32 limitTick, uint64 lots) internal returns (uint64 filled, uint256 notionalRaw) {
        uint64 remaining = lots;
        uint32 lastTick;
        for (uint256 visits; remaining != 0 && visits < PulseConstants.MAX_FILLS_PER_ORDER; ++visits) {
            uint32 t = isBid ? _h.bestAsk : _h.bestBid;
            if (isBid ? (t == NO_ASK || t > limitTick) : (t == 0 || t < limitTick)) break;
            uint64 fill = _visit(isBid, t, remaining);
            if (fill != 0) {
                remaining -= fill;
                notionalRaw += uint256(fill) * lotSize * (uint256(t) * tickSize);
                lastTick = t;
            }
        }
        filled = lots - remaining;
        if (filled != 0) {
            _h.lastTradeTick = lastTick;
            _h.lastTradeBlock = uint64(block.number);
        }
    }

    /// @dev Visit the head order of level `t`: fill it, or expire it (self-trade), or evict it (margin failure).
    /// @return fill lots filled against it (0 if expired/evicted)
    function _visit(bool takerIsBid, uint32 t, uint64 remaining) internal returns (uint64 fill) {
        uint32 slot = _levels[t].head;
        Order storage o = _orders[slot];
        (address maker, uint64 oLots) = (o.maker, o.lots);
        if (maker == msg.sender) {
            _drop(slot, t, !takerIsBid, false);
            return 0;
        }
        fill = remaining < oLots ? remaining : oLots;
        uint256 price = uint256(t) * tickSize;
        uint256 size = uint256(fill) * lotSize;
        if (!_engine.settleMakerFill(maker, !takerIsBid, size, price)) {
            _drop(slot, t, !takerIsBid, true);
            return 0;
        }
        if (fill == oLots) {
            _remove(slot, t, !takerIsBid, maker, oLots);
        } else {
            o.lots = oLots - fill;
            _levels[t].totalLots -= fill;
        }
        emit Trade(o.orderId, maker, msg.sender, takerIsBid, t, fill, price, size);
    }

    /// @dev Remove a resting order without filling it and release its reservation (evicted or self-trade expiry).
    function _drop(uint32 slot, uint32 t, bool makerIsBid, bool evicted) internal {
        Order storage o = _orders[slot];
        (address maker, uint64 lots, uint64 oid) = (o.maker, o.lots, o.orderId);
        _remove(slot, t, makerIsBid, maker, lots);
        _engine.releaseOrderMargin(maker, makerIsBid, uint256(lots) * lotSize, uint256(t) * tickSize);
        if (evicted) emit OrderEvicted(oid, maker, lots);
        else emit OrderCancelled(oid, maker, lots);
    }

    /// @dev Σ size·price / 1e18: up when the taker buys (pays more), down when it sells (receives less).
    function _notional(uint256 raw, bool takerIsBid) internal pure returns (uint256) {
        uint256 q = raw / 1e18;
        return takerIsBid && q * 1e18 != raw ? q + 1 : q;
    }

    // ─── Internal: cancel & unlink ────────────────────────────────────────────────────────────────────────

    /// @return isBid side of the cancelled order
    function _cancel(uint64 orderId) internal returns (bool isBid) {
        uint32 slot = uint32(orderId);
        Order storage o = _orders[slot];
        (address maker, uint64 lots, uint32 tick) = (o.maker, o.lots, o.tick);
        if (orderId == 0 || o.orderId != orderId || lots == 0) revert OrderNotFound();
        if (maker != msg.sender) revert NotOrderOwner();
        isBid = o.isBid;
        _remove(slot, tick, isBid, maker, lots);
        _engine.releaseOrderMargin(maker, isBid, uint256(lots) * lotSize, uint256(tick) * tickSize);
        emit OrderCancelled(orderId, maker, lots);
    }

    /// @dev O(1) unlink from the level FIFO, level/bitmap/best bookkeeping, slot to the free list.
    function _remove(uint32 slot, uint32 tick, bool isBid, address maker, uint64 lots) internal {
        Order storage o = _orders[slot];
        (uint32 prev, uint32 next) = (o.prev, o.next);
        Level storage lvl = _levels[tick];
        if (prev != 0) _orders[prev].next = next;
        else lvl.head = next;
        if (next != 0) _orders[next].prev = prev;
        else lvl.tail = prev;
        lvl.totalLots -= lots;
        uint32 count = --lvl.orderCount;

        Header memory h = _h;
        o.lots = 0;
        o.next = h.freeHead;
        h.freeHead = slot;
        if (count == 0) {
            TickBitmap.Bitmap storage bm = isBid ? _bids : _asks;
            bm.clear(tick);
            if (isBid && tick == h.bestBid) {
                (uint256 t, bool found) = bm.nextAtOrBelow(tick);
                h.bestBid = found ? uint32(t) : 0;
            } else if (!isBid && tick == h.bestAsk) {
                (uint256 t, bool found) = bm.nextAtOrAbove(tick);
                h.bestAsk = found ? uint32(t) : NO_ASK;
            }
        }
        _h = h;
        --openOrderCount[maker];
    }
}
