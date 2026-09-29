// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";
import {MarginLib} from "../../src/libs/MarginLib.sol";

contract MarginLibFuzzTest is Test {
    /// A position consistent with MarginLib: size and ON of the same sign (entry price 1e-9 … 1e6).
    function _pos(int256 size, uint256 entry) internal pure returns (int256 s, int256 on) {
        s = bound(size, -1e21, 1e21);
        uint256 e = bound(entry, 1e9, 1e24);
        uint256 n = FPM.mulWad(FPM.abs(s), e);
        on = s >= 0 ? int256(n) : -int256(n);
    }

    /// Size moves by exactly Δq; cash identity realized − ΔON = −sign(Δq)·notional holds to the wei (I1 building block).
    function testFuzz_fill_exactAccounting(int256 size, uint256 entry, int256 dq, uint256 price) public pure {
        (int256 s0, int256 on0) = _pos(size, entry);
        dq = bound(dq, -1e21, 1e21);
        uint256 notional = FPM.mulWad(FPM.abs(dq), bound(price, 1e9, 1e24));
        (int256 s, int256 on, int256 r) = MarginLib.applyFill(s0, on0, dq, notional);
        assertEq(s, s0 + dq, "size");
        int256 signedN = dq >= 0 ? int256(notional) : -int256(notional);
        assertEq(r - (on - on0), -signedN, "cash identity");
        if (s == 0) assertEq(on, 0, "flat => ON 0");
        if (s > 0) assertGe(on, 0, "long ON >= 0");
        if (s < 0) assertLe(on, 0, "short ON <= 0");
    }

    /// Realized pnl never exceeds the exact rational value (released ↑, close notional against the account).
    function testFuzz_fill_realizedRoundsDown(int256 size, uint256 entry, int256 dq, uint256 price) public pure {
        (int256 s0, int256 on0) = _pos(size, entry);
        vm.assume(s0 != 0);
        dq = bound(dq, -1e21, 1e21);
        vm.assume(dq != 0 && (dq > 0) != (s0 > 0)); // a decrease
        uint256 notional = FPM.mulWad(FPM.abs(dq), bound(price, 1e9, 1e24));
        (,, int256 r) = MarginLib.applyFill(s0, on0, dq, notional);
        int256 absQ = int256(FPM.abs(s0));
        int256 absD = int256(FPM.abs(dq));
        int256 c = absD < absQ ? absD : absQ;
        int256 sign = s0 > 0 ? int256(1) : int256(-1);
        // exact: r* = sign·c·N/|Δq| − ON·c/|q|  ⇒  r·|Δq|·|q| ≤ sign·c·N·|q| − ON·c·|Δq|  (|values| ≤ 1e69)
        assertLe(r * absD * absQ, sign * c * int256(notional) * absQ - on0 * c * absD);
        // and the error is < 2 wei (one rounding per component)
        assertGt((r + 2) * absD * absQ, sign * c * int256(notional) * absQ - on0 * c * absD);
    }

    /// upnl ↓, IM ↑, MM ↑, reserve ↑.
    function testFuzz_equityComponents(int256 q, int256 on, uint256 mark, uint256 imr, uint256 reserved) public pure {
        q = bound(q, -1e30, 1e30);
        on = bound(on, -1e36, 1e36);
        mark = bound(mark, 1, 1e24);
        imr = bound(imr, 1, 0.5e18);
        reserved = bound(reserved, 0, 1e36);
        int256 u = MarginLib.unrealizedPnl(q, on, mark);
        assertLe(u * 1e18, q * int256(mark) - on * 1e18, "upnl down");
        assertGt((u + 1) * 1e18, q * int256(mark) - on * 1e18, "within 1 wei");

        uint256 aq = FPM.abs(q);
        uint256 im = MarginLib.initialMargin(q, mark, imr, reserved);
        assertGe((im - reserved) * 1e36, aq * mark * imr, "IM up");
        assertLe(im - reserved, aq * mark * imr / 1e36 + 2, "tight");
        uint256 mm = MarginLib.maintenanceMargin(q, mark, imr / 2);
        assertGe(mm * 1e36, aq * mark * (imr / 2), "MM up");
        uint256 om = MarginLib.orderMargin(aq, mark, imr);
        assertGe(om * 1e36, aq * mark * imr, "reserve up");
    }

    /// Displayed liquidation price is on the safe side of the exact one, within 3 wei:
    /// a long is liquidatable just below it, a short just above it.
    function testFuzz_liquidationPrice(uint256 absQ, uint256 entry, uint256 lev, uint256 mmr, bool isLong) public pure {
        absQ = bound(absQ, 1e18, 1e27);
        uint256 e = bound(entry, 1e12, 1e22);
        uint256 onAbs = FPM.mulWad(absQ, e);
        uint256 c = onAbs / bound(lev, 2, 50); // 2x … 50x
        mmr = bound(mmr, 0.01e18, 0.4e18);
        vm.assume(c > 0);
        int256 q = isLong ? int256(absQ) : -int256(absQ);
        int256 on = isLong ? int256(onAbs) : -int256(onAbs);
        uint256 p = MarginLib.liquidationPrice(q, on, int256(c), mmr);
        if (isLong) {
            // P·q·(1−mmr) ≥ (ON − C) exactly ⇒ P ≥ exact
            assertGe(p * absQ * (1e18 - mmr), (onAbs - c) * 1e36);
            assertLt((p - 3) * absQ * (1e18 - mmr), (onAbs - c) * 1e36);
            // just below it the account is liquidatable
            uint256 below = p * 99 / 100;
            int256 eq = int256(c) + MarginLib.unrealizedPnl(q, on, below);
            assertLt(eq, int256(MarginLib.maintenanceMargin(q, below, mmr)));
        } else {
            assertLe(p * absQ * (1e18 + mmr), (onAbs + c) * 1e36);
            assertGt((p + 3) * absQ * (1e18 + mmr), (onAbs + c) * 1e36);
            uint256 above = p * 101 / 100;
            int256 eq = int256(c) + MarginLib.unrealizedPnl(q, on, above);
            assertLt(eq, int256(MarginLib.maintenanceMargin(q, above, mmr)));
        }
    }
}
