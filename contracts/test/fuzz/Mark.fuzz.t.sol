// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";
import {MarkPriceLib} from "../../src/libs/MarkPriceLib.sol";

contract MarkPriceLibFuzzTest is Test {
    /// The median is one of the inputs, with at least two inputs on each side (≤ and ≥).
    function testFuzz_median_property(uint256 a, uint256 b, uint256 c) public pure {
        uint256 m = MarkPriceLib.median3(a, b, c);
        assertTrue(m == a || m == b || m == c, "is an input");
        uint256 le = (a <= m ? 1 : 0) + (b <= m ? 1 : 0) + (c <= m ? 1 : 0);
        uint256 ge = (a >= m ? 1 : 0) + (b >= m ? 1 : 0) + (c >= m ? 1 : 0);
        assertGe(le, 2);
        assertGe(ge, 2);
        // One manipulated input can't push the median outside the range of the other two.
        assertGe(m, FPM.min(b, c));
        assertLe(m, FPM.max(b, c));
        assertGe(m, FPM.min(a, c));
        assertLe(m, FPM.max(a, c));
    }

    struct In {
        uint256 index;
        int256 ema;
        uint256 bid;
        uint256 ask;
        uint256 lastPx;
        uint256 lastBlk;
        uint256 blk;
    }

    function _bound(In memory x) internal pure returns (In memory) {
        x.index = bound(x.index, 1e9, 1e24);
        x.ema = bound(x.ema, -0.5e18, 0.5e18);
        x.bid = bound(x.bid, 1, 1e25);
        x.ask = bound(x.ask, x.bid + 1, 1e25 + 1);
        x.lastPx = bound(x.lastPx, 1, 1e25);
        x.blk = bound(x.blk, 200, 1e12);
        return x;
    }

    function _a(In memory x) internal pure returns (uint256) {
        return uint256(int256(x.index) + x.ema * int256(x.index) / 1e18);
    }

    function _clamp(In memory x, uint256 v) internal pure returns (uint256) {
        uint256 e = x.index * 0.05e18 / 1e18;
        return FPM.clamp(v, x.index - e, x.index + e);
    }

    function _mark(In memory x) internal pure returns (uint256) {
        return MarkPriceLib.markPrice(x.index, x.ema, x.bid, x.ask, x.lastPx, x.lastBlk, x.blk);
    }

    /// Row 1: two-sided book + fresh trade ⇒ clamp(median(A, mid, last)).
    function testFuzz_row1_median(In memory x, uint256 age) public pure {
        x = _bound(x);
        x.lastBlk = x.blk - bound(age, 0, 100);
        uint256 m = _mark(x);
        assertEq(m, _clamp(x, MarkPriceLib.median3(_a(x), (x.bid + x.ask) / 2, x.lastPx)));
        assertGe(m, x.index - x.index * 5 / 100);
        assertLe(m, x.index + x.index * 5 / 100);
    }

    /// Row 2: one-sided / empty book + fresh trade ⇒ A.
    function testFuzz_row2_noBook(In memory x, uint256 age, uint8 which) public pure {
        x = _bound(x);
        x.lastBlk = x.blk - bound(age, 0, 100);
        if (which % 3 == 0) x.bid = 0;
        else if (which % 3 == 1) x.ask = 0;
        else (x.bid, x.ask) = (x.ask, x.bid); // crossed
        assertEq(_mark(x), _clamp(x, _a(x)));
    }

    /// Row 3: two-sided book + stale (or no) trade ⇒ A.
    function testFuzz_row3_staleTrade(In memory x, uint256 age, bool never) public pure {
        x = _bound(x);
        x.lastBlk = x.blk - bound(age, 101, 200);
        if (never) x.lastPx = 0;
        assertEq(_mark(x), _clamp(x, _a(x)));
    }

    /// Row 4: nothing ⇒ A.
    function testFuzz_row4_nothing(In memory x, uint256 age) public pure {
        x = _bound(x);
        x.bid = 0;
        x.ask = 0;
        x.lastBlk = x.blk - bound(age, 101, 200);
        assertEq(_mark(x), _clamp(x, _a(x)));
    }

    /// Fair price is the mid iff spread·50 ≤ mid, else the index.
    function testFuzz_fairBookPrice(uint256 index, uint256 bid, uint256 ask) public pure {
        index = bound(index, 1, 1e25);
        bid = bound(bid, 1, 1e25);
        ask = bound(ask, bid + 1, 1e25 + 1);
        uint256 s = MarkPriceLib.fairBookPrice(index, bid, ask);
        uint256 mid = (bid + ask) / 2;
        if ((ask - bid) * 50 <= mid) assertEq(s, mid);
        else assertEq(s, index);
        assertEq(MarkPriceLib.fairBookPrice(index, 0, ask), index);
    }
}
