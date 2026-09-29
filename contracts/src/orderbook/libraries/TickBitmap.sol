// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LibBit} from "solady/utils/LibBit.sol";

/// @title TickBitmap — 3-level bitmap over 2^24 ticks with O(1) "next set tick" search
/// @notice leaf[tick >> 8] has one bit per tick; mid[tick >> 16] has one bit per non-empty leaf word;
///         root has one bit per non-empty mid word. Any search reads at most 5 words, and no loop is needed.
/// @dev Why 3 levels (WS-01 asked for 2): one summary word over leaf words covers only 65,536 ticks, i.e. a max
///      price of 0.0655 AUSD at the perp tick (1e-6), 2.26x today's MON. 2^24 ticks cover up to 16.7 AUSD
///      (perp) and an APR up to 167,000% (swap book, tick 1e-4). All three arrays are static, so the whole
///      bitmap is contiguous in storage and the MM's neighbouring ticks share a MIP-8 page.
library TickBitmap {
    uint256 internal constant MAX_TICK = (1 << 24) - 1;

    struct Bitmap {
        uint256 root;
        uint256[256] mid;
        uint256[65_536] leaf;
    }

    function isSet(Bitmap storage b, uint256 tick) internal view returns (bool) {
        return (b.leaf[tick >> 8] >> (tick & 0xff)) & 1 == 1;
    }

    function set(Bitmap storage b, uint256 tick) internal {
        uint256 li = tick >> 8;
        uint256 w = b.leaf[li];
        uint256 nw = w | (1 << (tick & 0xff));
        if (nw == w) return;
        b.leaf[li] = nw;
        if (w != 0) return;
        uint256 mi = li >> 8;
        uint256 m = b.mid[mi];
        b.mid[mi] = m | (1 << (li & 0xff));
        if (m == 0) b.root |= 1 << mi;
    }

    function clear(Bitmap storage b, uint256 tick) internal {
        uint256 li = tick >> 8;
        uint256 w = b.leaf[li];
        uint256 nw = w & ~(1 << (tick & 0xff));
        if (nw == w) return;
        b.leaf[li] = nw;
        if (nw != 0) return;
        uint256 mi = li >> 8;
        uint256 m = b.mid[mi] & ~(1 << (li & 0xff));
        b.mid[mi] = m;
        if (m == 0) b.root &= ~(1 << mi);
    }

    /// @notice Highest set tick ≤ `tick`.
    function nextAtOrBelow(Bitmap storage b, uint256 tick) internal view returns (uint256, bool) {
        uint256 li = tick >> 8;
        uint256 w = b.leaf[li] & _maskAtOrBelow(tick & 0xff);
        if (w != 0) return ((li << 8) | LibBit.fls(w), true);
        uint256 mi = li >> 8;
        uint256 m = b.mid[mi] & _maskBelow(li & 0xff);
        if (m == 0) {
            uint256 r = b.root & _maskBelow(mi);
            if (r == 0) return (0, false);
            mi = LibBit.fls(r);
            m = b.mid[mi];
        }
        li = (mi << 8) | LibBit.fls(m);
        return ((li << 8) | LibBit.fls(b.leaf[li]), true);
    }

    /// @notice Lowest set tick ≥ `tick`.
    function nextAtOrAbove(Bitmap storage b, uint256 tick) internal view returns (uint256, bool) {
        uint256 li = tick >> 8;
        uint256 w = b.leaf[li] & ~_maskBelow(tick & 0xff);
        if (w != 0) return ((li << 8) | LibBit.ffs(w), true);
        uint256 mi = li >> 8;
        uint256 m = b.mid[mi] & ~_maskAtOrBelow(li & 0xff);
        if (m == 0) {
            uint256 r = b.root & ~_maskAtOrBelow(mi);
            if (r == 0) return (0, false);
            mi = LibBit.ffs(r);
            m = b.mid[mi];
        }
        li = (mi << 8) | LibBit.ffs(m);
        return ((li << 8) | LibBit.ffs(b.leaf[li]), true);
    }

    /// @dev bits [0, i]
    function _maskAtOrBelow(uint256 i) private pure returns (uint256) {
        return i == 255 ? type(uint256).max : (1 << (i + 1)) - 1;
    }

    /// @dev bits [0, i)
    function _maskBelow(uint256 i) private pure returns (uint256) {
        return (1 << i) - 1;
    }
}
