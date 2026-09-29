// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TickBitmap} from "../../src/orderbook/libraries/TickBitmap.sol";
import {TickBitmapHarness} from "../fuzz/OrderBookTickBitmap.fuzz.t.sol";

contract TickBitmapTest is Test {
    TickBitmapHarness h;
    uint256 constant MAX = TickBitmap.MAX_TICK;

    function setUp() public {
        h = new TickBitmapHarness();
    }

    function test_empty() public view {
        (, bool f) = h.below(MAX);
        assertFalse(f);
        (, f) = h.above(0);
        assertFalse(f);
    }

    function test_sameWord() public {
        h.set(29_000);
        h.set(29_005);
        _eqBelow(29_004, 29_000);
        _eqBelow(29_005, 29_005);
        _eqAbove(29_001, 29_005);
        _eqAbove(29_000, 29_000);
    }

    function test_acrossLeafWordsAndMidWords() public {
        h.set(255); // leaf 0
        h.set(256); // leaf 1
        h.set(65_536); // mid 1
        h.set(MAX); // last tick
        _eqBelow(65_535, 256);
        _eqBelow(255, 255);
        _eqAbove(257, 65_536);
        _eqAbove(65_537, MAX);
        _eqBelow(MAX - 1, 65_536);
    }

    function test_clearPropagates() public {
        h.set(70_000);
        h.set(10);
        h.clear(70_000);
        assertFalse(h.isSet(70_000));
        _eqBelow(MAX, 10);
        (, bool f) = h.above(11);
        assertFalse(f, "cleared mid/root bits");
        h.clear(10);
        (, f) = h.below(MAX);
        assertFalse(f);
    }

    function test_idempotent() public {
        h.set(5);
        h.set(5);
        h.clear(6); // clearing an unset bit is a no-op
        assertTrue(h.isSet(5));
        h.clear(5);
        h.clear(5);
        assertFalse(h.isSet(5));
    }

    function _eqBelow(uint256 q, uint256 want) internal view {
        (uint256 t, bool f) = h.below(q);
        assertTrue(f);
        assertEq(t, want);
    }

    function _eqAbove(uint256 q, uint256 want) internal view {
        (uint256 t, bool f) = h.above(q);
        assertTrue(f);
        assertEq(t, want);
    }
}
