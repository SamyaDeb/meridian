// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {MockOrderBook} from "../../src/mocks/MockOrderBook.sol";
import {IClearingHouse} from "../../src/interfaces/IClearingHouse.sol";
import {MarkPriceLib} from "../../src/libs/MarkPriceLib.sol";
import {ClearingHouseBase} from "./ClearingHouseBase.t.sol";

/// @notice MATH_SPEC §2.1 premium bound (M-1, HARDENING_PLAN P2): the mark's basis over the index moves at most
///         min(elapsed, 20)·10 bps per touch; the index passes through at once.
contract MarkBoundLibTest is Test {
    uint256 constant I = 2e18;
    uint256 constant STEP = 0.001e18;

    function _b(uint256 live, uint256 index, uint256 prevMark, uint256 prevIndex, uint256 k)
        internal
        pure
        returns (uint256)
    {
        return MarkPriceLib.boundPremium(live, index, prevMark, prevIndex, k);
    }

    function test_constants() public pure {
        assertEq(MarkPriceLib.MARK_MAX_PREMIUM_STEP, 0.001e18);
        assertEq(MarkPriceLib.MARK_MAX_ELAPSED_BLOCKS, 20);
    }

    function test_noPreviousMark_unbounded() public pure {
        assertEq(_b(2.1e18, I, 0, 0, 1), 2.1e18, "prevIndex 0: live mark, no division by zero");
    }

    function test_withinStep_returnsLiveExactly() public pure {
        assertEq(_b(2.002e18, I, I, I, 1), 2.002e18, "+10 bps at k = 1");
        assertEq(_b(1.998e18, I, I, I, 1), 1.998e18, "-10 bps at k = 1");
        assertEq(_b(2.0123456789e18, I, 2.01e18, I, 2), 2.0123456789e18, "inside 2 steps of +0.5%");
    }

    function test_stepPerElapsedBlock_capAt20() public pure {
        uint256[7] memory ks = [uint256(1), 2, 5, 19, 20, 21, 1000];
        for (uint256 i; i < ks.length; ++i) {
            uint256 k = ks[i] < 20 ? ks[i] : 20;
            assertEq(_b(2.1e18, I, I, I, ks[i]), I + I * k * STEP / 1e18, "up: I(1 + k step)");
            assertEq(_b(1.9e18, I, I, I, ks[i]), I - I * k * STEP / 1e18, "down: I(1 - k step)");
        }
        assertEq(_b(2.1e18, I, I, I, 1000), 2.04e18, "1,000-block gap moves at most 2%");
    }

    function test_stepIsOnThePremiumNotThePrice() public pure {
        // previous basis +1% on I = 2; index now 3 (+50%); live basis +5% ⇒ basis +1.1% on the NEW index
        assertEq(_b(3.15e18, 3e18, 2.02e18, I, 1), 3.033e18);
    }

    function test_indexJump_bookFollows_passesThrough() public pure {
        // −15% index with the book re-quoted around it: same basis (0 and +1%) ⇒ the mark moves −15% at once
        assertEq(_b(1.7e18, 1.7e18, I, I, 1), 1.7e18);
        assertEq(_b(1.717e18, 1.7e18, 2.02e18, I, 1), 1.717e18);
    }

    function test_indexJump_bookStuck_markStillFollowsIndex() public pure {
        // −15% index, book stuck at the old price ⇒ live mark is the band top I'·1.05; the basis may rise 10 bps only
        assertEq(_b(1.785e18, 1.7e18, I, I, 1), 1.7017e18, "-14.9%, not -10.75%");
    }

    function test_bandStillRespected() public pure {
        // previous basis at the band edge, live at the edge: unchanged
        assertEq(_b(2.1e18, I, 2.1e18, I, 20), 2.1e18);
        // a previous basis outside the band (cannot come from this library) is pulled back inside ±5%
        assertEq(_b(2.1e18, I, 2.4e18, I, 1), 2.1e18, "upper");
        assertEq(_b(1.9e18, I, 1.6e18, I, 1), 1.9e18, "lower");
    }

    function test_premiumTruncatesTowardZero() public pure {
        // p_prev = (−1 wei)·1e18 / 3e18 = 0 when truncated toward 0 (floor would give −1 wei and a mark 3 wei lower)
        assertEq(_b(3.15e18, 3e18, 3e18 - 1, 3e18, 1), 3.003e18);
        // M = I + I·p truncates toward 0 on a negative basis too: 3e18 + 1 with p = −0.001 ⇒ 2.997e18 + 1
        assertEq(_b(2.85e18, 3e18 + 1, 3e18 + 1, 3e18 + 1, 1), uint256(2.997e18) + 1);
    }
}

contract MarkBoundCHTest is ClearingHouseBase {
    uint256 constant STEP = 0.001e18;

    /// book + fresh last trade both at `px` ⇒ live mark = clamp(px, I(1 ± 5%))
    function _manipulate(uint256 px) internal {
        uint32 t = uint32(px / TICK);
        ob.mockSetBook(t - 1, t + 1);
        ob.mockSetLastTrade(px, uint64(block.number));
    }

    function test_views_returnBoundedMarkBeforeTheTouch() public {
        _deposit(alice, 1000e6);
        _deposit(bob, 1000e6);
        _trade(alice, bob, false, 2000, I0); // alice short 2,000 at 2.00
        _roll(1);
        ch.updateFunding();
        uint256 m0 = ch.markPrice();
        _manipulate(2.2e18);
        _roll(1);
        uint256 viewMark = ch.markPrice();
        assertEq(viewMark, m0 + I0 * STEP / 1e18, "view: +10 bps, not +5%");
        assertEq(ch.getAccount(alice).unrealizedPnl, -int256(2000 * (viewMark - I0)), "getAccount at bounded mark");
        bool liqView = ch.isLiquidatable(alice);
        vm.recordLogs();
        ch.updateFunding();
        assertEq(ch.markPrice(), viewMark, "stored = previewed");
        assertEq(ch.isLiquidatable(alice), liqView);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countFundingUpdated(logs), 1);
    }

    function test_manipulationHeld_basisClimbs10bpsPerTouchedBlock() public {
        uint256 prev = ch.markPrice();
        for (uint256 i = 1; i <= 60; ++i) {
            _roll(1);
            _manipulate(2.2e18);
            ch.updateFunding();
            uint256 m = ch.markPrice();
            assertLe(m - prev, I0 * STEP / 1e18, "<= 10 bps per block");
            assertEq(m, i < 50 ? I0 + I0 * i * STEP / 1e18 : 2.1e18, "reaches the band after 50 blocks");
            prev = m;
        }
    }

    function test_longGap_cappedAt20Blocks() public {
        _roll(1000);
        _manipulate(2.2e18);
        ch.updateFunding();
        assertEq(ch.markPrice(), 2.04e18, "1,000-block gap: +2% (k = 20), not +5%");
    }

    function test_indexJumpMinus15_passesThroughSameBlock() public {
        _manipulate(I0); // book and last trade at the index
        _roll(1);
        ch.updateFunding();
        assertEq(ch.markPrice(), I0);
        _roll(1);
        oracle.setPrice(1.7e18);
        ch.updateFunding(); // book still at 2.00 (MM hasn't re-quoted): live mark = band top 1.785
        assertEq(ch.markPrice(), 1.7017e18, "index -15% reaches the mark in the same block (+10 bps basis)");
        _roll(1);
        oracle.setPrice(1.7e18);
        _manipulate(1.7e18); // MM re-quoted around the new index
        ch.updateFunding();
        assertEq(ch.markPrice(), 1.7e18, "basis back to 0 (inside one step)");
    }

    function test_staleThenFresh_touchedEveryBlock_oneStep() public {
        oracle.setStale(true);
        for (uint256 i; i < 30; ++i) {
            _roll(1);
            ch.updateFunding();
            assertEq(ch.markPrice(), I0, "stale: last good mark");
        }
        oracle.setStale(false);
        oracle.setPrice(I0);
        _roll(1);
        _manipulate(2.2e18);
        ch.updateFunding();
        // k counts blocks since the last TOUCH (stale ones included): one step from the last good basis
        assertEq(ch.markPrice(), I0 + I0 * STEP / 1e18);
    }

    function test_staleThenFresh_untouchedGap_cappedAt20() public {
        oracle.setStale(true);
        _roll(1);
        ch.updateFunding();
        oracle.setStale(false);
        _roll(30);
        _manipulate(1.8e18);
        ch.updateFunding();
        assertEq(ch.markPrice(), 1.96e18, "-2% after a 30-block gap");
    }

    function test_constructorWithStaleOracle_firstFreshTouchUnbounded() public {
        oracle.setStale(true);
        ClearingHouse c2 = new ClearingHouse(address(ausd), address(oracle), address(fund), _risk(), _funding(), owner);
        MockOrderBook ob2 = new MockOrderBook(address(c2), TICK, LOT);
        vm.prank(owner);
        c2.setOrderBook(address(ob2));
        assertEq(c2.markPrice(), 0);
        ob2.mockSetBook(20_590, 20_610);
        ob2.mockSetLastTrade(2.06e18, uint64(block.number + 1));
        oracle.setStale(false);
        oracle.setPrice(I0);
        _roll(1);
        c2.updateFunding();
        assertEq(c2.markPrice(), 2.06e18, "no previous good mark: live median, no division by zero");
        _roll(1);
        ob2.mockSetBook(21_990, 22_010);
        ob2.mockSetLastTrade(2.2e18, uint64(block.number));
        c2.updateFunding();
        assertEq(c2.markPrice(), 2.062e18, "then bounded: +3% -> +3.1%");
    }
}
