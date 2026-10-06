// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOrderBook} from "../interfaces/IOrderBook.sol";
import {IClearingHouse} from "../interfaces/IClearingHouse.sol";
import {IMarginEngine} from "../interfaces/IMarginEngine.sol";
import {PulseConstants} from "../interfaces/PulseTypes.sol";

/// @notice Mock order book. No matching engine:
///  - Book views (best bid/ask, last trade) are set by hand for mark-price tests.
///  - placeMarketOrder fills fully at `fillPriceWad` against a synthetic counterparty (`mockMaker`),
///    settling both sides through the ClearingHouse hooks (works with MockClearingHouse or the real one).
///  - placeLimitOrder only rests (reserves margin), never matches.
contract MockOrderBook is IOrderBook {
    address public immutable clearingHouse;
    uint256 public immutable tickSize;
    uint256 public immutable lotSize;

    address public mockMaker = address(0xBEEF);
    uint256 public fillPriceWad;
    uint32 internal _bestBid;
    uint32 internal _bestAsk = type(uint32).max;
    uint256 internal _lastPrice;
    uint64 internal _lastBlock;

    uint64 public nextOrderId = 1;
    mapping(uint64 => OrderView) internal _orders;
    mapping(address => uint256) public openOrderCount;

    constructor(address clearingHouse_, uint256 tickSize_, uint256 lotSize_) {
        clearingHouse = clearingHouse_;
        tickSize = tickSize_;
        lotSize = lotSize_;
    }

    // ─── mock controls ────────────────────────────────────────────────────────
    function mockSetBook(uint32 bid, uint32 ask) external {
        _bestBid = bid;
        _bestAsk = ask;
    }

    function mockSetLastTrade(uint256 priceWad, uint64 blockNumber) external {
        _lastPrice = priceWad;
        _lastBlock = blockNumber;
    }

    function mockSetFillPrice(uint256 priceWad) external {
        fillPriceWad = priceWad;
    }

    function mockSetMaker(address maker) external {
        mockMaker = maker;
    }

    // ─── trading ──────────────────────────────────────────────────────────────
    function placeLimitOrder(bool isBid, uint32 tick, uint64 lots, uint8 flags)
        public
        returns (uint64 orderId, uint64 filledLots)
    {
        if (tick == 0) revert InvalidTick();
        if (lots == 0) revert InvalidSize();
        if (openOrderCount[msg.sender] >= PulseConstants.MAX_OPEN_ORDERS_PER_ACCOUNT) revert TooManyOpenOrders();
        IClearingHouse(clearingHouse).reserveOrderMargin(msg.sender, isBid, lots * lotSize, tick * tickSize);
        orderId = nextOrderId++;
        _orders[orderId] = OrderView(msg.sender, isBid, tick, lots, uint64(block.number));
        openOrderCount[msg.sender]++;
        emit OrderPlaced(orderId, msg.sender, isBid, tick, lots, flags);
        return (orderId, 0);
    }

    function placeMarketOrder(bool isBid, uint64 lots, uint32, uint64 minFilledLots, bool reduceOnly)
        external
        returns (uint64 filledLots, uint256 avgPriceWad)
    {
        if (lots == 0) revert InvalidSize();
        if (fillPriceWad == 0) revert NoLiquidity();
        if (lots < minFilledLots) revert SlippageExceeded();
        uint256 size = uint256(lots) * lotSize;
        // Hook order (INTERFACES §2, decision 8): every maker fill first, then exactly one taker fill.
        // Evict (maker can't carry the fill) ⇒ OrderEvicted; Skip (market refuses new risk, CR-007) ⇒
        // MakerFillSkipped (the synthetic maker stays live). Either way nothing fills and the taker isn't settled.
        IMarginEngine.MakerFillResult r =
            IClearingHouse(clearingHouse).settleMakerFill(mockMaker, !isBid, size, fillPriceWad);
        if (r != IMarginEngine.MakerFillResult.Filled) {
            if (r == IMarginEngine.MakerFillResult.Skip) emit MakerFillSkipped(0, mockMaker);
            else emit OrderEvicted(0, mockMaker, lots);
            if (minFilledLots > 0) revert SlippageExceeded();
            return (0, 0);
        }
        emit Trade(0, mockMaker, msg.sender, isBid, uint32(fillPriceWad / tickSize), lots, fillPriceWad, size);
        filledLots = lots;
        uint256 notional = size * fillPriceWad / PulseConstants.WAD;
        IClearingHouse(clearingHouse).settleTakerFill(msg.sender, isBid, size, notional, reduceOnly);
        _lastPrice = fillPriceWad;
        _lastBlock = uint64(block.number);
        return (filledLots, fillPriceWad);
    }

    function cancelOrder(uint64 orderId) public {
        OrderView memory o = _orders[orderId];
        if (o.maker == address(0)) revert OrderNotFound();
        if (o.maker != msg.sender) revert NotOrderOwner();
        IClearingHouse(clearingHouse).releaseOrderMargin(o.maker, o.isBid, o.remainingLots * lotSize, o.tick * tickSize);
        delete _orders[orderId];
        openOrderCount[msg.sender]--;
        emit OrderCancelled(orderId, msg.sender, o.remainingLots);
    }

    function cancelOrders(uint64[] calldata orderIds) external {
        if (orderIds.length > PulseConstants.MAX_BATCH) revert BatchTooLarge();
        for (uint256 i; i < orderIds.length; ++i) {
            cancelOrder(orderIds[i]);
        }
    }

    function replaceOrder(uint64 orderId, uint32 newTick, uint64 newLots, uint8 flags)
        external
        returns (uint64, uint64)
    {
        bool isBid = _orders[orderId].isBid;
        cancelOrder(orderId);
        return placeLimitOrder(isBid, newTick, newLots, flags);
    }

    // ─── views ────────────────────────────────────────────────────────────────
    function bestBid() external view returns (uint32) {
        return _bestBid;
    }

    function bestAsk() external view returns (uint32) {
        return _bestAsk;
    }

    function midPrice() external view returns (uint256, bool) {
        if (_bestBid == 0 || _bestAsk == type(uint32).max) return (0, false);
        return ((uint256(_bestBid) + uint256(_bestAsk)) * tickSize / 2, true);
    }

    function lastTrade() external view returns (uint256, uint64) {
        return (_lastPrice, _lastBlock);
    }

    function getOrder(uint64 orderId) external view returns (OrderView memory) {
        return _orders[orderId];
    }

    function getLevel(uint32) external pure returns (uint64, uint32) {
        return (0, 0);
    }

    function getDepth(bool, uint256) external pure returns (uint32[] memory ticks, uint64[] memory lots) {
        return (ticks, lots);
    }
}
