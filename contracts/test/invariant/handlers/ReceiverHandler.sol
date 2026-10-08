// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClearingHouse} from "../../../src/clearing/ClearingHouse.sol";
import {OrderBook} from "../../../src/orderbook/OrderBook.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../../src/mocks/MockOracleAdapter.sol";
import {MeridianKeeperReceiver} from "../../../src/automation/MeridianKeeperReceiver.sol";
import {AccountView} from "../../../src/interfaces/MeridianTypes.sol";

/// @title ReceiverHandler — WS-08 handler for MeridianKeeperReceiver over the REAL OrderBook ⇄ ClearingHouse
/// @notice Traders open leveraged positions against a resting MM, the index moves, and the "forwarder" delivers
///         LIQUIDATE / FUNDING_POKE reports for random account subsets (≤ 32, duplicates and the receiver itself
///         included). A stranger also tries to deliver reports. Ghosts:
///         - ghostStrangerAccepted: a report from a non-forwarder did not revert (must stay false);
///         - ghostWellFormedReverted: a well-formed report from the forwarder reverted (must stay false);
///         - ghostBelowIM: after a report that moved size to the receiver, its equity < IM (must stay false);
///         - ghostConservation: Σ size moved out of the targets ≠ size moved into the receiver (must stay false);
///         - ghostUnwindGrew: an UNWIND report grew or flipped the receiver's position (reduce-only, must stay false).
contract ReceiverHandler is Test {
    uint256 internal constant N = 6;
    uint256 internal constant TICK = 1e12;

    ClearingHouse public immutable ch;
    OrderBook public immutable ob;
    MockOracleAdapter public immutable oracle;
    MockERC20 public immutable ausd;
    MeridianKeeperReceiver public immutable receiver;
    address public immutable forwarder;
    address public immutable mm;
    address[N] public actors;

    bool public ghostStrangerAccepted;
    bool public ghostWellFormedReverted;
    bool public ghostBelowIM;
    bool public ghostConservation;
    bool public ghostUnwindGrew; // UNWIND increased |size| or flipped the receiver's side (must stay false)
    uint256 public unwindsThatFilled;
    uint256 public liquidationReports;
    uint256 public reportsThatMovedSize;

    constructor(
        ClearingHouse ch_,
        OrderBook ob_,
        MockOracleAdapter oracle_,
        MockERC20 ausd_,
        MeridianKeeperReceiver receiver_,
        address forwarder_
    ) {
        ch = ch_;
        ob = ob_;
        oracle = oracle_;
        ausd = ausd_;
        receiver = receiver_;
        forwarder = forwarder_;
        mm = makeAddr("receiver-mm");
        for (uint256 i; i < N; ++i) {
            actors[i] = makeAddr(string(abi.encodePacked("receiver-actor", vm.toString(i))));
            _deposit(actors[i], 40e6);
        }
        _deposit(mm, 1_000_000e6);
        _deposit(address(receiver), 500e6);
        _requote();
    }

    function _deposit(address who, uint256 amt) internal {
        ausd.mint(address(this), amt);
        ausd.approve(address(ch), amt);
        ch.depositFor(who, amt);
    }

    /// The MM rests 3 × 50 lots each side around the index, 10 ticks apart (cancels its previous quotes first).
    function _requote() internal {
        uint32 mid = uint32(oracle.price() / TICK);
        vm.startPrank(mm);
        for (uint32 i = 1; i <= 3; ++i) {
            try ob.placeLimitOrder(true, mid - 10 * i, 50, 0) {} catch {}
            try ob.placeLimitOrder(false, mid + 10 * i, 50, 0) {} catch {}
        }
        vm.stopPrank();
    }

    // ─── actions ───────────────────────────────────────────────────────────────

    function open(uint256 who, bool isBid, uint256 lots) external {
        address a = actors[who % N];
        lots = bound(lots, 1, 12);
        uint32 mid = uint32(oracle.price() / TICK);
        vm.prank(a);
        try ob.placeMarketOrder(isBid, uint64(lots), isBid ? mid + 40 : mid - 40, 0, false) {} catch {}
    }

    function movePrice(uint256 bps, bool up) external {
        bps = bound(bps, 1, 2000);
        uint256 p = oracle.price();
        p = up ? p * (10_000 + bps) / 10_000 : p * (10_000 - bps) / 10_000;
        p = bound(p / TICK * TICK, 0.01e18, 0.08e18);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1);
        oracle.setPrice(p);
        _requote();
        vm.roll(block.number + 1);
    }

    function reportLiquidate(uint256 seed, uint256 n) external {
        n = bound(n, 0, 32);
        address[] memory xs = new address[](n);
        for (uint256 i; i < n; ++i) {
            uint256 k = uint256(keccak256(abi.encode(seed, i))) % (N + 2);
            xs[i] = k < N ? actors[k] : (k == N ? address(receiver) : mm);
        }
        int256 sumBefore;
        for (uint256 i; i < N; ++i) {
            sumBefore += ch.getPosition(actors[i]).size;
        }
        sumBefore += ch.getPosition(mm).size;
        int256 recvBefore = ch.getPosition(address(receiver)).size;
        ++liquidationReports;
        vm.prank(forwarder);
        try receiver.onReport("", abi.encode(uint8(2), abi.encode(address(ch), xs))) {}
        catch {
            ghostWellFormedReverted = true;
        }
        int256 sumAfter;
        for (uint256 i; i < N; ++i) {
            sumAfter += ch.getPosition(actors[i]).size;
        }
        sumAfter += ch.getPosition(mm).size;
        int256 recvAfter = ch.getPosition(address(receiver)).size;
        if (sumBefore - sumAfter != recvAfter - recvBefore) ghostConservation = true;
        if (recvAfter != recvBefore) {
            ++reportsThatMovedSize;
            AccountView memory v = ch.getAccount(address(receiver));
            if (v.equity < int256(v.initialMargin)) ghostBelowIM = true;
        }
    }

    function reportUnwind(uint256 maxLots) external {
        maxLots = bound(maxLots, 0, 200);
        int256 before = ch.getPosition(address(receiver)).size;
        vm.prank(forwarder);
        try receiver.onReport("", abi.encode(uint8(5), abi.encode(address(ch), maxLots * 100e18))) {}
        catch {
            ghostWellFormedReverted = true;
        }
        int256 afterSize = ch.getPosition(address(receiver)).size;
        if (afterSize != before) ++unwindsThatFilled;
        bool grew = before >= 0 ? (afterSize > before || afterSize < 0) : (afterSize < before || afterSize > 0);
        if (grew) ghostUnwindGrew = true;
    }

    function reportFundingPoke() external {
        vm.roll(block.number + 1);
        address[] memory chs = new address[](1);
        chs[0] = address(ch);
        vm.prank(forwarder);
        try receiver.onReport("", abi.encode(uint8(3), abi.encode(chs))) {}
        catch {
            ghostWellFormedReverted = true;
        }
    }

    function strangerReport(address stranger) external {
        if (stranger == forwarder) return;
        vm.prank(stranger);
        try receiver.onReport("", abi.encode(uint8(3), abi.encode(new address[](0)))) {
            ghostStrangerAccepted = true;
        } catch {}
    }
}
