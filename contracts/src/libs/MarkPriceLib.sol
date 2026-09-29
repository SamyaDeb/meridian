// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";

/// @title MarkPriceLib — median-of-three mark and the fair book price used as the premium source
/// @notice MATH_SPEC §2. Book inputs are prices in WAD with 0 meaning "side empty" (the ClearingHouse maps
///         `bestBid() == 0` / `bestAsk() == type(uint32).max` to 0). A crossed or locked book counts as unusable.
library MarkPriceLib {
    uint256 internal constant WAD = 1e18;
    /// @dev markBand: M is clamped to I·(1 ± 5%). MATH_SPEC §2.1 (no RiskParams field; tunable via CR).
    uint256 internal constant MARK_BAND = 0.05e18;
    /// @dev lastTradeMaxAge: a trade older than 100 blocks (30 s) is ignored. MATH_SPEC §2.1.
    uint256 internal constant LAST_TRADE_MAX_AGE = 100;
    /// @dev The book mid is a premium sample only if spread/mid ≤ 2% = 1/50. MATH_SPEC §2.2.
    uint256 internal constant MAX_SPREAD_DIVISOR = 50;

    /// @notice (bid + ask)/2 if both sides are present and bid < ask.
    function bookMid(uint256 bid, uint256 ask) internal pure returns (uint256 mid, bool valid) {
        if (bid == 0 || ask == 0 || bid >= ask) return (0, false);
        // MATH_SPEC §2.1, rounds down (same as IOrderBook.midPrice)
        return ((bid + ask) / 2, true);
    }

    /// @notice S = mid if the book is two-sided with spread/mid ≤ 2%, else the index (premium sample 0).
    /// @dev MATH_SPEC §2.2, exact integer comparison spread·50 ≤ mid (no rounding).
    function fairBookPrice(uint256 index, uint256 bid, uint256 ask) internal pure returns (uint256) {
        (uint256 mid, bool valid) = bookMid(bid, ask);
        if (valid && (ask - bid) * MAX_SPREAD_DIVISOR <= mid) return mid;
        return index;
    }

    /// @notice M = clamp(median(A, B, C), I·(1 − band), I·(1 + band)), with A = I·(1 + p̄) and the
    ///         fallbacks B = A (no two-sided book) and C = A (no trade in the last 100 blocks).
    /// @param emaPremium p̄ (WAD, |p̄| ≤ premiumBand ≤ 0.5)
    function markPrice(
        uint256 index,
        int256 emaPremium,
        uint256 bid,
        uint256 ask,
        uint256 lastTradePrice,
        uint256 lastTradeBlock,
        uint256 blockNumber
    ) internal pure returns (uint256) {
        // MATH_SPEC §2.1: A = I·(1 + p̄), rounds neutral (toward 0)
        uint256 a = uint256(int256(index) + FPM.sMulWad(int256(index), emaPremium));
        uint256 m = median3(a, _midOr(a, bid, ask), _tradeOr(a, lastTradePrice, lastTradeBlock, blockNumber));
        // MATH_SPEC §2.1: band edges I·(1 ± band), round neutral (down)
        uint256 edge = FPM.mulWad(index, MARK_BAND);
        return FPM.clamp(m, index - edge, index + edge);
    }

    /// @dev B = bookMid if both sides are present, else A.
    function _midOr(uint256 a, uint256 bid, uint256 ask) private pure returns (uint256) {
        (uint256 mid, bool ok) = bookMid(bid, ask);
        return ok ? mid : a;
    }

    /// @dev C = last trade price if at most LAST_TRADE_MAX_AGE blocks old, else A.
    function _tradeOr(uint256 a, uint256 px, uint256 tradeBlock, uint256 blockNumber) private pure returns (uint256) {
        bool fresh = px != 0 && tradeBlock <= blockNumber && blockNumber - tradeBlock <= LAST_TRADE_MAX_AGE;
        return fresh ? px : a;
    }

    /// @notice Median of three: max(min(a, b), min(max(a, b), c)).
    function median3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        return FPM.max(FPM.min(a, b), FPM.min(FPM.max(a, b), c));
    }
}
