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
    /// @dev The mark's premium over the index (its basis) moves at most 10 bps per elapsed block. MATH_SPEC §2.1.
    uint256 internal constant MARK_MAX_PREMIUM_STEP = 0.001e18;
    /// @dev At most 20 elapsed blocks count toward the premium step (one touch after a long gap moves ≤ 2%). §2.1.
    uint256 internal constant MARK_MAX_ELAPSED_BLOCKS = 20;

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

    /// @notice Rate-limit the mark's basis: p = M/I − 1 moves at most min(elapsed, 20)·10 bps from the previous mark's
    ///         basis, stays inside ±band, and M = I·(1 + p). The index itself passes through at once. MATH_SPEC §2.1.
    /// @dev Preconditions (the ClearingHouse guarantees them: prices are stored as uint96): every price < 2^96 and
    ///      index ≠ 0. Returns `liveMark` unchanged when it is inside the step (no rounding drift) or when there is no
    ///      previous good mark (`prevIndex == 0`, constructor with a stale oracle).
    /// @param liveMark `markPrice(...)` for this block (already inside I·(1 ± band))
    /// @param index this block's index
    /// @param prevMark last good mark
    /// @param prevIndex the index `prevMark` was computed on (0 = none yet: no bound)
    /// @param elapsed blocks since the previous touch (stale touches included)
    function boundPremium(uint256 liveMark, uint256 index, uint256 prevMark, uint256 prevIndex, uint256 elapsed)
        internal
        pure
        returns (uint256 m)
    {
        // Assembly (hot path, every first touch; the Solidity form costs ≈ 200 gas more and pushes the CH-own first
        // touch past its 30k ceiling when the clamp binds). No overflow: prices < 2^96 ⇒ |M − I|·1e18 < 2^156,
        // |p| ≤ 2^157, step ≤ 2e16, |I·p| < 2^96·0.05e18 after the band clamp; `sdiv` truncates toward 0.
        /// @solidity memory-safe-assembly
        assembly {
            m := liveMark
            if prevIndex {
                // MATH_SPEC §2.1: p = (M − I)·1e18 / I, rounds neutral (toward 0)
                let pPrev := sdiv(mul(sub(prevMark, prevIndex), WAD), prevIndex)
                let d := sub(sdiv(mul(sub(liveMark, index), WAD), index), pPrev)
                // MATH_SPEC §2.1: step = min(elapsed, 20)·10 bps, exact
                let k := elapsed
                if gt(k, MARK_MAX_ELAPSED_BLOCKS) { k := MARK_MAX_ELAPSED_BLOCKS }
                let step := mul(k, MARK_MAX_PREMIUM_STEP)
                // |p_live − p_prev| > step ⇒ p = p_prev ± step, then ±band (defensive: |p_prev| ≤ band whenever
                // prevMark came from this library)
                if or(sgt(d, step), slt(d, sub(0, step))) {
                    let p := add(pPrev, step)
                    if slt(d, 0) { p := sub(pPrev, step) }
                    if sgt(p, MARK_BAND) { p := MARK_BAND }
                    if slt(p, sub(0, MARK_BAND)) { p := sub(0, MARK_BAND) }
                    // MATH_SPEC §2.1: M = I + I·p, rounds neutral (toward 0); |p| ≤ band ⇒ M ∈ I·(1 ± band) as markPrice
                    m := add(index, sdiv(mul(index, p), WAD))
                }
            }
        }
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
