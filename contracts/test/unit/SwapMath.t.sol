// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SwapMathLib} from "../../src/libs/SwapMathLib.sol";
import {SwapMarginLib} from "../../src/libs/SwapMarginLib.sol";

/// @notice MATH_SPEC §6 (with the Phase 2 amendments: one-division net, kDelta computed once).
contract SwapMathTest is Test {
    int256 constant W = 1e18;
    int256 constant YEAR = 365 days;
    int256 constant I = 0.029e18;
    int256 constant Q = 1_000_000e18; // 1,000,000 MON

    /// ΔG over `sec` at constant index I (G is index·seconds, WAD·s) and ΔF for a per-second rate at `aprWad`.
    function _indices(int256 aprWad, int256 sec) internal pure returns (int256 dF, int256 dG) {
        dG = I * sec;
        dF = aprWad * dG / (W * YEAR); // F = ∫ r·I dt with r = apr/YEAR (per second)
    }

    // ─── accrual ────────────────────────────────────────────────────────────────
    function test_net_worked_6_6_long30d() public pure {
        (int256 dF, int256 dG) = _indices(0.18e18, 30 days); // realized 18%
        int256 k = SwapMathLib.kDelta(Q, 0.12e18); // long at 12%
        int256 net = SwapMathLib.net(Q, k, dF, dG);
        assertApproxEqAbs(net, 143.01e18, 0.005e18, "MATH_SPEC 6.6: +143.01 AUSD");
    }

    function test_net_worked_6_6_offsetLockedSpread() public pure {
        int256 k = SwapMathLib.kDelta(Q, 0.12e18) - SwapMathLib.kDelta(Q, 0.15e18); // bought at 12%, sold at 15%
        assertEq(k, -30_000e18, "K = 1e6*(0.12 - 0.15)");
        (int256 dF, int256 dG) = _indices(0.25e18, 20 days); // funding path is irrelevant once q = 0
        int256 net = SwapMathLib.net(0, k, dF, dG);
        assertApproxEqAbs(net, 47.67e18, 0.01e18, "locked spread +47.7 AUSD over the remaining 20 d");
    }

    function test_net_isOneFloorDivision() public pure {
        // q·ΔF·YEAR − K·ΔG = −1 ⇒ floor(−1 / (1e18·YEAR)) = −1 (two truncating divisions would give 0)
        assertEq(SwapMathLib.net(1, 0, 0, 0), 0);
        assertEq(SwapMathLib.net(0, 1, 0, 1), -1, "fixed leg of 1e-36 rounds against the long");
        assertEq(SwapMathLib.net(-1, 0, 1, 0), -1, "floating leg of -1e-18 rounds against the short");
        assertEq(SwapMathLib.net(1, 0, 1, 0), 0, "a positive fraction floors to 0 (receiver gets less)");
    }

    function test_net_zeroWhenNothingMoved() public pure {
        assertEq(SwapMathLib.net(Q, 5e22, 0, 0), 0);
        assertEq(SwapMathLib.net(0, 0, 1e15, 1e22), 0);
    }

    // ─── fills ───────────────────────────────────────────────────────────────────
    function test_kDelta_computedOnceSymmetric() public pure {
        int256 kd = SwapMathLib.kDelta(3e18, 0.123456789e18); // truncates toward 0
        (int256 qb, int256 kb) = SwapMathLib.applyFill(0, 0, 3e18, kd);
        (int256 qs, int256 ks) = SwapMathLib.applyFill(0, 0, -3e18, -kd);
        assertEq(qb + qs, 0);
        assertEq(kb + ks, 0, "sum K = 0 exactly");
    }

    function test_kDelta_negativeAprAndTruncation() public pure {
        assertEq(SwapMathLib.kDelta(1, 0.5e18), 0); // 0.5 wei → 0
        assertEq(SwapMathLib.kDelta(-3, 0.5e18), -1); // −1.5 → −1 (toward 0)
        assertEq(SwapMathLib.kDelta(2e18, -0.05e18), -0.1e18); // negative APR is allowed (A > −100%)
    }

    function test_neverReducesKProportionally() public pure {
        (int256 q, int256 k) =
            SwapMathLib.applyFill(Q, SwapMathLib.kDelta(Q, 0.12e18), -Q / 2, -SwapMathLib.kDelta(Q / 2, 0.1e18));
        assertEq(q, Q / 2);
        assertEq(k, 120_000e18 - 50_000e18, "K += dq*A for the closing fill, no pro-rata reduction");
    }

    function test_liquidationShare_proportionalAndConserving() public pure {
        int256 k = SwapMathLib.kDelta(Q, 0.12e18);
        int256 kx = SwapMathLib.liquidationShare(Q, k, Q / 4);
        assertEq(kx, 30_000e18);
        assertEq(SwapMathLib.liquidationShare(0, k, 0), 0);
    }

    // ─── value ───────────────────────────────────────────────────────────────────
    function test_value_plainLong() public pure {
        int256 k = SwapMathLib.kDelta(Q, 0.12e18);
        // mark 15%, 30 d left: V = q·I·(0.15 − 0.12)·τ/YEAR = 29,000·0.03·30/365 ≈ 71.51
        int256 v = SwapMathLib.value(Q, k, 0.15e18, uint256(I), 30 days);
        assertApproxEqAbs(v, 71.5068e18, 0.001e18);
    }

    function test_value_lockedSpread_qZero() public pure {
        int256 v = SwapMathLib.value(0, -30_000e18, 0.2e18, uint256(I), 20 days); // −K·I·τ/YEAR
        assertApproxEqAbs(v, 47.67e18, 0.01e18);
    }

    function test_value_roundsDown() public pure {
        assertEq(SwapMathLib.value(0, 1, 0, 1, 1), -1);
        assertEq(SwapMathLib.value(0, -1, 0, 1, 1), 0);
    }

    // ─── margin ──────────────────────────────────────────────────────────────────
    function test_margin_defaults_atInception() public pure {
        int256 k = SwapMathLib.kDelta(Q, 0.12e18);
        uint256 capApr = 555_555_555_556 * 365 days; // 0.2%/h ⇒ 1,752% APR
        uint256 mm = SwapMarginLib.maintenanceMargin(Q, k, 0.12e18, uint256(I), capApr, 86_400, 0.05e18, 30 days);
        uint256 im = SwapMarginLib.initialMargin(mm, 1.5e18);
        uint256 notional = uint256(Q) * uint256(I) / 1e18; // 29,000 AUSD
        assertApproxEqRel(mm * 1e18 / notional, 0.0524e18, 0.002e18, "MM ~ 5.24% of notional");
        assertApproxEqRel(im * 1e18 / notional, 0.0787e18, 0.002e18, "IM ~ 7.87% (~ 12.7x)");
        assertApproxEqAbs(im, 2281e18, 3e18, "MATH_SPEC 6.6: IM ~ 2,281 AUSD");
    }

    function test_margin_priceShockTerm_andSymmetry() public pure {
        uint256 capApr = 555_555_555_556 * 365 days;
        int256 k = SwapMathLib.kDelta(Q, 0.12e18);
        uint256 mmAtMark = SwapMarginLib.maintenanceMargin(Q, k, 0.12e18, uint256(I), capApr, 86_400, 0.05e18, 30 days);
        uint256 mmOff = SwapMarginLib.maintenanceMargin(Q, k, 0.3e18, uint256(I), capApr, 86_400, 0.05e18, 30 days);
        // + |q·markApr − K|·I·τ/YEAR·0.3 = 0.18·29,000·30/365·0.3
        assertApproxEqAbs(mmOff - mmAtMark, 128.71e18, 0.01e18);
        uint256 mmShort = SwapMarginLib.maintenanceMargin(-Q, -k, 0.3e18, uint256(I), capApr, 86_400, 0.05e18, 30 days);
        assertEq(mmShort, mmOff, "a short is margined like the mirrored long");
    }

    function test_margin_closedAccount_onlyPriceShockOfLockedStream() public pure {
        uint256 capApr = 555_555_555_556 * 365 days;
        uint256 mm =
            SwapMarginLib.maintenanceMargin(0, -30_000e18, 0.2e18, uint256(I), capApr, 86_400, 0.05e18, 20 days);
        // q = 0: worst-rate term I·|K|·horizon/YEAR + price shock |K|·I·τ/YEAR·0.3
        uint256 worst = uint256(30_000e18) * uint256(I) / 1e18 * 86_400 / 365 days;
        uint256 shock = uint256(30_000e18) * uint256(I) / 1e18 * 20 days / 365 days * 3 / 10;
        assertApproxEqAbs(mm, worst + shock, 2);
    }

    function test_margin_roundsUp() public pure {
        assertGe(SwapMarginLib.maintenanceMargin(1, 0, 0, 1, 1, 1, 1, 1), 1, "tiny positions still need >= 1 wei");
        assertEq(SwapMarginLib.initialMargin(1, 1.5e18), 2);
        assertEq(SwapMarginLib.maintenanceMargin(0, 0, 0.1e18, 0.029e18, 1e19, 86_400, 0.05e18, 30 days), 0);
    }
}
