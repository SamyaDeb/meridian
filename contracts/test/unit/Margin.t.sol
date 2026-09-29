// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MarginLib} from "../../src/libs/MarginLib.sol";

contract MarginLibTest is Test {
    function _fill(int256 s, int256 on, int256 dq, uint256 n) internal pure returns (int256, int256, int256) {
        return MarginLib.applyFill(s, on, dq, n);
    }

    // ─── increase ────────────────────────────────────────────────────────────────────────────────────────
    function test_fill_openLongAndShort() public pure {
        (int256 s, int256 on, int256 r) = _fill(0, 0, 10e18, 20e18);
        assertEq(s, 10e18);
        assertEq(on, 20e18);
        assertEq(r, 0);
        (s, on, r) = _fill(-5e18, -10e18, -5e18, 11e18);
        assertEq(s, -10e18);
        assertEq(on, -21e18);
        assertEq(r, 0);
    }

    function test_fill_zeroIsNoop() public pure {
        (int256 s, int256 on, int256 r) = _fill(3e18, 6e18, 0, 0);
        assertEq(s, 3e18);
        assertEq(on, 6e18);
        assertEq(r, 0);
    }

    // ─── decrease (released toward +∞) ─────────────────────────────────────────────────────────────────
    function test_fill_partialCloseLong() public pure {
        (int256 s, int256 on, int256 r) = _fill(10e18, 20e18, -4e18, 10e18); // sell 4 @ 2.5, entry 2
        assertEq(s, 6e18);
        assertEq(on, 12e18);
        assertEq(r, 2e18);
    }

    function test_fill_partialCloseLong_releasedRoundsUp() public pure {
        // entry 10/3; sell 1 @ 4 ⇒ released = ⌈3.333…⌉, realized = 0.666… rounded down
        (int256 s, int256 on, int256 r) = _fill(3e18, 10e18, -1e18, 4e18);
        assertEq(s, 2e18);
        assertEq(on, 10e18 - 3_333_333_333_333_333_334);
        assertEq(r, 666_666_666_666_666_666);
    }

    function test_fill_partialCloseShort_releasedTowardZero() public pure {
        // short 3 at ON −10; buy back 1 @ 3 ⇒ released = −3.333…333 (toward +∞), realized 0.333…333 (down)
        (int256 s, int256 on, int256 r) = _fill(-3e18, -10e18, 1e18, 3e18);
        assertEq(s, -2e18);
        assertEq(on, -10e18 + 3_333_333_333_333_333_333);
        assertEq(r, 333_333_333_333_333_333);
    }

    function test_fill_fullCloseZeroesOpenNotional() public pure {
        (int256 s, int256 on, int256 r) = _fill(3e18, 10e18, -3e18, 9e18);
        assertEq(s, 0);
        assertEq(on, 0);
        assertEq(r, -1e18);
        (s, on, r) = _fill(-7e18, -1e18 - 1, 7e18, 1e18);
        assertEq(s, 0);
        assertEq(on, 0);
        assertEq(r, 1);
    }

    function test_fill_flipLongToShort() public pure {
        // long 2 (ON 4) sells 5 for 15 ⇒ closes 2 for ⌊15·2/5⌋ = 6, opens short 3 for 9
        (int256 s, int256 on, int256 r) = _fill(2e18, 4e18, -5e18, 15e18);
        assertEq(s, -3e18);
        assertEq(on, -9e18);
        assertEq(r, 2e18);
    }

    function test_fill_flipShortToLong_closeRoundsUp() public pure {
        // short 1 (ON −3) buys 3 for 10 ⇒ close part ⌈10/3⌉ paid, remainder opens long with the rest
        (int256 s, int256 on, int256 r) = _fill(-1e18, -3e18, 3e18, 10e18);
        assertEq(s, 2e18);
        assertEq(r, -3_333_333_333_333_333_334 + 3e18);
        assertEq(on, 10e18 - 3_333_333_333_333_333_334);
    }

    // ─── equity components ─────────────────────────────────────────────────────────────────────────────
    function test_upnl_roundsDown() public pure {
        assertEq(MarginLib.unrealizedPnl(10e18, 20e18, 2.5e18), 5e18);
        assertEq(MarginLib.unrealizedPnl(-10e18, -20e18, 2.5e18), -5e18);
        assertEq(MarginLib.unrealizedPnl(1, 0, 1.5e18), 1, "1.5 wei -> 1");
        assertEq(MarginLib.unrealizedPnl(-1, 0, 1.5e18), -2, "-1.5 wei -> -2");
    }

    function test_margins_roundUp() public pure {
        assertEq(MarginLib.initialMargin(10e18, 2e18, 0.2e18, 0), 4e18);
        assertEq(MarginLib.initialMargin(-10e18, 2e18, 0.2e18, 7), 4e18 + 7, "adds reserved");
        assertEq(MarginLib.maintenanceMargin(-10e18, 2e18, 0.1e18), 2e18);
        assertEq(MarginLib.initialMargin(1, 1e18, 0.2e18, 0), 1, "0.2 wei -> 1");
        assertEq(MarginLib.maintenanceMargin(1, 1e18, 0.1e18), 1);
        assertEq(MarginLib.orderMargin(3, 0.5e18, 0.2e18), 1, "1.5*0.2 -> 2 -> 1");
        assertEq(MarginLib.orderMargin(100e18, 0.029e18, 0.2e18), 0.58e18);
    }

    function test_entryPrice() public pure {
        assertEq(MarginLib.entryPrice(0, 0), 0);
        assertEq(MarginLib.entryPrice(3e18, 10e18), 3_333_333_333_333_333_333);
        assertEq(MarginLib.entryPrice(-4e18, -10e18), 2.5e18);
    }

    // ─── liquidation price (MATH_SPEC §3.2) ────────────────────────────────────────────────────────────
    function test_liqPrice_long5x() public pure {
        // entry 1, C = 0.2 (5x), mmr 10% ⇒ (1 − 0.2)/0.9 = 0.888…9 (↑). Crash demo: −15% (0.85) is below it.
        uint256 p = MarginLib.liquidationPrice(1e18, 1e18, 0.2e18, 0.1e18);
        assertEq(p, 888_888_888_888_888_889);
        assertGt(p, 0.85e18);
    }

    function test_liqPrice_short5x() public pure {
        // (1 + 0.2)/1.1 = 1.0909…09 (↓)
        assertEq(MarginLib.liquidationPrice(-1e18, -1e18, 0.2e18, 0.1e18), 1_090_909_090_909_090_909);
    }

    function test_liqPrice_edges() public pure {
        assertEq(MarginLib.liquidationPrice(0, 0, 1e18, 0.1e18), 0, "flat");
        assertEq(MarginLib.liquidationPrice(1e18, 1e18, 1e18, 0.1e18), 0, "fully collateralized long");
        assertEq(MarginLib.liquidationPrice(-1e18, -1e18, -1e18, 0.1e18), 0, "short already underwater");
    }
}
