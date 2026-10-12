// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {PerplFundingSource} from "../../src/oracle/PerplFundingSource.sol";
import {MockPerplExchange} from "../../src/mocks/MockPerplExchange.sol";
import {IPerplFundingSource} from "../../src/interfaces/IPerplFundingSource.sol";
import {IFundingRateOracle} from "../../src/interfaces/IFundingRateOracle.sol";
import {FundingParams, FundingState} from "../../src/interfaces/MeridianTypes.sol";

/// @dev Fixture mirrors testnet MON (perp 64): priceDecimals 5, fundingSumScalingExp 3 ⇒ F = sum·1e10, price 2,500 PNS
///      = 0.025 AUSD, interval 8,571 blocks / 2,580 s, clamp 10 per 100k per interval (docs/PERPL_SWAPS.md §Units).
abstract contract PerplFundingSourceBase is Test {
    uint256 constant PERP = 64;
    uint256 constant IB = 8571;
    uint256 constant IS = 2580;
    uint256 constant P = 2500; // PNS
    uint256 constant I = 2500 * 1e13; // WAD
    uint256 constant FEB0 = 1000;
    int48 constant SUM0 = -21_000;
    uint256 constant T0 = 1_791_800_000;

    MockPerplExchange x;
    PerplFundingSource src;

    function setUp() public virtual {
        vm.warp(T0);
        vm.roll(FEB0 + 100);
        x = new MockPerplExchange(PERP, 5, 3);
        x.pushEvent(PERP, FEB0, SUM0);
        x.setPrice(PERP, P, T0);
        x.setRate(PERP, -1, 10);
        src = new PerplFundingSource(address(x), PERP, IS);
    }

    /// @dev Push the next funding event (feb = last + n·IB), move the chain to it and refresh the price.
    function _event(uint256 n, int48 sum) internal returns (uint256 feb) {
        (, uint256 last) = x.getFundingSumAtBlock(PERP, type(uint256).max);
        feb = last + n * IB;
        x.pushEvent(PERP, feb, sum);
        vm.roll(feb + 5);
        vm.warp(block.timestamp + n * IS);
        x.setPrice(PERP, P, block.timestamp);
    }

    function _latest() internal view returns (int256 f, int256 g, uint64 b) {
        return src.latestObservation();
    }
}

contract PerplFundingSourceTest is PerplFundingSourceBase {
    // ─── constructor ────────────────────────────────────────────────────────────
    function test_constructor_writesFirstObservation() public view {
        (int256 f, int256 g, uint64 b) = _latest();
        assertEq(f, int256(SUM0) * 1e10);
        assertEq(g, 0);
        assertEq(b, FEB0);
        assertEq(src.exchange(), address(x));
        assertEq(src.perpId(), PERP);
        assertEq(src.fundingIntervalBlocks(), IB);
        assertEq(src.fundingIntervalSec(), IS);
        assertEq(src.sumScale(), 1e10);
        assertEq(src.priceScale(), 1e13);
        assertEq(src.indexPrice(), I);
        assertEq(src.lastPokeBlock(), FEB0 + 100);
        assertEq(src.checkpointIndex(), 0);
    }

    function test_constructor_emitsPoked() public {
        vm.recordLogs();
        PerplFundingSource s = new PerplFundingSource(address(x), PERP, IS);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(s));
        assertEq(logs[0].topics[0], IPerplFundingSource.Poked.selector);
        (int256 f, uint256 g, uint64 feb, uint256 price, int256 rate) =
            abi.decode(logs[0].data, (int256, uint256, uint64, uint256, int256));
        assertEq(f, int256(SUM0) * 1e10);
        assertEq(g, 0);
        assertEq(feb, FEB0);
        assertEq(price, I);
        assertEq(rate, -1e13 / int256(IS));
    }

    function test_constructor_revertsZeroExchange() public {
        vm.expectRevert(IPerplFundingSource.InvalidParams.selector);
        new PerplFundingSource(address(0), PERP, IS);
    }

    function test_constructor_revertsZeroIntervalSec() public {
        vm.expectRevert(IPerplFundingSource.InvalidParams.selector);
        new PerplFundingSource(address(x), PERP, 0);
    }

    function test_constructor_revertsZeroIntervalBlocks() public {
        x.setFundingInterval(0);
        vm.expectRevert(IPerplFundingSource.InvalidParams.selector);
        new PerplFundingSource(address(x), PERP, IS);
    }

    function test_constructor_revertsScaleAbove18() public {
        x.setScale(PERP, 16, 3);
        vm.expectRevert(IPerplFundingSource.InvalidParams.selector);
        new PerplFundingSource(address(x), PERP, IS);
    }

    function test_constructor_revertsNoFundingYet() public {
        MockPerplExchange y = new MockPerplExchange(PERP, 5, 3);
        y.setPrice(PERP, P, block.timestamp);
        vm.expectRevert(IPerplFundingSource.InvalidParams.selector);
        new PerplFundingSource(address(y), PERP, IS);
    }

    function test_constructor_revertsStalePrice() public {
        x.setPrice(PERP, P, block.timestamp - 121);
        vm.expectRevert(abi.encodeWithSelector(IPerplFundingSource.StalePerplPrice.selector, block.timestamp - 121));
        new PerplFundingSource(address(x), PERP, IS);
    }

    // ─── poke ───────────────────────────────────────────────────────────────────
    function test_poke_noopWhenNoNewEvent() public {
        vm.roll(block.number + 5000);
        vm.recordLogs();
        assertFalse(src.poke());
        assertEq(vm.getRecordedLogs().length, 0);
        (int256 f, int256 g, uint64 b) = _latest();
        assertEq(f, int256(SUM0) * 1e10);
        assertEq(g, 0);
        assertEq(b, FEB0);
        assertEq(src.lastPokeBlock(), FEB0 + 100);
    }

    function test_poke_noopBeforeEventApplies() public {
        // the event is written ahead of its feb (Perpl emits ~78 blocks early); the view only returns it from feb on
        x.pushEvent(PERP, FEB0 + IB, SUM0 - 25);
        vm.roll(FEB0 + IB - 1);
        assertFalse(src.poke());
        vm.roll(FEB0 + IB);
        assertTrue(src.poke());
    }

    function test_poke_noopIgnoresStalePriceWhenNothingNew() public {
        x.setPrice(PERP, P, 1);
        assertFalse(src.poke());
    }

    function test_poke_advancesBothLegs() public {
        uint256 feb = _event(1, SUM0 - 25);
        vm.expectEmit(address(src));
        emit IPerplFundingSource.Poked(int256(SUM0 - 25) * 1e10, I * IS, uint64(feb), I, -1e13 / int256(IS));
        assertTrue(src.poke());
        (int256 f, int256 g, uint64 b) = _latest();
        assertEq(f, int256(SUM0 - 25) * 1e10);
        assertEq(g, int256(I * IS)); // ΔG = I·Δfeb·IS/IB = I·IS for one interval
        assertEq(b, feb);
        assertEq(src.checkpointIndex(), 1);
        assertEq(src.lastPokeBlock(), block.number);
    }

    function test_poke_secondPokeSameEventIsNoop() public {
        _event(1, SUM0 - 25);
        assertTrue(src.poke());
        (int256 f, int256 g,) = _latest();
        vm.roll(block.number + 1);
        assertFalse(src.poke());
        (int256 f2, int256 g2,) = _latest();
        assertEq(f2, f);
        assertEq(g2, g);
    }

    function test_poke_multiEventCatchUp() public {
        _event(1, SUM0 - 25);
        _event(1, SUM0 - 50);
        uint256 feb = _event(1, SUM0 - 40);
        x.setPrice(PERP, 2600, block.timestamp);
        assertTrue(src.poke());
        (int256 f, int256 g, uint64 b) = _latest();
        assertEq(f, int256(SUM0 - 40) * 1e10); // F = latest sum (missed events included)
        assertEq(g, int256(2600 * 1e13 * 3 * IS)); // O(1): ΔG = I_now · 3 intervals
        assertEq(b, feb);
        assertEq(src.checkpointIndex(), 1); // one entry per poke
    }

    function test_poke_partialIntervalGap() public {
        // Perpl events are 8,571 blocks apart; a gap that is not a multiple still prorates exactly
        x.pushEvent(PERP, FEB0 + 4000, SUM0 - 10);
        vm.roll(FEB0 + 4000);
        assertTrue(src.poke());
        (, int256 g,) = _latest();
        assertEq(g, int256(I * 4000 * IS / IB));
    }

    function test_poke_revertsStalePrice_nothingWritten() public {
        _event(1, SUM0 - 25);
        x.setPrice(PERP, P, block.timestamp - 121);
        vm.expectRevert(abi.encodeWithSelector(IPerplFundingSource.StalePerplPrice.selector, block.timestamp - 121));
        src.poke();
        (int256 f, int256 g, uint64 b) = _latest();
        assertEq(f, int256(SUM0) * 1e10);
        assertEq(g, 0);
        assertEq(b, FEB0);
        // F and G resume together once the price is fresh: no fixed-leg time is lost
        x.setPrice(PERP, P, block.timestamp);
        assertTrue(src.poke());
        (, g,) = _latest();
        assertEq(g, int256(I * IS));
    }

    function test_poke_priceAgeBoundaryAccepted() public {
        _event(1, SUM0 - 25);
        x.setPrice(PERP, P, block.timestamp - 120);
        assertTrue(src.poke());
    }

    function test_poke_futureOracleTimestampAccepted() public {
        _event(1, SUM0 - 25);
        x.setPrice(PERP, P, block.timestamp + 5);
        assertTrue(src.poke());
    }

    function test_poke_revertsZeroPrice() public {
        _event(1, SUM0 - 25);
        x.setPrice(PERP, 0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(IPerplFundingSource.StalePerplPrice.selector, block.timestamp));
        src.poke();
    }

    function test_poke_revertsScaleChanged() public {
        _event(1, SUM0 - 25);
        x.setScale(PERP, 5, 2);
        vm.expectRevert(IPerplFundingSource.PerplScaleChanged.selector);
        src.poke();
        x.setScale(PERP, 6, 3);
        vm.expectRevert(IPerplFundingSource.PerplScaleChanged.selector);
        src.poke();
    }

    function test_poke_updatesRateCapAndPrice() public {
        _event(1, SUM0 + 30);
        x.setRate(PERP, 3, 20);
        x.setPrice(PERP, 2400, block.timestamp);
        src.poke();
        assertEq(src.indexPrice(), 2400 * 1e13);
        assertEq(src.fundingState().rate, 3e13 / int256(IS));
        // ⌈20·1e13·10,500 / (10,000·2,580)⌉
        assertEq(src.fundingParams().rateCap, (uint256(20e13) * 10_500 + 10_000 * IS - 1) / (10_000 * IS));
    }

    function test_poke_gNeverDecreasesWhenSumFalls() public {
        int256 gPrev;
        for (uint256 i = 1; i <= 5; ++i) {
            _event(1, SUM0 - int48(int256(i * 100)));
            src.poke();
            (, int256 g,) = _latest();
            assertGt(g, gPrev);
            gPrev = g;
        }
    }

    // ─── views ──────────────────────────────────────────────────────────────────
    function test_fundingParams_onlyCapAndBlockTime() public view {
        FundingParams memory p = src.fundingParams();
        assertEq(p.rateCap, (uint256(10e13) * 10_500 + 10_000 * IS - 1) / (10_000 * IS));
        assertEq(p.blockTimeMs, IS * 1000 / IB);
        assertEq(p.alpha, 0);
        assertEq(p.interestRate, 0);
        assertEq(p.maxRateChangePerBlock, 0);
        assertEq(p.premiumBandWad, 0);
    }

    function test_fundingState_fields() public {
        uint256 feb = _event(1, SUM0 - 25);
        src.poke();
        FundingState memory s = src.fundingState();
        assertEq(s.cumFunding, int256(SUM0 - 25) * 1e10);
        assertEq(s.cumIndexTime, int256(I * IS));
        assertEq(s.emaPremium, 0);
        assertEq(s.rate, -1e13 / int256(IS));
        assertEq(s.lastUpdateBlock, feb);
    }

    function test_observe_newestWhenTargetAfterIt() public {
        _event(1, SUM0 - 25);
        src.poke();
        (int256 f,, uint64 b) = src.observe(0);
        assertEq(f, int256(SUM0 - 25) * 1e10);
        assertEq(b, FEB0 + IB);
    }

    function test_observe_binarySearch() public {
        uint256[] memory febs = new uint256[](6);
        for (uint256 i = 0; i < 6; ++i) {
            febs[i] = _event(1, SUM0 - int48(int256((i + 1) * 10)));
            src.poke();
        }
        // target strictly between febs[2] and febs[3] ⇒ the checkpoint at febs[2]
        uint64 ago = uint64(block.number - (febs[2] + 10));
        (int256 f, int256 g, uint64 b) = src.observe(ago);
        assertEq(b, febs[2]);
        assertEq(f, int256(SUM0 - 30) * 1e10);
        assertEq(g, int256(I * IS * 3));
        // exactly on a feb ⇒ that checkpoint
        (,, b) = src.observe(uint64(block.number - febs[4]));
        assertEq(b, febs[4]);
        // the constructor's checkpoint is the oldest
        (,, b) = src.observe(uint64(block.number - FEB0));
        assertEq(b, FEB0);
    }

    function test_observe_revertsTooOld() public {
        _event(1, SUM0 - 25);
        src.poke();
        vm.expectRevert(IFundingRateOracle.ObservationTooOld.selector);
        src.observe(uint64(block.number - FEB0 + 1));
    }

    function test_observe_revertsBlocksAgoAboveBlockNumber() public {
        vm.expectRevert(IFundingRateOracle.ObservationTooOld.selector);
        src.observe(uint64(block.number + 1));
    }

    function test_observe_ringWrap() public {
        uint256 n = src.RING_SIZE() + 10;
        uint256 firstKept;
        for (uint256 i = 1; i <= n; ++i) {
            uint256 feb = _event(1, SUM0 - int48(int256(i)));
            src.poke();
            if (i == n - src.RING_SIZE() + 1) firstKept = feb;
        }
        assertEq(src.checkpointIndex(), n % src.RING_SIZE());
        (,, uint64 b) = src.observe(uint64(block.number - firstKept));
        assertEq(b, firstKept);
        vm.expectRevert(IFundingRateOracle.ObservationTooOld.selector);
        src.observe(uint64(block.number - firstKept + 1));
        (int256 f, int256 g, uint64 c) = src.checkpointAt((src.checkpointIndex() + 1) % src.RING_SIZE());
        assertEq(c, firstKept);
        assertEq(f, (int256(SUM0) - int256(n - src.RING_SIZE() + 1)) * 1e10);
        assertEq(g, int256(I * IS * (n - src.RING_SIZE() + 1)));
    }

    function test_averageFundingRate_isDeltaFOverDeltaG() public {
        _event(1, SUM0 - 25);
        src.poke();
        _event(1, SUM0 - 55);
        src.poke();
        // over both intervals: ΔF = −55e10, ΔG = 2·I·IS
        int256 expected = int256(-55e10) * 1e18 / int256(2 * I * IS);
        assertEq(src.averageFundingRate(uint64(block.number - FEB0)), expected);
        assertEq(src.averageFundingApr(uint64(block.number - FEB0)), expected * 365 days);
    }

    function test_averageFundingRate_currentRateWhenNoIndexTime() public view {
        assertEq(src.averageFundingRate(0), -1e13 / int256(IS));
        assertEq(src.averageFundingApr(0), (-1e13 / int256(IS)) * 365 days);
    }

    function test_averageFundingRate_clampedToCap() public {
        // an admin overwrite-sized jump: +5,000 sum units in one interval ≫ the 10 per 100k clamp
        _event(1, SUM0 + 5000);
        src.poke();
        int256 cap = int256(src.fundingParams().rateCap);
        assertEq(src.averageFundingRate(uint64(block.number - FEB0)), cap);
        _event(1, SUM0 - 20_000);
        src.poke();
        assertEq(src.averageFundingRate(uint64(block.number - (FEB0 + IB))), -cap);
    }

    function test_averageFundingRate_revertsTooOld() public {
        vm.expectRevert(IFundingRateOracle.ObservationTooOld.selector);
        src.averageFundingApr(uint64(block.number - FEB0 + 1));
    }

    function test_realRateWithinCap() public {
        // a clamp-sized event at the oracle price: |avg| ≤ cap
        _event(1, SUM0 + int48(int256(10 * P * 1000 / 1e5))); // rate 10 per 100k ⇒ ppl = 10·2500·1e3/1e5 = 250
        src.poke();
        int256 avg = src.averageFundingRate(uint64(block.number - FEB0));
        assertLe(avg, int256(src.fundingParams().rateCap));
        assertEq(avg, int256(250e10) * 1e18 / int256(I * IS));
    }
}
