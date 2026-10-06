// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMarginEngine} from "../../src/interfaces/IMarginEngine.sol";

/// @notice Test IMarginEngine that records the hook protocol (INTERFACES §2.2) instead of doing margin math.
///         Tracks the reservation each trader should hold (I7) and lets tests force maker evictions and skips.
contract RecordingEngine is IMarginEngine {
    address public orderBook;
    mapping(address => uint256) public reservedWad; // Σ size·price of resting orders, WAD²/1e18
    mapping(address => bool) public failMaker;
    mapping(address => bool) public skipMaker; // CR-007: market refuses the maker's new risk, order must stay
    mapping(address => bool) public rejectReserve;
    mapping(address => int256) public position; // base WAD

    uint256 public takerCalls;
    address public lastTaker;
    bool public lastTakerIsBid;
    uint256 public lastTakerSize;
    uint256 public lastTakerNotional;
    bool public lastReduceOnly;
    uint256 public makerCalls;
    uint256 public makerSkips; // CR-007 coverage
    uint256 public makerEvicts;
    uint256 public makerCallsAtTakerSettle; // makerCalls when settleTakerFill ran (taker must settle last)
    bytes public reenterData; // if set, every hook calls back into the book with this calldata

    function setOrderBook(address ob) external {
        orderBook = ob;
    }

    function setFailMaker(address m, bool f) external {
        failMaker[m] = f;
    }

    function setSkipMaker(address m, bool s) external {
        skipMaker[m] = s;
    }

    function setRejectReserve(address t, bool r) external {
        rejectReserve[t] = r;
    }

    function setReenter(bytes calldata data) external {
        reenterData = data;
    }

    modifier onlyOB() {
        if (msg.sender != orderBook) revert OnlyOrderBook();
        _maybeReenter();
        _;
    }

    /// @dev Bubbles the book's revert so tests can expect ReentrancyGuardReentrantCall.
    function _maybeReenter() internal {
        if (reenterData.length == 0) return;
        (bool ok, bytes memory ret) = orderBook.call(reenterData);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function reserveOrderMargin(address trader, bool, uint256 sizeWad, uint256 priceWad) external onlyOB {
        if (rejectReserve[trader]) revert InsufficientMargin();
        reservedWad[trader] += sizeWad * priceWad / 1e18;
    }

    function releaseOrderMargin(address trader, bool, uint256 sizeWad, uint256 priceWad) external onlyOB {
        reservedWad[trader] -= sizeWad * priceWad / 1e18; // underflow ⇒ the book released more than it reserved
    }

    function settleMakerFill(address maker, bool makerIsBid, uint256 sizeWad, uint256 priceWad)
        external
        onlyOB
        returns (MakerFillResult)
    {
        ++makerCalls;
        if (skipMaker[maker]) {
            ++makerSkips;
            return MakerFillResult.Skip; // nothing written, reservation kept
        }
        if (failMaker[maker]) {
            ++makerEvicts;
            return MakerFillResult.Evict;
        }
        reservedWad[maker] -= sizeWad * priceWad / 1e18;
        position[maker] += makerIsBid ? int256(sizeWad) : -int256(sizeWad);
        return MakerFillResult.Filled;
    }

    function settleTakerFill(address taker, bool takerIsBid, uint256 sizeWad, uint256 notionalWad, bool reduceOnly)
        external
        onlyOB
    {
        ++takerCalls;
        makerCallsAtTakerSettle = makerCalls;
        (lastTaker, lastTakerIsBid, lastTakerSize, lastTakerNotional, lastReduceOnly) =
        (taker, takerIsBid, sizeWad, notionalWad, reduceOnly);
        position[taker] += takerIsBid ? int256(sizeWad) : -int256(sizeWad);
    }
}
