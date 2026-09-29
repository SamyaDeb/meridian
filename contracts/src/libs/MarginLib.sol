// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";

/// @title MarginLib — isolated-margin position accounting (MATH_SPEC §3.1–§3.2)
/// @notice Fills are expressed as (signed size Δq, unsigned notional |Δq|·P) so an aggregated taker fill
///         (Σ size, Σ notional from the book) is applied without re-deriving an average price.
///         Every rounding goes against the account.
library MarginLib {
    uint256 internal constant WAD = 1e18;

    /// @notice Apply a fill of `dq` (+buy / −sell) worth `notional` = |dq|·P to a position (size, openNotional).
    /// @return size new size
    /// @return on new open notional
    /// @return realized realized pnl of the closed part (0 for a pure increase), rounded down
    function applyFill(int256 size0, int256 on0, int256 dq, uint256 notional)
        internal
        pure
        returns (int256 size, int256 on, int256 realized)
    {
        if (dq == 0) return (size0, on0, 0);
        if (size0 == 0 || (size0 > 0) == (dq > 0)) {
            // MATH_SPEC §3.1 increase: ON += Δq·P, exact (the notional is passed in)
            return (size0 + dq, dq > 0 ? on0 + int256(notional) : on0 - int256(notional), 0);
        }
        uint256 absQ = FPM.abs(size0);
        uint256 absD = FPM.abs(dq);
        uint256 c = FPM.min(absD, absQ);
        // MATH_SPEC §3.1: released = ON·c/|q| rounded toward +∞ for both signs
        int256 released =
            on0 >= 0 ? int256(FPM.fullMulDivUp(uint256(on0), c, absQ)) : -int256(FPM.fullMulDiv(FPM.abs(on0), c, absQ));
        // Share of the fill's notional that closes: a long sells (receives, ↓), a short buys back (pays, ↑).
        uint256 closeN = c == absD
            ? notional
            : (size0 > 0 ? FPM.fullMulDiv(notional, c, absD) : FPM.fullMulDivUp(notional, c, absD));
        // MATH_SPEC §3.1: realized = sign(q)·c·P − released, rounds down
        realized = (size0 > 0 ? int256(closeN) : -int256(closeN)) - released;
        on = on0 - released;
        size = dq > 0 ? size0 + int256(c) : size0 - int256(c);
        if (absD > c) {
            // Remainder opens the opposite side at the fill price (MATH_SPEC §3.1), exact by construction.
            uint256 remN = notional - closeN;
            (size, on) =
            (size + (dq > 0 ? int256(absD - c) : -int256(absD - c)), dq > 0 ? on + int256(remN) : on - int256(remN));
        }
    }

    /// @notice |size|·price, rounds down (fills: both sides use the same value).
    function notionalOf(uint256 size, uint256 price) internal pure returns (uint256) {
        return FPM.mulWad(size, price);
    }

    /// @notice upnl = q·M − ON. MATH_SPEC §3.2, rounds down.
    function unrealizedPnl(int256 q, int256 on, uint256 mark) internal pure returns (int256) {
        uint256 v = FPM.abs(q);
        int256 qm = q >= 0 ? int256(FPM.mulWad(v, mark)) : -int256(FPM.mulWadUp(v, mark));
        return qm - on;
    }

    /// @notice IM = |q|·M·imr + reserved. MATH_SPEC §3.2, rounds up.
    function initialMargin(int256 q, uint256 mark, uint256 imr, uint256 reserved) internal pure returns (uint256) {
        return FPM.mulWadUp(FPM.mulWadUp(FPM.abs(q), mark), imr) + reserved;
    }

    /// @notice MM = |q|·M·mmr. MATH_SPEC §3.2, rounds up.
    function maintenanceMargin(int256 q, uint256 mark, uint256 mmr) internal pure returns (uint256) {
        return FPM.mulWadUp(FPM.mulWadUp(FPM.abs(q), mark), mmr);
    }

    /// @notice reserve(order) = size·price·imr. MATH_SPEC §3.2, rounds up.
    function orderMargin(uint256 size, uint256 price, uint256 imr) internal pure returns (uint256) {
        return FPM.mulWadUp(FPM.mulWadUp(size, price), imr);
    }

    /// @notice E = |ON|/|q| (display only), rounds down; 0 when flat.
    function entryPrice(int256 q, int256 on) internal pure returns (uint256) {
        if (q == 0) return 0;
        return FPM.fullMulDiv(FPM.abs(on), WAD, FPM.abs(q));
    }

    /// @notice Isolated liquidation price ignoring future funding (MATH_SPEC §3.2), for display.
    ///         long: (E − C/q)/(1 − mmr) = (ON − C)/(q·(1 − mmr)), rounds up (warns early);
    ///         short: (E + C/|q|)/(1 + mmr) = (|ON| + C)/(|q|·(1 + mmr)), rounds down (warns early).
    /// @param c effective collateral (collateral − pending funding), may be negative
    /// @return 0 when flat or not computable (long that can't be liquidated at any price > 0,
    ///         short already liquidatable at any price ≥ 0)
    function liquidationPrice(int256 q, int256 on, int256 c, uint256 mmr) internal pure returns (uint256) {
        if (q > 0) {
            if (on <= c) return 0;
            uint256 x = FPM.fullMulDivUp(uint256(on - c), WAD, uint256(q));
            return FPM.fullMulDivUp(x, WAD, WAD - mmr);
        }
        if (q < 0) {
            int256 num = c - on; // on < 0 for a short ⇒ C + |ON|
            if (num <= 0) return 0;
            uint256 x = FPM.fullMulDiv(uint256(num), WAD, FPM.abs(q));
            return FPM.fullMulDiv(x, WAD, WAD + mmr);
        }
        return 0;
    }
}
