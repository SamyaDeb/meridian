// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MarkPriceLib} from "../../src/libs/MarkPriceLib.sol";

contract MarkPriceLibTest is Test {
    uint256 constant I = 2e18;

    function _mark(int256 ema, uint256 bid, uint256 ask, uint256 lastPx, uint256 lastBlk, uint256 blk)
        internal
        pure
        returns (uint256)
    {
        return MarkPriceLib.markPrice(I, ema, bid, ask, lastPx, lastBlk, blk);
    }

    // ─── median ─────────────────────────────────────────────────────────────────────────────────────────
    function test_median3_allOrders() public pure {
        assertEq(MarkPriceLib.median3(1, 2, 3), 2);
        assertEq(MarkPriceLib.median3(1, 3, 2), 2);
        assertEq(MarkPriceLib.median3(2, 1, 3), 2);
        assertEq(MarkPriceLib.median3(2, 3, 1), 2);
        assertEq(MarkPriceLib.median3(3, 1, 2), 2);
        assertEq(MarkPriceLib.median3(3, 2, 1), 2);
        assertEq(MarkPriceLib.median3(5, 5, 1), 5);
        assertEq(MarkPriceLib.median3(1, 5, 5), 5);
    }

    // ─── MATH_SPEC §2.1 fallback table ───────────────────────────────────────────────────────────────────
    function test_mark_row1_bookAndFreshTrade_median() public pure {
        // A = 2·1.001 = 2.002, B = 2.01, C = 2.005 ⇒ median 2.005
        assertEq(_mark(1e15, 2.0e18, 2.02e18, 2.005e18, 950, 1000), 2.005e18);
        // C is exactly 100 blocks old: still fresh
        assertEq(_mark(1e15, 2.0e18, 2.02e18, 2.005e18, 900, 1000), 2.005e18);
    }

    function test_mark_row2_noBook_freshTrade_isA() public pure {
        assertEq(_mark(1e15, 0, 2.02e18, 2.03e18, 999, 1000), 2.002e18, "no bids");
        assertEq(_mark(1e15, 2.0e18, 0, 2.03e18, 999, 1000), 2.002e18, "no asks");
        assertEq(_mark(1e15, 2.02e18, 2.0e18, 2.03e18, 999, 1000), 2.002e18, "crossed book = unusable");
    }

    function test_mark_row3_book_staleTrade_isA() public pure {
        assertEq(_mark(1e15, 2.0e18, 2.02e18, 2.03e18, 899, 1000), 2.002e18, "101 blocks old");
        assertEq(_mark(1e15, 2.0e18, 2.02e18, 0, 0, 1000), 2.002e18, "never traded");
    }

    function test_mark_row4_nothing_isA() public pure {
        assertEq(_mark(-2e15, 0, 0, 0, 0, 1000), 1.996e18);
    }

    function test_mark_clampedToIndexBand() public pure {
        // A = I·1.05 (ema at a 5% band), B and C far above ⇒ median above band ⇒ clamp to I·1.05
        assertEq(_mark(0.05e18, 3e18, 3.1e18, 3e18, 1000, 1000), 2.1e18);
        // everything far below ⇒ clamp to I·0.95
        assertEq(_mark(-0.2e18, 1e18, 1.01e18, 1e18, 1000, 1000), 1.9e18);
    }

    function test_mark_singleManipulatedInputCannotMoveIt() public pure {
        // A = 2.002, C = 2.004; B manipulated to 2.09 ⇒ median = C
        assertEq(_mark(1e15, 2.08e18, 2.1e18, 2.004e18, 1000, 1000), 2.004e18);
    }

    function test_mark_futureTradeBlockIgnored() public pure {
        assertEq(_mark(0, 2.0e18, 2.02e18, 2.03e18, 1001, 1000), 2e18, "median(A,B,A) = A");
    }

    // ─── fair book price §2.2 ───────────────────────────────────────────────────────────────────────────
    function test_fair_midWhenSpreadWithin2pct() public pure {
        // spread 0.04 on mid 2.00 = exactly 2% ⇒ mid
        assertEq(MarkPriceLib.fairBookPrice(I, 1.98e18, 2.02e18), 2e18);
        // spread just above 2% ⇒ index
        assertEq(MarkPriceLib.fairBookPrice(1.5e18, 1.98e18, 2.02e18 + 1e6), 1.5e18);
    }

    function test_fair_indexWhenOneSided() public pure {
        assertEq(MarkPriceLib.fairBookPrice(I, 0, 2.02e18), I);
        assertEq(MarkPriceLib.fairBookPrice(I, 2.02e18, 0), I);
        assertEq(MarkPriceLib.fairBookPrice(I, 0, 0), I);
        assertEq(MarkPriceLib.fairBookPrice(I, 2.02e18, 2.02e18), I, "locked");
    }

    function test_bookMid_roundsDown() public pure {
        (uint256 mid, bool ok) = MarkPriceLib.bookMid(1, 4);
        assertTrue(ok);
        assertEq(mid, 2);
    }
}
