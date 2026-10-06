// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FundingLib} from "../../src/libs/FundingLib.sol";
import {FundingParams, FundingState} from "../../src/interfaces/MeridianTypes.sol";

/// @dev Exposes FundingLib's internal functions.
contract FundingLibHarness {
    function update(FundingState memory s, FundingParams memory p, uint256 index, uint256 fair, uint256 n)
        external
        pure
        returns (FundingState memory, int256)
    {
        return FundingLib.update(s, p, index, fair, n);
    }

    function decay(uint256 alpha, uint256 n) external pure returns (uint256) {
        return FundingLib.decayFactor(alpha, n);
    }

    function premium(uint256 fair, uint256 index, uint256 band) external pure returns (int256) {
        return FundingLib.premium(fair, index, band);
    }

    function owed(int256 q, int256 fNow, int256 fEntry) external pure returns (int256) {
        return FundingLib.owed(q, fNow, fEntry);
    }
}

contract FundingLibTest is Test {
    FundingLibHarness h;

    int256 constant I_DEFAULT = 3_472_222_222; // 10.95% APR per second
    uint256 constant CAP = 555_555_555_556; // 0.2%/h
    uint256 constant DELTA = 555_555_556; // cap / 1000 per block

    function setUp() public {
        h = new FundingLibHarness();
    }

    function _params(int256 interest) internal pure returns (FundingParams memory) {
        return FundingParams({
            alpha: 2e15,
            interestRate: interest,
            rateCap: CAP,
            maxRateChangePerBlock: DELTA,
            blockTimeMs: 300,
            premiumBandWad: 0.05e18
        });
    }

    // ─── MATH_SPEC §1.7(a): premium only (i = 0), I = 2, p̄ = +0.1%, T = 3600 s ──────────────────────────
    function test_workedExampleA_premiumOnly() public view {
        FundingParams memory p = _params(0);
        int256 r0 = int256(1e15) / 3600; // 277_777_777_777 (spec prints 277_777_777_778 rounded)
        FundingState memory s =
            FundingState({cumFunding: 0, cumIndexTime: 0, emaPremium: 1e15, rate: r0, lastUpdateBlock: 0});

        (FundingState memory s1, int256 prem) = h.update(s, p, 2e18, 2.002e18, 1);
        assertEq(prem, 1e15, "premium sample = +0.1%");
        assertEq(s1.emaPremium, 1e15, "EMA unchanged when sample == EMA");
        assertEq(s1.rate, 277_777_777_777, "r = p/T");
        assertEq(s1.cumFunding, 166_666_666_666, "per-block dF = r*I*0.3s");
        assertEq(s1.cumIndexTime, 0.6e18, "per-block dG = I*0.3s");

        // 1 h = 12,000 blocks, touched every block.
        s = s1;
        for (uint256 b = 1; b < 12_000; ++b) {
            (s,) = h.update(s, p, 2e18, 2.002e18, 1);
        }
        assertEq(s.cumFunding, 12_000 * int256(166_666_666_666));
        int256 owedLong = h.owed(1000e18, s.cumFunding, 0);
        assertEq(owedLong, 1_999_999_999_992_000_000, "exact integer result");
        assertApproxEqAbs(owedLong, 2e18, 1e14, "= 2.0000 AUSD");
        assertEq(s.cumIndexTime, 2e18 * 3600, "G = I * 3600 s");

        // Same hour in one touch (n = 12,000): one fullMulDiv, less truncation.
        FundingState memory one =
            FundingState({cumFunding: 0, cumIndexTime: 0, emaPremium: 1e15, rate: r0, lastUpdateBlock: 0});
        (one,) = h.update(one, p, 2e18, 2.002e18, 12_000);
        assertEq(one.cumFunding, 1_999_999_999_994_400);
        assertEq(h.owed(1000e18, one.cumFunding, 0), 1_999_999_999_994_400_000);
    }

    /// MATH_SPEC §1.7(a): gap of n = 100 blocks ⇒ αeff = 1 − 0.998^100 = 0.181433…
    function test_workedExampleA_alphaEff() public view {
        uint256 alphaEff = 1e18 - h.decay(2e15, 100);
        // Exact: 1 − 0.998^100 = 0.181433195311572184201… (80-digit decimal reference).
        assertEq(alphaEff, 181_433_195_311_572_178, "to the wei: (1-a)^n rounded up at each of 7 squarings");
        assertLe(alphaEff, 181_433_195_311_572_184, "alphaEff rounds down (<= floor of the exact value)");
        assertEq((alphaEff + 0.5e14) / 1e14, 1814, "= 0.1814");
    }

    // ─── MATH_SPEC §1.7(b): interest only (default i, p̄ = 0), I = 0.029 ─────────────────────────────────
    function test_workedExampleB_interestOnly() public view {
        FundingParams memory p = _params(I_DEFAULT);
        FundingState memory s =
            FundingState({cumFunding: 0, cumIndexTime: 0, emaPremium: 0, rate: I_DEFAULT, lastUpdateBlock: 0});
        (FundingState memory s1,) = h.update(s, p, 0.029e18, 0.029e18, 1);
        assertEq(s1.rate, I_DEFAULT);
        assertEq(s1.cumFunding, 30_208_333, "per-block dF (spec: WAD 30_208_333)");

        // 1 day = 288,000 blocks touched every block: F = 288,000 * 30,208,333 (constant per-block dF).
        int256 fDay = 288_000 * s1.cumFunding;
        int256 owedLong = h.owed(1_000_000e18, fDay, 0);
        assertEq(owedLong, 8_699_999_904_000_000_000);
        assertApproxEqAbs(owedLong, 8.7e18, 1e15, "= 8.70 AUSD");

        // One touch covering the whole day.
        (FundingState memory d,) = h.update(s, p, 0.029e18, 0.029e18, 288_000);
        assertEq(d.cumFunding, 8_699_999_999_443);
        assertApproxEqAbs(h.owed(1_000_000e18, d.cumFunding, 0), 8.7e18, 1e15);
    }

    // ─── EMA ─────────────────────────────────────────────────────────────────────────────────────────────
    function test_decay_edges() public view {
        assertEq(h.decay(2e15, 0), 1e18);
        assertEq(h.decay(2e15, 1), 0.998e18);
        assertEq(h.decay(0, 1_000_000), 1e18);
        assertEq(h.decay(1e18, 5), 0);
        assertGt(h.decay(2e15, type(uint64).max), 0, "rounded up never hits 0 for alpha < 1");
    }

    function test_ema_movesTowardSample() public view {
        FundingParams memory p = _params(0);
        FundingState memory s;
        (FundingState memory s1,) = h.update(s, p, 1e18, 1.01e18, 1); // premium +1%
        assertEq(s1.emaPremium, 0.01e18 * 2e15 / 1e18, "one block: alpha * sample");
        (FundingState memory s2,) = h.update(s, p, 1e18, 1.01e18, 100);
        assertApproxEqAbs(s2.emaPremium, 1_814_331_953_115_721, 1e3, "100 blocks: alphaEff * sample");
    }

    // ─── premium sample ──────────────────────────────────────────────────────────────────────────────────
    function test_premium_clampAndSign() public view {
        assertEq(h.premium(1.01e18, 1e18, 0.05e18), 0.01e18);
        assertEq(h.premium(0.99e18, 1e18, 0.05e18), -0.01e18);
        assertEq(h.premium(2e18, 1e18, 0.05e18), 0.05e18);
        assertEq(h.premium(0.5e18, 1e18, 0.05e18), -0.05e18);
        assertEq(h.premium(1e18, 1e18, 0.05e18), 0);
        // truncation toward zero for both signs (neutral)
        assertEq(h.premium(3e18 + 1, 3e18, 0.05e18), 0);
        assertEq(h.premium(3e18 - 1, 3e18, 0.05e18), 0);
    }

    // ─── clamps: δ first, cap last ─────────────────────────────────────────────────────────────────────
    function test_deltaClamp_scalesWithBlocks() public view {
        FundingParams memory p = _params(0);
        FundingState memory s;
        s.emaPremium = 0.05e18; // max premium ⇒ r* = 0.05/3600 = 1.39e-5 ≫ cap
        (FundingState memory s1,) = h.update(s, p, 1e18, 1.05e18, 1);
        assertEq(s1.rate, int256(DELTA), "one block: +delta");
        (FundingState memory s7,) = h.update(s, p, 1e18, 1.05e18, 7);
        assertEq(s7.rate, int256(7 * DELTA), "n blocks: +delta*n");
        (FundingState memory sN,) = h.update(s, p, 1e18, 1.05e18, 5000);
        assertEq(sN.rate, int256(CAP), "cap binds after ~1000 blocks");
        s.emaPremium = -0.05e18;
        (FundingState memory sNeg,) = h.update(s, p, 1e18, 0.95e18, 3);
        assertEq(sNeg.rate, -int256(3 * DELTA));
    }

    function test_capClampAppliedLast_afterAdminLowersCap() public view {
        FundingParams memory p = _params(0);
        FundingState memory s;
        s.emaPremium = 0.05e18;
        s.rate = int256(CAP); // at the old cap
        p.rateCap = CAP / 2; // admin lowered cap: δ alone would allow rate ≈ CAP − δ
        (FundingState memory s1,) = h.update(s, p, 1e18, 1.05e18, 1);
        assertEq(s1.rate, int256(CAP / 2), "|r| <= cap always");
    }

    function test_capClampAppliedLast_afterAdminLowersCap_negative() public view {
        FundingParams memory p = _params(0);
        FundingState memory s;
        s.emaPremium = -0.05e18;
        s.rate = -int256(CAP);
        p.rateCap = CAP / 4;
        (FundingState memory s1,) = h.update(s, p, 1e18, 0.95e18, 1);
        assertEq(s1.rate, -int256(CAP / 4), "|r| <= cap on the negative side too");
    }

    /// δ-then-cap order is observable: cap-then-δ would give r_prev − δ (> new cap) in the case above.
    function test_clampOrder_deltaThenCap() public view {
        FundingParams memory p = _params(0);
        FundingState memory s;
        s.emaPremium = 0.05e18;
        s.rate = int256(CAP);
        p.rateCap = CAP / 2;
        (FundingState memory s1,) = h.update(s, p, 1e18, 1.05e18, 1);
        int256 capThenDelta = int256(CAP) - int256(DELTA); // clamp(cap/2, CAP−δ, CAP+δ)
        assertTrue(s1.rate != capThenDelta);
        assertEq(s1.rate, int256(CAP / 2));
    }

    // ─── accrual sign & G ──────────────────────────────────────────────────────────────────────────────
    function test_negativeRate_shortsPay() public view {
        FundingParams memory p = _params(0);
        FundingState memory s;
        s.emaPremium = -0.001e18;
        s.rate = -int256(1e15) / 3600;
        (FundingState memory s1,) = h.update(s, p, 2e18, 1.998e18, 1);
        assertEq(s1.cumFunding, -166_666_666_666, "F falls: sign applied after |r| fullMulDiv (truncates toward 0)");
        assertEq(s1.cumIndexTime, 0.6e18, "G always rises");
        assertEq(h.owed(-1000e18, s1.cumFunding, 0), 166_666_666_666_000, "short owes when F falls");
        assertEq(h.owed(1000e18, s1.cumFunding, 0), -166_666_666_666_000, "long receives");
    }

    // ─── owed rounding (MATH_SPEC §1.4: ceil for both signs) ──────────────────────────────────────────────
    function test_owed_ceilBothSigns() public view {
        assertEq(h.owed(1, 1, 0), 1, "payer pays tiny amount up");
        assertEq(h.owed(-1, 1, 0), 0, "receiver gets ceil(-1e-18) = 0");
        assertEq(h.owed(1, -1, 0), 0);
        assertEq(h.owed(-1, -1, 0), 1);
        assertEq(h.owed(1.5e18, 3, 0), 5, "4.5 -> 5");
        assertEq(h.owed(-1.5e18, 3, 0), -4, "-4.5 -> -4");
        assertEq(h.owed(2e18, 3, 0), 6, "exact stays exact");
        assertEq(h.owed(-2e18, 3, 0), -6);
        assertEq(h.owed(0, 1e18, 0), 0);
        assertEq(h.owed(7e18, 10, 10), 0);
    }
}
