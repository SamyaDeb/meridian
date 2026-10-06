// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";
import {FundingParams, FundingState} from "../interfaces/MeridianTypes.sol";

/// @title FundingLib — per-block funding: EMA premium, clamped rate, cumulative indices F and G
/// @notice Pure math for MATH_SPEC §1.2–§1.4. The ClearingHouse calls `update` on the first touch per block
///         (with n = blocks since the last update) and stores the result; accounts settle lazily with `owed`.
///         No loops except `decayFactor`'s pow-by-squaring (≤ 64 iterations, n is a uint64 block count).
library FundingLib {
    int256 internal constant IWAD = 1e18;
    uint256 internal constant WAD = 1e18;
    /// @dev T: convergence period (s). "If the premium persists at x, longs pay x per T." MATH_SPEC §1.3 (CR to change).
    int256 internal constant CONVERGENCE_PERIOD = 3600;

    /// @notice Advance the funding state over `n ≥ 1` elapsed blocks. Does not touch `lastUpdateBlock`.
    /// @param index oracle index price I_b (WAD, > 0)
    /// @param fair  fair book price S_b (WAD, > 0; = index when the book is unusable, MATH_SPEC §2.2)
    /// @return ns updated state
    /// @return prem the clamped premium sample (for the FundingUpdated event)
    function update(FundingState memory s, FundingParams memory p, uint256 index, uint256 fair, uint256 n)
        internal
        pure
        returns (FundingState memory ns, int256 prem)
    {
        prem = premium(fair, index, p.premiumBandWad);
        ns.lastUpdateBlock = s.lastUpdateBlock;
        ns.emaPremium = _ema(s.emaPremium, prem, p.alpha, n);
        ns.rate = _rate(ns.emaPremium, s.rate, p, n);
        (ns.cumFunding, ns.cumIndexTime) = accrue(s.cumFunding, s.cumIndexTime, ns.rate, index, n * p.blockTimeMs);
    }

    function _ema(int256 prev, int256 prem, uint256 alpha, uint256 n) private pure returns (int256) {
        // MATH_SPEC §1.2: αeff = 1 − (1 − α)^n; (1−α)^n rounds up ⇒ αeff rounds down
        int256 alphaEff = int256(WAD - decayFactor(alpha, n));
        // MATH_SPEC §1.2: p̄ = αeff·premium + (1 − αeff)·p̄_prev = p̄_prev + αeff·(premium − p̄_prev), rounds neutral
        return prev + FPM.sMulWad(prem - prev, alphaEff);
    }

    function _rate(int256 ema, int256 prevRate, FundingParams memory p, uint256 n) private pure returns (int256 rate) {
        // MATH_SPEC §1.2: r* = p̄/T + i, rounds neutral (truncates toward 0)
        rate = ema / CONVERGENCE_PERIOD + p.interestRate;
        // MATH_SPEC §1.2: δ-clamp first (scaled by elapsed blocks), then the absolute cap LAST so |r| ≤ cap always
        int256 step = int256(p.maxRateChangePerBlock * n);
        rate = FPM.clamp(rate, prevRate - step, prevRate + step);
        rate = FPM.clamp(rate, -int256(p.rateCap), int256(p.rateCap));
    }

    /// @notice F += r·I·Δt and G += I·Δt with Δt = dtMs/1000 s. One division per index, both truncating.
    function accrue(int256 f, int256 g, int256 rate, uint256 index, uint256 dtMs)
        internal
        pure
        returns (int256, int256)
    {
        uint256 indexTimeMs = index * dtMs;
        // MATH_SPEC §1.2: F += sign(r)·⌊|r|·I·dtMs / (1e18·1000)⌋, rounds neutral (toward 0; both sides read F)
        int256 df = int256(FPM.fullMulDiv(FPM.abs(rate), indexTimeMs, WAD * 1000));
        // MATH_SPEC §1.2: G += ⌊I·dtMs / 1000⌋, rounds neutral
        int256 dg = int256(indexTimeMs / 1000);
        return (rate < 0 ? f - df : f + df, g + dg);
    }

    /// @notice Premium sample (S − I)/I clamped to ±band. MATH_SPEC §1.2, rounds neutral (truncates toward 0).
    function premium(uint256 fair, uint256 index, uint256 band) internal pure returns (int256) {
        int256 raw = (int256(fair) - int256(index)) * IWAD / int256(index);
        return FPM.clamp(raw, -int256(band), int256(band));
    }

    /// @notice (1 − α)^n in WAD, rounded UP at every step (pow by squaring, ≤ 64 iterations for n < 2^64).
    /// @dev MATH_SPEC §1.2, rounds up (so αeff = 1 − this rounds down).
    function decayFactor(uint256 alpha, uint256 n) internal pure returns (uint256 result) {
        uint256 base = WAD - alpha;
        result = WAD;
        while (n != 0) {
            if (n & 1 == 1) result = FPM.mulWadUp(result, base);
            n >>= 1;
            if (n != 0) base = FPM.mulWadUp(base, base);
        }
    }

    /// @notice Funding owed by a position of size q since its entry index: ⌈q·(F_now − F_entry)/1e18⌉.
    /// @dev MATH_SPEC §1.4, rounds up for both signs: payers pay more, receivers receive less.
    /// @return amount quote WAD; > 0 the account pays, < 0 it receives
    function owed(int256 q, int256 fNow, int256 fEntry) internal pure returns (int256 amount) {
        int256 dF = fNow - fEntry;
        if (q == 0 || dF == 0) return 0;
        uint256 m = FPM.abs(q);
        uint256 d = FPM.abs(dF);
        if ((q > 0) == (dF > 0)) {
            amount = int256(FPM.fullMulDivUp(m, d, WAD)); // ceil of a positive value
        } else {
            amount = -int256(FPM.fullMulDiv(m, d, WAD)); // ceil(−x) = −floor(x)
        }
    }
}
