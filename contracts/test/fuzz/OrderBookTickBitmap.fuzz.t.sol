// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TickBitmap} from "../../src/orderbook/libraries/TickBitmap.sol";

/// @dev Storage-backed harness: the real bitmap next to a naive reference (bool map + list of set ticks).
contract TickBitmapHarness {
    using TickBitmap for TickBitmap.Bitmap;

    TickBitmap.Bitmap internal bm;
    mapping(uint256 => bool) public refSet;
    uint256[] internal refTicks;

    function set(uint256 t) external {
        bm.set(t);
        if (!refSet[t]) {
            refSet[t] = true;
            refTicks.push(t);
        }
    }

    function clear(uint256 t) external {
        bm.clear(t);
        if (refSet[t]) {
            refSet[t] = false;
            for (uint256 i; i < refTicks.length; ++i) {
                if (refTicks[i] == t) {
                    refTicks[i] = refTicks[refTicks.length - 1];
                    refTicks.pop();
                    break;
                }
            }
        }
    }

    function isSet(uint256 t) external view returns (bool) {
        return bm.isSet(t);
    }

    function below(uint256 t) external view returns (uint256, bool) {
        return bm.nextAtOrBelow(t);
    }

    function above(uint256 t) external view returns (uint256, bool) {
        return bm.nextAtOrAbove(t);
    }

    function refBelow(uint256 t) external view returns (uint256 best, bool found) {
        for (uint256 i; i < refTicks.length; ++i) {
            uint256 x = refTicks[i];
            if (x <= t && (!found || x > best)) (best, found) = (x, true);
        }
    }

    function refAbove(uint256 t) external view returns (uint256 best, bool found) {
        for (uint256 i; i < refTicks.length; ++i) {
            uint256 x = refTicks[i];
            if (x >= t && (!found || x < best)) (best, found) = (x, true);
        }
    }
}

contract TickBitmapFuzzTest is Test {
    uint256 constant MAX = TickBitmap.MAX_TICK;
    TickBitmapHarness h;

    function setUp() public {
        h = new TickBitmapHarness();
    }

    /// Random set/clear sequences clustered around a random base (so words, mid words and the root all
    /// flip), compared against the naive reference at random query points.
    function testFuzz_matchesReference(uint256 seed, uint256 base, uint8 nOps) public {
        base = bound(base, 0, MAX);
        uint256 ops = bound(nOps, 1, 60);
        for (uint256 i; i < ops; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 t = _pick(r, base);
            if (r % 3 == 0) h.clear(t);
            else h.set(t);
            _check(_pick(r >> 128, base));
            _check(t);
        }
        _check(0);
        _check(MAX);
    }

    /// Spread: scale 0 = same leaf word, 1 = neighbouring words, 2 = neighbouring mid words, 3 = anywhere.
    function _pick(uint256 r, uint256 base) internal pure returns (uint256 t) {
        uint256 scale = r % 4;
        uint256 span = scale == 0 ? 256 : scale == 1 ? 4096 : scale == 2 ? 1 << 18 : MAX + 1;
        uint256 off = (r >> 8) % span;
        if (scale == 3) return off;
        t = (r >> 200) & 1 == 0 ? base + off : (base >= off ? base - off : 0);
        if (t > MAX) t = MAX;
    }

    function _check(uint256 q) internal view {
        assertEq(h.isSet(q), h.refSet(q), "isSet");
        (uint256 b, bool fb) = h.below(q);
        (uint256 rb, bool rfb) = h.refBelow(q);
        assertEq(fb, rfb, "below found");
        if (fb) assertEq(b, rb, "below tick");
        (uint256 a, bool fa) = h.above(q);
        (uint256 ra, bool rfa) = h.refAbove(q);
        assertEq(fa, rfa, "above found");
        if (fa) assertEq(a, ra, "above tick");
    }
}
