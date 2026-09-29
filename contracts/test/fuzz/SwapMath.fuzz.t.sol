// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SwapMathLib} from "../../src/libs/SwapMathLib.sol";

/// @notice MATH_SPEC §6.2 conservation (I9 at the library level): after any sequence of fills, liquidation
///         transfers and index moves, with every position change preceded by settling both parties,
///         Σq == 0 and ΣK == 0 exactly, and Σ net over all settlements ∈ [−#settlements, 0] wei.
contract SwapMathFuzzTest is Test {
    uint256 constant N = 4;
    uint256 constant STEPS = 40;

    int256[N] q;
    int256[N] k;
    int256[N] f0;
    int256[N] g0;
    int256 F;
    int256 G;
    int256 sumNet;
    uint256 settlements;

    function _settle(uint256 a) internal {
        sumNet += SwapMathLib.net(q[a], k[a], F - f0[a], G - g0[a]);
        (f0[a], g0[a]) = (F, G);
        ++settlements;
    }

    function _sums() internal view returns (int256 sq, int256 sk) {
        for (uint256 i; i < N; ++i) {
            sq += q[i];
            sk += k[i];
        }
    }

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_conservation(uint256 seed) public {
        for (uint256 s; s < STEPS; ++s) {
            uint256 r = uint256(keccak256(abi.encode(seed, s)));
            uint256 kind = r % 3;
            if (kind == 0) {
                // index move: F may go either way (funding sign), G only grows (index·time)
                F += int256(bound(r >> 8, 0, 2e14)) - 1e14;
                G += int256(bound(r >> 72, 0, 1e22));
            } else if (kind == 1) {
                // fill: buyer b, seller s at APR A (can be negative, > −100%)
                uint256 b = (r >> 8) % N;
                uint256 sl = (b + 1 + (r >> 16) % (N - 1)) % N;
                int256 dq = int256(bound(r >> 24, 1, 1e24));
                int256 apr = int256(bound(r >> 104, 0, 5.5e18)) - 0.5e18;
                _settle(b);
                _settle(sl);
                int256 kd = SwapMathLib.kDelta(dq, apr); // computed ONCE
                (q[b], k[b]) = SwapMathLib.applyFill(q[b], k[b], dq, kd);
                (q[sl], k[sl]) = SwapMathLib.applyFill(q[sl], k[sl], -dq, -kd);
            } else {
                // liquidation transfer of x of a's position (and K·x/|q|) to l
                uint256 a = (r >> 8) % N;
                if (q[a] == 0) continue;
                uint256 l = (a + 1 + (r >> 16) % (N - 1)) % N;
                int256 absQ = q[a] < 0 ? -q[a] : q[a];
                int256 x = int256(bound(r >> 24, 1, uint256(absQ)));
                _settle(a);
                _settle(l);
                int256 kx = SwapMathLib.liquidationShare(q[a], k[a], x);
                int256 moved = q[a] > 0 ? x : -x;
                (q[a], k[a]) = (q[a] - moved, k[a] - kx);
                (q[l], k[l]) = (q[l] + moved, k[l] + kx);
            }
            (int256 sq, int256 sk) = _sums();
            assertEq(sq, 0, "sum q");
            assertEq(sk, 0, "sum K");
        }
        for (uint256 i; i < N; ++i) {
            _settle(i);
        }
        assertLe(sumNet, 0, "sum net <= 0 (every settlement rounds against the account)");
        assertGe(sumNet, -int256(settlements), "sum net >= -#settlements");
    }

    /// Net for one account is the exact rate difference, rounded down by less than 1 wei.
    function testFuzz_netWithinOneWeiOfExact(int128 q_, int128 k_, int96 dF, uint96 dG) public pure {
        int256 n = SwapMathLib.net(q_, k_, dF, int256(uint256(dG)));
        int256 num = int256(q_) * dF * 365 days - int256(k_) * int256(uint256(dG));
        int256 den = 1e18 * 365 days;
        assertLe(n * den, num, "floor: n <= exact");
        assertGt((n + 1) * den, num, "floor: exact < n + 1");
    }
}
