// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";
import {FundingLib} from "../../src/libs/FundingLib.sol";
import {FundingParams, FundingState} from "../../src/interfaces/MeridianTypes.sol";

contract FundingLibFuzzTest is Test {
    uint256 constant MAX_CAP = 2_777_777_777_778; // 1%/h: the admin hard bound on rateCap

    function _params(uint256 alpha, uint256 cap, uint256 delta, uint256 band, int256 interest)
        internal
        pure
        returns (FundingParams memory p)
    {
        p.alpha = bound(alpha, 0, 0.5e18);
        p.rateCap = bound(cap, 1, MAX_CAP);
        p.maxRateChangePerBlock = bound(delta, 0, p.rateCap);
        p.premiumBandWad = bound(band, 0, 0.5e18);
        p.interestRate = bound(interest, -int256(p.rateCap), int256(p.rateCap));
        p.blockTimeMs = 300;
    }

    /// (1−α)^n is rounded UP: never below the round-down reference, within O(n) wei of it, monotone in n.
    function testFuzz_decay_roundsUp(uint256 alpha, uint256 n) public pure {
        alpha = bound(alpha, 0, 1e18);
        n = bound(n, 0, type(uint64).max);
        uint256 up = FundingLib.decayFactor(alpha, n);
        uint256 down = _decayDown(alpha, n);
        assertGe(up, down, "rounds up");
        // Squaring doubles the absolute error each step (e_{k+1} ≤ 2e_k + 1) ⇒ gap ≤ ~2n wei (≈ 2n·1e-18 relative).
        assertLe(up - down, 2 * n + 64, "tight");
        assertLe(up, 1e18);
        if (n > 0) assertLe(up, FundingLib.decayFactor(alpha, n - 1), "monotone");
    }

    function _decayDown(uint256 alpha, uint256 n) internal pure returns (uint256 r) {
        uint256 b = 1e18 - alpha;
        r = 1e18;
        while (n != 0) {
            if (n & 1 == 1) r = FPM.mulWad(r, b);
            n >>= 1;
            if (n != 0) b = FPM.mulWad(b, b);
        }
    }

    /// owed = ⌈q·ΔF/1e18⌉ for both signs: owed·1e18 ∈ [q·ΔF, q·ΔF + 1e18).
    function testFuzz_owed_ceil(int256 q, int256 fNow, int256 fEntry) public pure {
        q = bound(q, -1e30, 1e30);
        fNow = bound(fNow, -1e24, 1e24);
        fEntry = bound(fEntry, -1e24, 1e24);
        int256 o = FundingLib.owed(q, fNow, fEntry);
        int256 exact = q * (fNow - fEntry);
        assertGe(o * 1e18, exact, "never below exact (against the account)");
        assertLt(o * 1e18 - exact, 1e18, "by less than 1 wei");
    }

    /// |r| ≤ cap always; |r − r_prev| ≤ δ·n when r_prev was within cap. EMA stays within the band.
    function testFuzz_update_rateBounds(
        uint256 alpha,
        uint256 cap,
        uint256 delta,
        uint256 band,
        int256 interest,
        int256 prevRate,
        int256 prevEma,
        uint256 index,
        uint256 fair,
        uint256 n
    ) public pure {
        FundingParams memory p = _params(alpha, cap, delta, band, interest);
        FundingState memory s;
        s.rate = bound(prevRate, -int256(p.rateCap), int256(p.rateCap));
        s.emaPremium = bound(prevEma, -int256(p.premiumBandWad), int256(p.premiumBandWad));
        index = bound(index, 1e9, 1e24);
        fair = bound(fair, 1e9, 1e24);
        n = bound(n, 1, 10_000_000);

        (FundingState memory ns, int256 prem) = FundingLib.update(s, p, index, fair, n);
        assertLe(FPM.abs(prem), p.premiumBandWad, "premium clamped");
        assertLe(FPM.abs(ns.emaPremium), p.premiumBandWad, "EMA is a convex combination");
        assertLe(FPM.abs(ns.rate), p.rateCap, "|r| <= cap");
        assertLe(FPM.abs(ns.rate - s.rate), p.maxRateChangePerBlock * n, "|dr| <= delta*n");
    }

    /// Admin lowered the cap below the previous rate: the cap still binds on the very next update (I5 exception).
    function testFuzz_update_capBindsAfterCapLowered(
        uint256 oldCap,
        uint256 newCap,
        int256 prevRate,
        int256 prevEma,
        uint256 fair,
        uint256 n
    ) public pure {
        oldCap = bound(oldCap, 2, MAX_CAP);
        FundingParams memory p = _params(2e15, bound(newCap, 1, oldCap - 1), 555_555_556, 0.05e18, 0);
        FundingState memory s;
        s.rate = bound(prevRate, -int256(oldCap), int256(oldCap));
        s.emaPremium = bound(prevEma, -0.05e18, 0.05e18);
        (FundingState memory ns,) = FundingLib.update(s, p, 1e18, bound(fair, 0.5e18, 2e18), bound(n, 1, 1e6));
        assertLe(FPM.abs(ns.rate), p.rateCap, "|r| <= new cap immediately");
    }

    /// Per update: ΔG = ⌊I·Δt⌋ ≥ 0 and |ΔF| ≤ cap·ΔG/1e18 + 1 (I11 step bound; +1 from G's own truncation).
    function testFuzz_update_indexBounds(
        uint256 cap,
        int256 prevRate,
        int256 prevEma,
        uint256 index,
        uint256 fair,
        uint256 n,
        int256 f0,
        int256 g0
    ) public pure {
        FundingParams memory p = _params(2e15, cap, cap, 0.05e18, 0);
        FundingState memory s;
        s.rate = bound(prevRate, -int256(p.rateCap), int256(p.rateCap));
        s.emaPremium = bound(prevEma, -0.05e18, 0.05e18);
        s.cumFunding = bound(f0, -1e30, 1e30);
        s.cumIndexTime = bound(g0, 0, 1e40);
        index = bound(index, 1e9, 1e24);
        fair = bound(fair, 1e9, 1e24);
        n = bound(n, 1, 10_000_000);

        (FundingState memory ns,) = FundingLib.update(s, p, index, fair, n);
        int256 dG = ns.cumIndexTime - s.cumIndexTime;
        int256 dF = ns.cumFunding - s.cumFunding;
        assertEq(uint256(dG), index * n * 300 / 1000, "G = I*dt");
        assertLe(FPM.abs(dF), FPM.fullMulDiv(p.rateCap, uint256(dG), 1e18) + 1, "|dF| <= cap*dG");
        assertTrue(dF == 0 || (dF > 0) == (ns.rate > 0), "F moves with the sign of r");
    }

    /// MATH_SPEC §1.5: with Σq = 0, settling everyone over the same ΔF leaves 0 ≤ Σ owed ≤ N wei.
    function testFuzz_conservation(int256[8] memory qs, int256 dF, uint8 nAcc) public pure {
        uint256 n = bound(nAcc, 2, 8);
        dF = bound(dF, -1e24, 1e24);
        int256 sumQ;
        int256 sumOwed;
        for (uint256 i; i < n - 1; ++i) {
            int256 q = bound(qs[i], -1e30, 1e30);
            sumQ += q;
            sumOwed += FundingLib.owed(q, dF, 0);
        }
        sumOwed += FundingLib.owed(-sumQ, dF, 0);
        assertGe(sumOwed, 0, "protocol never pays out more than it collects");
        assertLe(sumOwed, int256(n), "dust <= #settlements");
    }
}
