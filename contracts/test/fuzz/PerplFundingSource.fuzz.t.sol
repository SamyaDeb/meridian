// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PerplFundingSource} from "../../src/oracle/PerplFundingSource.sol";
import {MockPerplExchange} from "../../src/mocks/MockPerplExchange.sol";

/// @dev MATH_SPEC §6.8: unit conversion (exact), rate (neutral), cap (up), G step (neutral = down for G ≥ 0), G
///      monotone, and the realized average inside the cap for any rate Perpl can actually charge.
contract PerplFundingSourceFuzz is Test {
    uint256 constant PERP = 64;
    uint256 constant IB = 8571;
    uint256 constant IS = 2580;

    function _deploy(uint256 pd, uint256 exp, uint256 pricePNS, int48 sum0)
        internal
        returns (MockPerplExchange x, PerplFundingSource src)
    {
        vm.warp(1_791_800_000);
        vm.roll(1_000_000);
        x = new MockPerplExchange(PERP, pd, exp);
        x.pushEvent(PERP, 999_000, sum0);
        x.setPrice(PERP, pricePNS, block.timestamp);
        src = new PerplFundingSource(address(x), PERP, IS);
    }

    /// Scale conversion over the whole int48 range and decimals 0–8: exact, and F/scale recovers the sum.
    function testFuzz_scaleConversionExact(uint256 pd, uint256 exp, int48 sum) public {
        pd = bound(pd, 0, 8);
        exp = bound(exp, 0, 8);
        (, PerplFundingSource src) = _deploy(pd, exp, 1, sum);
        (int256 f,,) = src.latestObservation();
        uint256 scale = 10 ** (18 - pd - exp);
        assertEq(src.sumScale(), scale);
        assertEq(src.priceScale(), 10 ** (18 - pd));
        assertEq(f, int256(sum) * int256(scale));
        assertEq(f / int256(scale), int256(sum));
        assertEq(f % int256(scale), 0);
    }

    /// Rate: per interval ×1e5 → per-second WAD truncates toward zero (neutral); cap rounds up.
    function testFuzz_rateNeutral_capUp(int16 ratePct, uint256 clampPct) public {
        clampPct = bound(clampPct, 0, 100_000);
        (MockPerplExchange x, PerplFundingSource src) = _deploy(5, 3, 2500, 0);
        x.pushEvent(PERP, 999_000 + IB, 1);
        x.setRate(PERP, ratePct, clampPct);
        vm.roll(999_000 + IB);
        src.poke();
        int256 r = src.fundingState().rate;
        int256 exact = int256(ratePct) * 1e13; // r·IS ≈ exact
        // |r·IS| ≤ |exact| < |r·IS| + IS, same sign (toward zero)
        assertLe(r * int256(IS) >= 0 ? r * int256(IS) : -r * int256(IS), exact >= 0 ? exact : -exact);
        assertLt((exact >= 0 ? exact : -exact) - (r * int256(IS) >= 0 ? r * int256(IS) : -r * int256(IS)), int256(IS));
        assertTrue(r == 0 || (r > 0) == (ratePct > 0));
        uint256 cap = src.fundingParams().rateCap;
        uint256 num = clampPct * 1e13 * 10_500;
        assertGe(cap * 10_000 * IS, num); // ↑
        if (cap > 0) assertLt((cap - 1) * 10_000 * IS, num);
    }

    /// G steps by ⌊I·Δfeb·IS/IB⌋ (rounds down, ≥ 0), never decreases, and F tracks the sum exactly.
    function testFuzz_gMonotone_fExact(uint256 seed, uint8 nEvents) public {
        nEvents = uint8(bound(nEvents, 1, 20));
        (MockPerplExchange x, PerplFundingSource src) = _deploy(5, 3, 2500, 0);
        uint256 feb = 999_000;
        int256 gPrev;
        for (uint256 i = 0; i < nEvents; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 n = 1 + seed % 5;
            int48 sum = int48(int256(seed >> 8) % 1_000_000);
            uint256 price = 1 + (seed >> 64) % 1e9;
            uint256 lastFeb = feb;
            feb += n * IB - (seed >> 128) % 3; // occasionally not a whole interval
            x.pushEvent(PERP, feb, sum);
            vm.roll(feb + (seed >> 160) % 50);
            x.setPrice(PERP, price, block.timestamp);
            assertTrue(src.poke());
            (int256 f, int256 g, uint64 b) = src.latestObservation();
            uint256 dG = uint256(g - gPrev);
            uint256 exact = price * 1e13 * (feb - lastFeb) * IS;
            assertLe(dG * IB, exact); // ↓
            assertGt((dG + 1) * IB, exact);
            assertGe(g, gPrev);
            assertEq(f, int256(sum) * 1e10);
            assertEq(b, feb);
            gPrev = g;
        }
    }

    /// For any rate within Perpl's clamp, paid at the oracle price, the realized average is unclamped and |avg| ≤ cap.
    function testFuzz_averageWithinCap(uint256 seed, uint8 nEvents, uint256 clampPct) public {
        nEvents = uint8(bound(nEvents, 1, 30));
        clampPct = bound(clampPct, 1, 1000);
        uint256 price = 100 + seed % 1e7;
        (MockPerplExchange x, PerplFundingSource src) = _deploy(5, 3, price, 0);
        x.setRate(PERP, 0, clampPct);
        int48 sum;
        uint256 feb = 999_000;
        for (uint256 i = 0; i < nEvents; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            int256 rate = int256(seed % (2 * clampPct + 1)) - int256(clampPct);
            // Perpl: ppl = trunc0(rate · price · 10^exp / 1e5) (docs/PERPL_SWAPS.md §Units)
            sum += int48(rate * int256(price) * 1000 / 1e5);
            feb += IB;
            x.pushEvent(PERP, feb, sum);
            vm.roll(feb);
            x.setPrice(PERP, price, block.timestamp);
            src.poke();
        }
        uint64 ago = uint64(block.number - 999_000);
        int256 avg = src.averageFundingRate(ago);
        int256 cap = int256(src.fundingParams().rateCap);
        assertLe(avg, cap);
        assertGe(avg, -cap);
        (int256 f,,) = src.latestObservation();
        (, int256 g,) = src.latestObservation();
        if (g != 0) {
            int256 raw = f * 1e18 / g; // F₀ = G₀ = 0
            assertEq(avg, raw); // the clamp did not bind
        }
    }
}
