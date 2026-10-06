// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ClearingHouseBase} from "./ClearingHouseBase.t.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {IClearingHouse} from "../../src/interfaces/IClearingHouse.sol";
import {IMarginEngine} from "../../src/interfaces/IMarginEngine.sol";
import {IFundingRateOracle} from "../../src/interfaces/IFundingRateOracle.sol";
import {
    PulseConstants,
    RiskParams,
    FundingParams,
    FundingState,
    Position,
    AccountView
} from "../../src/interfaces/PulseTypes.sol";

contract ClearingHouseTest is ClearingHouseBase {
    // ═══ constructor / wiring ═══════════════════════════════════════════════════
    function test_constructor_state() public view {
        assertEq(ch.collateralToken(), address(ausd));
        assertEq(ch.oracle(), address(oracle));
        assertEq(ch.insuranceFund(), address(fund));
        assertEq(ch.orderBook(), address(ob));
        assertEq(ch.owner(), owner);
        assertEq(ch.riskParams().imr, 0.2e18);
        assertEq(ch.riskParams().makerFee, -0.0001e18);
        assertEq(ch.fundingParams().interestRate, INTEREST);
        assertEq(ch.fundingParams().blockTimeMs, 300);
        FundingState memory s = ch.fundingState();
        assertEq(s.lastUpdateBlock, 1000);
        assertEq(s.cumFunding, 0);
        assertEq(ch.markPrice(), I0);
        assertEq(ch.indexPrice(), I0);
        (int256 f, int256 g, uint64 blk) = ch.checkpointAt(0);
        assertEq(f, 0);
        assertEq(g, 0);
        assertEq(blk, 1000);
        assertEq(PulseConstants.CHECKPOINT_SLOTS, 1440, "ring literal matches the constant");
    }

    function test_constructor_revertsOnZeroAddress() public {
        vm.expectRevert(IClearingHouse.InvalidParams.selector);
        new ClearingHouse(address(0), address(oracle), address(fund), _risk(), _funding(), owner);
        vm.expectRevert(IClearingHouse.InvalidParams.selector);
        new ClearingHouse(address(ausd), address(0), address(fund), _risk(), _funding(), owner);
        vm.expectRevert(IClearingHouse.InvalidParams.selector);
        new ClearingHouse(address(ausd), address(oracle), address(0), _risk(), _funding(), owner);
    }

    function test_constructor_staleOracleStartsStale() public {
        oracle.setStale(true);
        ClearingHouse c2 = new ClearingHouse(address(ausd), address(oracle), address(fund), _risk(), _funding(), owner);
        assertEq(c2.markPrice(), 0);
        assertEq(c2.indexPrice(), 0);
    }

    function test_setOrderBook_onceOnlyOwner() public {
        vm.prank(owner);
        vm.expectRevert(IClearingHouse.AlreadyInitialized.selector);
        ch.setOrderBook(address(ob));

        ClearingHouse c2 = new ClearingHouse(address(ausd), address(oracle), address(fund), _risk(), _funding(), owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        c2.setOrderBook(address(ob));
        vm.prank(owner);
        vm.expectRevert(IClearingHouse.InvalidParams.selector);
        c2.setOrderBook(address(0));
    }

    // ═══ admin bounds ═══════════════════════════════════════════════════════════
    function _expectRiskRevert(RiskParams memory p) internal {
        vm.prank(owner);
        vm.expectRevert(IClearingHouse.InvalidParams.selector);
        ch.setRiskParams(p);
    }

    function test_setRiskParams_bounds() public {
        RiskParams memory p = _risk();
        p.mmr = 0;
        _expectRiskRevert(p);
        p = _risk();
        p.mmr = p.imr;
        _expectRiskRevert(p);
        p = _risk();
        p.imr = 0.5e18 + 1;
        _expectRiskRevert(p);
        p = _risk();
        p.takerFee = 0.01e18 + 1;
        _expectRiskRevert(p);
        p = _risk();
        p.makerFee = int256(p.takerFee) + 1;
        _expectRiskRevert(p);
        p = _risk();
        p.makerFee = -int256(p.takerFee) - 1;
        _expectRiskRevert(p);
        p = _risk();
        p.liqPenalty = p.mmr + 1;
        _expectRiskRevert(p);
        p = _risk();
        p.keeperShare = 1e18 + 1;
        _expectRiskRevert(p);
        p = _risk();
        p.maxPositionSize = 0;
        _expectRiskRevert(p);
        p = _risk();
        p.maxPositionSize = p.maxOpenInterest + 1;
        _expectRiskRevert(p);
        p = _risk();
        p.maxOpenInterest = 1e30 + 1;
        _expectRiskRevert(p);

        p = _risk();
        p.imr = 0.5e18;
        vm.expectEmit(address(ch));
        emit IClearingHouse.RiskParamsUpdated(p);
        vm.prank(owner);
        ch.setRiskParams(p);
        assertEq(ch.riskParams().imr, 0.5e18);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        ch.setRiskParams(p);
    }

    function _expectFundingRevert(FundingParams memory p) internal {
        vm.prank(owner);
        vm.expectRevert(IClearingHouse.InvalidParams.selector);
        ch.setFundingParams(p);
    }

    function test_setFundingParams_bounds() public {
        FundingParams memory p = _funding();
        p.alpha = 0;
        _expectFundingRevert(p);
        p = _funding();
        p.alpha = 0.5e18 + 1;
        _expectFundingRevert(p);
        p = _funding();
        p.rateCap = 0;
        _expectFundingRevert(p);
        p = _funding();
        p.rateCap = 2_777_777_777_779; // > 1%/h
        _expectFundingRevert(p);
        p = _funding();
        p.interestRate = int256(p.rateCap) + 1;
        _expectFundingRevert(p);
        p = _funding();
        p.interestRate = -int256(p.rateCap) - 1;
        _expectFundingRevert(p);
        p = _funding();
        p.maxRateChangePerBlock = 0;
        _expectFundingRevert(p);
        p = _funding();
        p.maxRateChangePerBlock = p.rateCap + 1;
        _expectFundingRevert(p);
        p = _funding();
        p.blockTimeMs = 99;
        _expectFundingRevert(p);
        p = _funding();
        p.blockTimeMs = 2001;
        _expectFundingRevert(p);
        p = _funding();
        p.premiumBandWad = 0.5e18 + 1;
        _expectFundingRevert(p);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        ch.setFundingParams(_funding());
    }

    /// Changing funding params first accrues the elapsed blocks under the old parameters.
    function test_setFundingParams_accruesFirst() public {
        _roll(10);
        FundingParams memory p = _funding();
        p.blockTimeMs = 400;
        vm.prank(owner);
        ch.setFundingParams(p);
        FundingState memory s = ch.fundingState();
        assertEq(s.lastUpdateBlock, block.number);
        assertEq(s.cumIndexTime, int256(I0 * 10 * 300 / 1000), "10 blocks at the old 300 ms");
        assertEq(ch.fundingParams().blockTimeMs, 400);
    }

    function test_setPaused_onlyOwner() public {
        vm.expectEmit(address(ch));
        emit IClearingHouse.PausedSet(true);
        vm.prank(owner);
        ch.setPaused(true);
        assertTrue(ch.paused());
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        ch.setPaused(false);
    }

    // ═══ collateral ═══════════════════════════════════════════════════════════════
    function test_deposit_creditsWad() public {
        ausd.mint(alice, 5e6);
        vm.startPrank(alice);
        ausd.approve(address(ch), 5e6);
        vm.expectEmit(address(ch));
        emit IClearingHouse.Deposited(alice, 5e6, 5e18);
        ch.deposit(5e6);
        vm.stopPrank();
        assertEq(ch.collateralOf(alice), 5e18);
        assertEq(_acct(alice).collateral, 5e18);
        assertEq(ausd.balanceOf(address(ch)), 5e6);
    }

    function test_deposit_revertsZero() public {
        vm.expectRevert(IClearingHouse.ZeroAmount.selector);
        vm.prank(alice);
        ch.deposit(0);
    }

    function test_depositFor_creditsAccountPullsFromSender() public {
        ausd.mint(bob, 7e6);
        vm.startPrank(bob);
        ausd.approve(address(ch), 7e6);
        ch.depositFor(alice, 7e6);
        vm.expectRevert(IClearingHouse.InvalidParams.selector);
        ch.depositFor(address(0), 1);
        vm.stopPrank();
        assertEq(ch.collateralOf(alice), 7e18);
        assertEq(ch.collateralOf(bob), 0);
        assertEq(ausd.balanceOf(bob), 0);
    }

    function test_withdraw_flat() public {
        _deposit(alice, 1000e6);
        vm.expectEmit(address(ch));
        emit IClearingHouse.Withdrawn(alice, 1000e6, 1000e18);
        vm.prank(alice);
        ch.withdraw(1000e6);
        assertEq(ausd.balanceOf(alice), 1000e6);
        assertEq(ch.collateralOf(alice), 0);
    }

    function test_withdraw_reverts() public {
        _deposit(alice, 1000e6);
        vm.startPrank(alice);
        vm.expectRevert(IClearingHouse.ZeroAmount.selector);
        ch.withdraw(0);
        vm.expectRevert(IMarginEngine.InsufficientMargin.selector);
        ch.withdraw(1000e6 + 1);
        vm.stopPrank();
    }

    function test_withdraw_keepsInitialMargin() public {
        _deposit(alice, 100e6);
        _deposit(bob, 1000e6);
        _trade(alice, bob, true, 100, 2e18); // long 100 @ 2 ⇒ IM 40, fee 0.1 ⇒ C 99.9
        vm.startPrank(alice);
        vm.expectRevert(IMarginEngine.InsufficientMargin.selector);
        ch.withdraw(60e6); // C 39.9 < IM 40
        ch.withdraw(59e6); // C 40.9 ≥ 40
        vm.stopPrank();
        assertEq(ch.collateralOf(alice), 40.9e18);
    }

    function test_withdraw_neverPaysUnrealizedProfit() public {
        _deposit(alice, 100e6);
        _deposit(bob, 1000e6);
        _trade(alice, bob, true, 100, 2e18);
        oracle.setPrice(2.1e18);
        _roll(1);
        assertGt(_acct(alice).equity, 100e18, "equity above collateral");
        vm.prank(alice);
        vm.expectRevert(IMarginEngine.InsufficientMargin.selector);
        ch.withdraw(100e6);
    }

    function test_withdraw_staleOracleBlocksOnlyWithPosition() public {
        _deposit(alice, 100e6);
        _deposit(bob, 1000e6);
        _deposit(carol, 10e6);
        _trade(alice, bob, true, 10, 2e18);
        oracle.setStale(true);
        _roll(1);
        vm.prank(alice);
        vm.expectRevert(IClearingHouse.OracleStale.selector);
        ch.withdraw(1e6);
        vm.prank(carol);
        ch.withdraw(10e6);
        assertEq(ausd.balanceOf(carol), 10e6);
    }

    // ═══ funding touch ═══════════════════════════════════════════════════════════
    function test_updateFunding_oncePerBlock() public {
        _roll(5);
        vm.recordLogs();
        int256 f1 = ch.updateFunding();
        FundingState memory s1 = ch.fundingState();
        int256 f2 = ch.updateFunding();
        ch.settleFunding(alice);
        assertEq(f1, f2);
        FundingState memory s2 = ch.fundingState();
        assertEq(keccak256(abi.encode(s1)), keccak256(abi.encode(s2)), "second touch writes nothing");
        assertEq(_countFundingUpdated(vm.getRecordedLogs()), 1, "one FundingUpdated per block");
    }

    function test_updateFunding_interestAccruesGAndF() public {
        _roll(1);
        ch.updateFunding();
        FundingState memory s = ch.fundingState();
        // First update: rate δ-clamped from 0 toward i (i = 3.47e9 < 7δ): r = δ
        assertEq(s.rate, int256(DELTA));
        assertEq(s.cumIndexTime, 0.6e18, "G += I * 0.3 s");
        assertEq(s.cumFunding, int256(uint256(DELTA) * 2e18 * 300 / 1000 / 1e18));
        _roll(100);
        ch.updateFunding();
        assertEq(ch.fundingState().rate, INTEREST, "rate reaches i");
    }

    /// Mark (book mid) above index ⇒ premium > 0 ⇒ F rises ⇒ longs pay shorts.
    function test_funding_longsPayWhenMarkAboveIndex() public {
        _deposit(alice, 1000e6);
        _deposit(bob, 1000e6);
        _trade(alice, bob, true, 100, 2e18);
        ob.mockSetBook(20_100, 20_300); // mid 2.02, spread < 2% ⇒ premium +1%
        for (uint256 i; i < 50; ++i) {
            _roll(1);
            ch.updateFunding();
        }
        FundingState memory s = ch.fundingState();
        assertGt(s.emaPremium, 0);
        assertGt(s.rate, INTEREST);
        AccountView memory a = _acct(alice);
        AccountView memory b = _acct(bob);
        assertGt(a.pendingFunding, 0, "long owes");
        assertLt(b.pendingFunding, 0, "short receives");
        assertGe(a.pendingFunding + b.pendingFunding, 0);
        assertLe(a.pendingFunding + b.pendingFunding, 2);
    }

    function test_settleFunding_movesCollateral() public {
        _deposit(alice, 1000e6);
        _deposit(bob, 1000e6);
        _trade(alice, bob, true, 100, 2e18);
        _roll(1000);
        int256 pending = _acct(alice).pendingFunding;
        int256 c0 = ch.collateralOf(alice);
        vm.expectEmit(address(ch));
        emit IClearingHouse.FundingSettled(alice, pending, ch.previewFundingState().cumFunding);
        ch.settleFunding(alice);
        assertEq(ch.collateralOf(alice), c0 - pending);
        assertEq(_acct(alice).pendingFunding, 0);
        assertEq(ch.getPosition(alice).lastCumFunding, ch.fundingState().cumFunding);
    }

    /// §1.6: stale ⇒ F and G frozen, lastUpdateBlock advances, event with rate unchanged; no retroactive accrual.
    function test_staleOracle_freezesAccrual() public {
        _roll(1);
        ch.updateFunding();
        FundingState memory s0 = ch.fundingState();
        oracle.setStale(true);
        _roll(50);
        vm.recordLogs();
        ch.updateFunding();
        assertEq(_countFundingUpdated(vm.getRecordedLogs()), 1);
        FundingState memory s1 = ch.fundingState();
        assertEq(s1.cumFunding, s0.cumFunding);
        assertEq(s1.cumIndexTime, s0.cumIndexTime);
        assertEq(s1.rate, s0.rate);
        assertEq(s1.lastUpdateBlock, block.number);
        assertEq(ch.markPrice(), I0, "last good mark");
        assertEq(ch.indexPrice(), I0, "last good index");

        oracle.setStale(false);
        _roll(1);
        ch.updateFunding();
        assertEq(ch.fundingState().cumIndexTime - s1.cumIndexTime, 0.6e18, "one block only");
    }

    function test_staleOracle_blocksIncreasesAllowsReductions() public {
        _deposit(alice, 1000e6);
        _deposit(bob, 1000e6);
        _deposit(carol, 1000e6);
        _trade(alice, bob, true, 100, 2e18);
        _trade(carol, bob, true, 50, 2e18); // carol long 50: a maker whose sell is a reduction
        oracle.setStale(true);
        _roll(1);
        // Taker increase against a reducing maker: the taker's increase is refused.
        ob.mockSetMaker(carol);
        ob.mockSetFillPrice(2e18);
        vm.prank(alice);
        vm.expectRevert(IClearingHouse.OracleStale.selector);
        ob.placeMarketOrder(true, 10, 0, 0, false);
        // Maker increase (bob short → shorter) is refused too: the book evicts it and nothing fills.
        ob.mockSetMaker(bob);
        vm.prank(alice);
        (uint64 filled,) = ob.placeMarketOrder(true, 10, 0, 0, false);
        assertEq(filled, 0);
        assertEq(ch.getPosition(bob).size, -150e18);
        _trade(alice, bob, false, 40, 2e18); // reduce: alice sells, bob buys back
        assertEq(ch.getPosition(alice).size, 60e18);
        assertEq(ch.getPosition(bob).size, -110e18);
        vm.prank(alice);
        vm.expectRevert(IClearingHouse.OracleStale.selector);
        ob.placeLimitOrder(true, 19_000, 1, 0);
    }

    function test_oracleRevertIsTreatedAsStale() public {
        vm.mockCallRevert(address(oracle), abi.encodeWithSignature("tryGetIndexPrice()"), "boom");
        _roll(3);
        ch.updateFunding();
        assertEq(ch.fundingState().cumIndexTime, 0);
        assertEq(ch.indexPrice(), I0);
    }

    // ═══ checkpoints / IFundingRateOracle ═══════════════════════════════════════
    function test_checkpoint_oncePerBucket() public {
        // deploy at 1000 (bucket 5). Touch every 20 blocks through 1400.
        for (uint256 b = 1020; b <= 1400; b += 20) {
            vm.roll(b);
            ch.updateFunding();
        }
        (,, uint64 b1) = ch.checkpointAt(1);
        (,, uint64 b2) = ch.checkpointAt(2);
        (,, uint64 b3) = ch.checkpointAt(3);
        assertEq(b1, 1200);
        assertEq(b2, 1400);
        assertEq(b3, 0, "no third checkpoint");
    }

    function test_checkpoint_emitsEvent() public {
        vm.roll(1200);
        FundingState memory p = ch.previewFundingState();
        vm.expectEmit(address(ch));
        emit IFundingRateOracle.FundingCheckpoint(1, 1200, p.cumFunding, p.cumIndexTime);
        ch.updateFunding();
    }

    function test_observe_fastPathAndSearch() public {
        // keeper cadence: every 20 blocks from 1020 to 5000 ⇒ one checkpoint per bucket
        for (uint256 b = 1020; b <= 5000; b += 20) {
            vm.roll(b);
            ch.updateFunding();
        }
        // idle for 7 buckets, then touches with gaps: buckets 26..32 have no checkpoint
        vm.roll(6500);
        ch.updateFunding();
        vm.roll(6560); // same bucket (32) as 6500: no new checkpoint
        ch.updateFunding();

        (,, uint64 blk) = ch.observe(0);
        assertEq(blk, 6500, "latest checkpoint at or before now");
        (,, blk) = ch.observe(6560 - 4999);
        assertEq(blk, 4800, "fast path: bucket 24");
        (,, blk) = ch.observe(6560 - 5000);
        assertEq(blk, 5000);
        (,, blk) = ch.observe(6560 - 6400);
        assertEq(blk, 5000, "gap: binary search");
        (,, blk) = ch.observe(6560 - 1000);
        assertEq(blk, 1000, "oldest");
        vm.expectRevert(IFundingRateOracle.ObservationTooOld.selector);
        ch.observe(6560 - 999);
        vm.expectRevert(IFundingRateOracle.ObservationTooOld.selector);
        ch.observe(uint64(block.number) + 1);
    }

    function test_observe_afterWrap() public {
        uint256 b = 1000;
        for (uint256 i; i < 1500; ++i) {
            b += 200;
            vm.roll(b);
            ch.updateFunding();
        }
        // 1501 checkpoints written into 1440 slots: the oldest 61 are gone
        (,, uint64 blk) = ch.observe(uint64(b - (b - 1439 * 200)));
        assertEq(blk, b - 1439 * 200, "oldest surviving");
        vm.expectRevert(IFundingRateOracle.ObservationTooOld.selector);
        ch.observe(uint64(1439 * 200 + 1));
        (,, blk) = ch.observe(uint64(1000 * 200 + 50));
        assertEq(blk, b - 1000 * 200 - 200, "binary search inside the wrapped ring");
    }

    /// CP1 / acceptance: averageFundingApr == ΔF/ΔG·YEAR computed from the FundingUpdated events.
    function test_averageFundingApr_matchesEvents() public {
        _deposit(alice, 1000e6);
        _deposit(bob, 1000e6);
        _trade(alice, bob, true, 100, 2e18);
        ob.mockSetBook(20_100, 20_300);
        vm.recordLogs();
        for (uint256 b = 1010; b <= 3000; b += 10) {
            vm.roll(b);
            if (b == 2000) oracle.setPrice(2.2e18);
            ch.updateFunding();
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (int256 fThen, int256 gThen, int256 fNow, int256 gNow) = (0, 0, 0, 0);
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != IClearingHouse.FundingUpdated.selector) continue;
            uint64 blk = uint64(uint256(logs[i].topics[1]));
            (,,, int256 f, int256 g,,) =
                abi.decode(logs[i].data, (int256, int256, int256, int256, int256, uint256, uint256));
            if (blk == 1600) (fThen, gThen) = (f, g);
            if (blk == 3000) (fNow, gNow) = (f, g);
        }
        int256 expected = (fNow - fThen) * 1e18 / (gNow - gThen);
        assertEq(ch.averageFundingRate(1400), expected);
        assertEq(ch.averageFundingApr(1400), expected * 365 days);
        assertGt(expected, INTEREST, "premium on top of interest");
        assertLe(expected, int256(CAP));
    }

    function test_averageFundingRate_zeroWindowIsCurrentRate() public {
        _roll(1);
        ch.updateFunding(); // no new bucket; checkpoint 0 at 1000 ⇒ window ΔG > 0
        vm.roll(1200);
        ch.updateFunding(); // checkpoint at 1200 == now ⇒ ΔG = 0
        assertEq(ch.averageFundingRate(0), ch.fundingState().rate);
    }

    function test_latestObservation_previewsAccrual() public {
        _roll(10);
        (int256 f, int256 g, uint64 blk) = ch.latestObservation();
        assertEq(blk, block.number);
        assertEq(g, int256(I0 * 10 * 300 / 1000));
        ch.updateFunding();
        assertEq(ch.fundingState().cumFunding, f);
        assertEq(ch.fundingState().cumIndexTime, g);
    }

    // ═══ order book hooks ═══════════════════════════════════════════════════════
    function test_hooks_onlyOrderBook() public {
        vm.startPrank(alice);
        vm.expectRevert(IMarginEngine.OnlyOrderBook.selector);
        ch.reserveOrderMargin(alice, true, 1e18, 1e18);
        vm.expectRevert(IMarginEngine.OnlyOrderBook.selector);
        ch.releaseOrderMargin(alice, true, 1e18, 1e18);
        vm.expectRevert(IMarginEngine.OnlyOrderBook.selector);
        ch.settleMakerFill(alice, true, 1e18, 1e18);
        vm.expectRevert(IMarginEngine.OnlyOrderBook.selector);
        ch.settleTakerFill(alice, true, 1e18, 1e18, false);
        vm.stopPrank();
    }

    function test_reserveAndRelease() public {
        _deposit(alice, 10e6);
        vm.prank(alice);
        ob.placeLimitOrder(true, 20_000, 20, 0); // 20 @ 2 ⇒ reserve 8
        assertEq(_acct(alice).reservedOrderMargin, 8e18);
        assertEq(_acct(alice).initialMargin, 8e18);
        vm.prank(alice);
        vm.expectRevert(IMarginEngine.InsufficientMargin.selector);
        ob.placeLimitOrder(true, 20_000, 6, 0); // +2.4 > 10
        vm.expectEmit(address(ch));
        emit IClearingHouse.OrderMarginChanged(alice, 0);
        vm.prank(alice);
        ob.cancelOrder(1);
        vm.prank(address(ob));
        ch.releaseOrderMargin(alice, true, 1e18, 2e18); // saturates at 0
        assertEq(_acct(alice).reservedOrderMargin, 0);
    }

    function test_reserve_pausedReverts() public {
        _deposit(alice, 10e6);
        vm.prank(owner);
        ch.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(IClearingHouse.Paused.selector);
        ob.placeLimitOrder(true, 20_000, 1, 0);
    }

    function test_withdraw_respectsReservations() public {
        _deposit(alice, 10e6);
        vm.prank(alice);
        ob.placeLimitOrder(true, 20_000, 20, 0);
        vm.prank(alice);
        vm.expectRevert(IMarginEngine.InsufficientMargin.selector);
        ch.withdraw(2.1e6);
        vm.prank(alice);
        ch.withdraw(2e6);
    }

    function test_makerFill_updatesPositionReleasesAndRebates() public {
        _deposit(alice, 10e6);
        vm.prank(alice);
        ob.placeLimitOrder(true, 20_000, 20, 0);
        vm.expectEmit(address(ch));
        emit IClearingHouse.PositionChanged(alice, 5e18, 5e18, 2e18, 0, -0.001e18, true);
        vm.prank(address(ob));
        assertEq(uint8(ch.settleMakerFill(alice, true, 5e18, 2e18)), uint8(IMarginEngine.MakerFillResult.Filled));
        Position memory p = ch.getPosition(alice);
        assertEq(p.size, 5e18);
        assertEq(p.openNotional, 10e18);
        assertEq(_acct(alice).reservedOrderMargin, 6e18, "15 lots still reserved");
        assertEq(ch.collateralOf(alice), 10.001e18, "rebate 1 bp of 10");
        (uint256 lo, uint256 so) = ch.openInterest();
        assertEq(lo, 5e18);
        assertEq(so, 0, "counterparty not settled in this unit call");
    }

    function test_makerFill_evictOrSkipWithoutStateChange() public {
        // no collateral
        vm.prank(address(ob));
        assertEq(uint8(ch.settleMakerFill(carol, true, 10e18, 2e18)), uint8(IMarginEngine.MakerFillResult.Evict));
        assertEq(ch.getPosition(carol).size, 0);
        // paused: increase refused with Skip (CR-007: the order stays), reduction allowed
        _deposit(alice, 100e6);
        vm.prank(address(ob));
        assertEq(uint8(ch.settleMakerFill(alice, true, 10e18, 2e18)), uint8(IMarginEngine.MakerFillResult.Filled));
        vm.prank(owner);
        ch.setPaused(true);
        vm.startPrank(address(ob));
        assertEq(uint8(ch.settleMakerFill(alice, true, 1e18, 2e18)), uint8(IMarginEngine.MakerFillResult.Skip));
        assertEq(uint8(ch.settleMakerFill(alice, false, 4e18, 2e18)), uint8(IMarginEngine.MakerFillResult.Filled));
        vm.stopPrank();
        assertEq(ch.getPosition(alice).size, 6e18);
    }

    function test_makerFill_skipOnStale_evictOnPositionCap() public {
        _deposit(alice, 100_000e6);
        oracle.setStale(true);
        _roll(1);
        vm.prank(address(ob));
        assertEq(uint8(ch.settleMakerFill(alice, true, 1e18, 2e18)), uint8(IMarginEngine.MakerFillResult.Skip), "stale");
        oracle.setStale(false);
        _roll(1);
        vm.prank(address(ob));
        assertEq(
            uint8(ch.settleMakerFill(alice, true, 25_000e18 + 1, 2e18)),
            uint8(IMarginEngine.MakerFillResult.Evict),
            "position cap"
        );
        vm.prank(address(ob));
        assertEq(uint8(ch.settleMakerFill(alice, true, 25_000e18, 2e18)), uint8(IMarginEngine.MakerFillResult.Filled));
    }

    /// CR-007: `_checkFill` checks pause and staleness before margin, so a maker that is both under-margined and
    /// hits a paused (or stale) market is Skipped, not Evicted: the conservative outcome (the order stays).
    function test_makerFill_pausedBeatsMargin_skip() public {
        vm.prank(owner);
        ch.setPaused(true);
        vm.prank(address(ob));
        assertEq(uint8(ch.settleMakerFill(carol, true, 10e18, 2e18)), uint8(IMarginEngine.MakerFillResult.Skip));
        vm.prank(owner);
        ch.setPaused(false);
        oracle.setStale(true);
        _roll(1);
        vm.prank(address(ob));
        assertEq(uint8(ch.settleMakerFill(carol, true, 10e18, 2e18)), uint8(IMarginEngine.MakerFillResult.Skip));
        assertEq(ch.getPosition(carol).size, 0);
    }

    /// Skip writes nothing for the fill and keeps the reservation; the maker's funding settlement is still written.
    function test_makerFill_skipKeepsReservation_settlesFunding() public {
        _deposit(alice, 1000e6);
        _deposit(bob, 1000e6);
        _trade(alice, bob, true, 10, 2e18); // alice long 10, bob short 10
        vm.prank(alice);
        ob.placeLimitOrder(true, 19_000, 20, 0);
        uint256 res = _acct(alice).reservedOrderMargin;
        assertGt(res, 0);
        Position memory p0 = ch.getPosition(alice);
        _roll(50);
        ch.updateFunding(); // F moves; alice's account still holds the old F
        oracle.setStale(true);
        _roll(1);
        vm.recordLogs();
        vm.prank(address(ob));
        assertEq(uint8(ch.settleMakerFill(alice, true, 5e18, 1.9e18)), uint8(IMarginEngine.MakerFillResult.Skip));
        Position memory p1 = ch.getPosition(alice);
        int256 f = ch.fundingState().cumFunding;
        assertTrue(f != p0.lastCumFunding, "funding moved");
        assertEq(p1.size, p0.size, "no fill");
        assertEq(p1.openNotional, p0.openNotional);
        assertEq(p1.lastCumFunding, f, "funding settlement kept");
        assertEq(_acct(alice).reservedOrderMargin, res, "reservation kept");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != IClearingHouse.PositionChanged.selector, "no PositionChanged");
        }
    }

    function test_takerFill_feesAndPositions() public {
        _deposit(alice, 1000e6);
        _deposit(bob, 1000e6);
        ob.mockSetMaker(bob);
        ob.mockSetFillPrice(2e18);
        // Hook order (decision 8): maker fill first, then the taker fill.
        vm.expectEmit(address(ch));
        emit IClearingHouse.PositionChanged(bob, -100e18, -100e18, 2e18, 0, -0.02e18, true);
        vm.expectEmit(address(ch));
        emit IClearingHouse.PositionChanged(alice, 100e18, 100e18, 2e18, 0, 0.1e18, false);
        vm.prank(alice);
        ob.placeMarketOrder(true, 100, 0, 0, false);
        assertEq(ch.getPosition(alice).size, 100e18);
        assertEq(ch.getPosition(bob).size, -100e18);
        assertEq(ch.collateralOf(alice), 999.9e18);
        assertEq(ch.collateralOf(bob), 1000.02e18);
        assertEq(ch.accruedFees(), 0.08e18);
        (uint256 lo, uint256 so) = ch.openInterest();
        assertEq(lo, 100e18);
        assertEq(so, 100e18);
    }

    function test_takerFill_insufficientMarginReverts() public {
        _deposit(alice, 39e6);
        _deposit(bob, 1000e6);
        ob.mockSetMaker(bob);
        ob.mockSetFillPrice(2e18);
        vm.prank(alice);
        vm.expectRevert(IMarginEngine.InsufficientMargin.selector);
        ob.placeMarketOrder(true, 100, 0, 0, false); // IM 40 > 39 − fee
    }

    function test_takerFill_zeroSizeReverts() public {
        vm.prank(address(ob));
        vm.expectRevert(IClearingHouse.ZeroAmount.selector);
        ch.settleTakerFill(alice, true, 0, 0, false);
    }

    function test_takerFill_reduceOnly() public {
        _deposit(alice, 1000e6);
        _deposit(bob, 1000e6);
        _trade(alice, bob, true, 100, 2e18);
        ob.mockSetMaker(bob);
        ob.mockSetFillPrice(2e18);
        vm.startPrank(alice);
        vm.expectRevert(IMarginEngine.ReduceOnlyViolated.selector);
        ob.placeMarketOrder(false, 150, 0, 0, true); // would flip
        vm.expectRevert(IMarginEngine.ReduceOnlyViolated.selector);
        ob.placeMarketOrder(true, 1, 0, 0, true); // would grow
        ob.placeMarketOrder(false, 100, 0, 0, true); // exact close
        vm.stopPrank();
        assertEq(ch.getPosition(alice).size, 0);
        assertEq(ch.getPosition(alice).openNotional, 0);
    }

    /// A voluntary reduction at a price that would leave negative equity is refused (no self-inflicted bad debt).
    function test_takerFill_reductionMayNotCreateBadDebt() public {
        _deposit(alice, 41e6);
        _deposit(bob, 1000e6);
        _trade(alice, bob, true, 100, 2e18); // C 40.9, IM 40
        ob.mockSetMaker(bob);
        ob.mockSetFillPrice(1.5e18); // realize −50
        vm.prank(alice);
        vm.expectRevert(IMarginEngine.InsufficientMargin.selector);
        ob.placeMarketOrder(false, 100, 0, 0, true);
    }

    function test_takerFill_oiAndPositionCaps() public {
        RiskParams memory r = _risk();
        r.maxOpenInterest = 150e18;
        r.maxPositionSize = 100e18;
        vm.prank(owner);
        ch.setRiskParams(r);
        _deposit(alice, 1000e6);
        _deposit(bob, 1000e6);
        _deposit(carol, 1000e6);
        _deposit(keeper, 1000e6);
        _trade(bob, keeper, true, 100, 2e18); // bob long 100, keeper short 100 (OI 100)
        // Taker position cap (maker bob's sell of 101 flips him to −1, within caps).
        ob.mockSetMaker(bob);
        vm.prank(alice);
        vm.expectRevert(IClearingHouse.PositionCapExceeded.selector);
        ob.placeMarketOrder(true, 101, 0, 0, false);
        _trade(alice, bob, true, 100, 2e18); // bob flat, alice long 100 (OI 100)
        // Maker position cap: keeper (short 100) cannot sell more; the book evicts, the taker gets nothing.
        ob.mockSetMaker(keeper);
        vm.prank(carol);
        (uint64 filled,) = ob.placeMarketOrder(true, 10, 0, 0, false);
        assertEq(filled, 0);
        assertEq(ch.getPosition(keeper).size, -100e18);
        // OI cap is checked on the order's net result at the taker fill.
        ob.mockSetMaker(bob);
        vm.prank(carol);
        vm.expectRevert(IClearingHouse.OpenInterestCapExceeded.selector);
        ob.placeMarketOrder(true, 60, 0, 0, false);
        _trade(carol, bob, true, 50, 2e18); // OI 150 = cap is allowed
        (uint256 lo,) = ch.openInterest();
        assertEq(lo, 150e18);
    }

    /// Regression (Phase 2 review): with maker fills settled before the taker fill, a per-fill OI check refused
    /// an increasing maker even when the taker's reduction on the same order keeps OI unchanged, so traders could
    /// not close at the OI cap. OI is now checked once, on the order's net result.
    function test_oiCap_reducingTakerFillsAgainstIncreasingMaker() public {
        RiskParams memory r = _risk();
        r.maxOpenInterest = 150e18;
        r.maxPositionSize = 150e18;
        vm.prank(owner);
        ch.setRiskParams(r);
        _deposit(alice, 1000e6);
        _deposit(bob, 1000e6);
        _deposit(carol, 1000e6);
        _trade(alice, bob, true, 150, 2e18); // OI 150 = cap
        _trade(alice, carol, false, 50, 2e18); // alice closes 50; carol opens long 50
        assertEq(ch.getPosition(alice).size, 100e18);
        assertEq(ch.getPosition(carol).size, 50e18);
        (uint256 lo, uint256 so) = ch.openInterest();
        assertEq(lo, 150e18);
        assertEq(so, 150e18);
        // Admin lowers the cap below current OI: trades that don't raise OI still go through.
        r.maxOpenInterest = 100e18;
        r.maxPositionSize = 100e18;
        vm.prank(owner);
        ch.setRiskParams(r);
        _trade(alice, carol, false, 50, 2e18);
        assertEq(ch.getPosition(carol).size, 100e18);
        (lo,) = ch.openInterest();
        assertEq(lo, 150e18);
        // ...and trades that would raise it are refused (two flat accounts opening = OI 151).
        address dave = address(0xD4E);
        address erin = address(0xE41);
        _deposit(dave, 1000e6);
        _deposit(erin, 1000e6);
        ob.mockSetMaker(erin);
        vm.prank(dave);
        vm.expectRevert(IClearingHouse.OpenInterestCapExceeded.selector);
        ob.placeMarketOrder(true, 1, 0, 0, false);
    }

    /// MATH_SPEC §1.5: both counterparties settle funding at the current F before their size changes.
    function test_fill_settlesBothSidesFirst() public {
        _deposit(alice, 1000e6);
        _deposit(bob, 1000e6);
        _trade(alice, bob, true, 100, 2e18);
        _roll(500);
        int256 pa = _acct(alice).pendingFunding;
        int256 pb = _acct(bob).pendingFunding;
        int256 f = ch.previewFundingState().cumFunding;
        vm.expectEmit(address(ch));
        emit IClearingHouse.FundingSettled(bob, pb, f); // maker hook runs first (decision 8)
        vm.expectEmit(address(ch));
        emit IClearingHouse.FundingSettled(alice, pa, f);
        vm.prank(alice);
        ob.placeMarketOrder(false, 30, 0, 0, false); // maker/price already set by the first _trade
        assertGe(pa + pb, 0);
        assertLe(pa + pb, 2);
        assertEq(ch.getPosition(alice).lastCumFunding, f);
        assertEq(ch.getPosition(bob).lastCumFunding, f);
    }

    // ═══ fees ═══════════════════════════════════════════════════════════════════
    function test_collectFees_roundsDownKeepsRemainder() public {
        _deposit(alice, 1000e6);
        _deposit(bob, 1000e6);
        _trade(alice, bob, true, 100, 2e18); // fees 0.08
        _trade(alice, bob, true, 3, 2.0001e18); // + 0.0003·(5−1)bp … leaves sub-token dust
        uint256 acc = ch.accruedFees();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        ch.collectFees(alice);
        vm.prank(owner);
        vm.expectRevert(IClearingHouse.InvalidParams.selector);
        ch.collectFees(address(0));
        vm.prank(owner);
        uint256 out = ch.collectFees(owner);
        assertEq(out, acc / 1e12);
        assertEq(ausd.balanceOf(owner), out);
        assertEq(ch.accruedFees(), acc - out * 1e12);
    }

    // ═══ views ══════════════════════════════════════════════════════════════════
    function test_getAccount_fields() public {
        _deposit(alice, 100e6);
        _deposit(bob, 1000e6);
        _trade(alice, bob, true, 100, 2e18);
        AccountView memory v = _acct(alice);
        assertEq(v.size, 100e18);
        assertEq(v.collateral, 99.9e18);
        assertEq(v.entryPrice, 2e18);
        assertEq(v.unrealizedPnl, 0);
        assertEq(v.pendingFunding, 0);
        assertEq(v.equity, 99.9e18);
        assertEq(v.initialMargin, 40e18);
        assertEq(v.maintenanceMargin, 20e18);
        // (ON − C)/(q·0.9) = (200 − 99.9)/90 = 1.1122… ↑
        assertEq(v.liquidationPrice, 1_112_222_222_222_222_223);
        assertFalse(v.liquidatable);
        assertFalse(ch.isLiquidatable(alice));
        assertFalse(ch.isLiquidatable(carol));
    }

    function test_markPrice_previewsBookAndIndex() public {
        ob.mockSetBook(20_100, 20_300);
        oracle.setPrice(2.02e18);
        _roll(1);
        uint256 m = ch.markPrice();
        ch.updateFunding();
        assertEq(ch.markPrice(), m, "preview == stored");
        assertGt(m, 1.919e18);
        assertLt(m, 2.121e18);
    }
}
