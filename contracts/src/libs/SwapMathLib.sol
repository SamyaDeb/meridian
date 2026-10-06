// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MeridianConstants} from "../interfaces/MeridianTypes.sol";

/// @title SwapMathLib — funding-swap accrual and fill accounting (MATH_SPEC §6.2–§6.3, Phase 2 amendments)
/// @notice Per account: q (size, + = receive floating), K (fixed-APR notional, += Δq·A on every fill, never
///         reduced proportionally), F₀/G₀ (perp indices at the last settlement). Σq = 0 and ΣK = 0 hold exactly
///         because every fill applies +Δq/+kDelta to the buyer and −Δq/−kDelta to the seller, with kDelta computed
///         ONCE per fill. Magnitudes stay far below 2^255 for any realistic market (q ≤ 1e30, |ΔF| ≤ 1e24,
///         ΔG ≤ 1e32, YEAR ≈ 3.2e7), so plain checked int256 arithmetic is used.
library SwapMathLib {
    int256 internal constant WAD = 1e18;
    int256 internal constant YEAR = int256(MeridianConstants.SECONDS_PER_YEAR);

    /// @notice Accrued net since the last settlement, credited to the account (+ = receives).
    /// @dev MATH_SPEC §6.2 (amended): net = ⌊(q·ΔF·YEAR − K·ΔG) / (1e18·YEAR)⌋ in ONE division, rounds down
    ///      (against the account for either sign), so Σ net over any history ∈ [−#settlements, 0] wei.
    function net(int256 q, int256 k, int256 dF, int256 dG) internal pure returns (int256) {
        return divFloor(q * dF * YEAR - k * dG, WAD * YEAR);
    }

    /// @notice K increment of a fill: Δq·A/1e18, truncating toward 0. Compute ONCE per fill and apply +kDelta to
    ///         the buyer and −kDelta to the seller (MATH_SPEC §6.2 amendment: ΣK = 0 exactly).
    /// @param dq signed size of the fill for the buyer (WAD)
    /// @param apr fill APR = book price − 1e18 (WAD, may be negative)
    function kDelta(int256 dq, int256 apr) internal pure returns (int256) {
        // MATH_SPEC §6.2, rounds neutral (0): both sides use the same value with opposite signs
        return dq * apr / WAD;
    }

    /// @notice Apply a fill to (q, K): settle first (caller), then q += dq, K += kd. No proportional reduction.
    function applyFill(int256 q, int256 k, int256 dq, int256 kd) internal pure returns (int256, int256) {
        return (q + dq, k + kd);
    }

    /// @notice K share that moves with x of |q| in a liquidation: K·x/|q| with the sign of K, truncating toward 0.
    ///         The liquidatee gives −share and the liquidator receives +share, so ΣK is preserved.
    function liquidationShare(int256 q, int256 k, int256 x) internal pure returns (int256) {
        if (q == 0) return 0;
        int256 absQ = q < 0 ? -q : q;
        return k * x / absQ; // rounds neutral (0): equal and opposite on both sides
    }

    /// @notice Value of the remaining stream at the mark: V = (q·markApr/1e18 − K)·I·τ/(1e18·YEAR).
    /// @dev MATH_SPEC §6.3, rounds down (q·markApr floored, then one floor division). Valid for q = 0 (locked
    ///      spread: V = −K·I·τ/YEAR).
    function value(int256 q, int256 k, int256 markApr, uint256 index, uint256 tau) internal pure returns (int256) {
        int256 stream = divFloor(q * markApr, WAD) - k;
        return divFloor(stream * int256(index) * int256(tau), WAD * YEAR);
    }

    /// @notice Signed division rounding toward −∞ (d > 0).
    function divFloor(int256 n, int256 d) internal pure returns (int256 q) {
        q = n / d;
        if (n % d != 0 && n < 0) --q;
    }
}
