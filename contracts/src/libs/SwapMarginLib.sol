// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";
import {MeridianConstants} from "../interfaces/MeridianTypes.sol";

/// @title SwapMarginLib — funding-swap margin (MATH_SPEC §6.4)
/// @notice Losses accrue at a bounded rate (|r| ≤ cap, δ per block), so maintenance covers `liqHorizon` of the
///         worst case on both legs, an implied-APR shock on the mark value, and a MON price shock on the
///         notional-time of the remaining stream. Every term rounds up (requirements round against the user).
library SwapMarginLib {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = MeridianConstants.SECONDS_PER_YEAR;
    /// @dev MON price shock applied to |q·markApr − K|·I·τ/YEAR (MATH_SPEC §6.4 constant; change via CR).
    uint256 internal constant PRICE_SHOCK = 0.3e18;

    /// @param q size (WAD, signed)  @param k fixed-APR notional K (WAD, signed)  @param markApr WAD
    /// @param index oracle index I (WAD)  @param capApr rate cap as APR = rateCap·YEAR (WAD)
    /// @param liqHorizonSec worst-case horizon  @param aprMoveBuffer implied-APR shock (WAD)  @param tau seconds left
    function maintenanceMargin(
        int256 q,
        int256 k,
        int256 markApr,
        uint256 index,
        uint256 capApr,
        uint256 liqHorizonSec,
        uint256 aprMoveBuffer,
        uint256 tau
    ) internal pure returns (uint256) {
        return _worstCase(q, k, index, capApr, liqHorizonSec) + _aprShock(q, index, aprMoveBuffer, tau)
            + _priceShock(q, k, markApr, index, tau);
    }

    /// @dev MATH_SPEC §6.4: worstRate = I·(|q|·cap_apr/1e18 + |K|)/1e18 per year, × liqHorizon/YEAR, rounds up.
    function _worstCase(int256 q, int256 k, uint256 index, uint256 capApr, uint256 horizon)
        private
        pure
        returns (uint256)
    {
        uint256 worstRate = FPM.mulWadUp(index, FPM.mulWadUp(FPM.abs(q), capApr) + FPM.abs(k));
        return FPM.mulDivUp(worstRate, horizon, YEAR);
    }

    /// @dev |q|·I·aprMoveBuffer·τ/YEAR, rounds up.
    function _aprShock(int256 q, uint256 index, uint256 buffer, uint256 tau) private pure returns (uint256) {
        return FPM.mulDivUp(FPM.mulWadUp(FPM.mulWadUp(FPM.abs(q), index), buffer), tau, YEAR);
    }

    /// @dev |q·markApr − K|·I·τ/YEAR·PRICE_SHOCK, rounds up: |q·markApr − K·1e18| is exact in int256 (≤ ~1e49),
    ///      then one ceiling division by 1e18.
    function _priceShock(int256 q, int256 k, int256 markApr, uint256 index, uint256 tau)
        private
        pure
        returns (uint256)
    {
        uint256 stream = FPM.divUp(FPM.abs(q * markApr - k * int256(WAD)), WAD);
        return FPM.mulWadUp(FPM.mulDivUp(FPM.mulWadUp(stream, index), tau, YEAR), PRICE_SHOCK);
    }

    /// @notice MON price-shock term alone, |q·markApr − K|·I·τ/YEAR·PRICE_SHOCK ↑ (MATH_SPEC §6.4). It is the whole
    ///         maintenance margin of a q = 0 locked-spread account whose stream is negative.
    function priceShockMargin(int256 q, int256 k, int256 markApr, uint256 index, uint256 tau)
        internal
        pure
        returns (uint256)
    {
        return _priceShock(q, k, markApr, index, tau);
    }

    /// @notice IM = MM·imMultiplier, rounds up.
    function initialMargin(uint256 mm, uint256 imMultiplier) internal pure returns (uint256) {
        return FPM.mulWadUp(mm, imMultiplier);
    }
}
