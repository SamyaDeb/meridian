// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {ClearingHouseBase} from "./ClearingHouseBase.t.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {IClearingHouse} from "../../src/interfaces/IClearingHouse.sol";
import {IMarginEngine} from "../../src/interfaces/IMarginEngine.sol";
import {RiskParams, AccountView} from "../../src/interfaces/MeridianTypes.sol";

/// MATH_SPEC §3.3. Alice opens a 5x long of 100 at 2 (C = 40 after the 0.1 fee); bob is the short.
contract LiquidationTest is ClearingHouseBase {
    function setUp() public override {
        super.setUp();
        _deposit(alice, 40.1e6);
        _deposit(bob, 10_000e6);
        _deposit(keeper, 1000e6);
        _trade(alice, bob, true, 100, 2e18);
        assertEq(ch.collateralOf(alice), 40e18);
    }

    function _drop(uint256 price) internal {
        oracle.setPrice(price);
        _roll(1);
        ch.updateFunding();
    }

    /// Crash demo: 5x long, −15% ⇒ equity 10 < MM 17 ⇒ liquidatable; keeper and IF split the 1% penalty.
    function test_liquidate_fullAfterCrash() public {
        assertFalse(ch.isLiquidatable(alice));
        _drop(1.7e18);
        assertEq(ch.markPrice(), 1.7e18);
        assertTrue(ch.isLiquidatable(alice));
        assertTrue(_acct(alice).liquidatable);
        int256 c0 = ch.collateralOf(alice) - _acct(alice).pendingFunding;
        uint256 if0 = ausd.balanceOf(address(fund));

        vm.expectEmit(address(ch));
        emit IClearingHouse.Liquidated(alice, keeper, 100e18, 1.7e18, 1.7e18, 0.85e18, 0.85e18, 0);
        vm.prank(keeper);
        int256 moved = ch.liquidate(alice, type(uint256).max);

        assertEq(moved, 100e18);
        assertEq(ch.getPosition(alice).size, 0);
        assertEq(ch.getPosition(keeper).size, 100e18);
        assertEq(ch.getPosition(keeper).openNotional, 170e18, "takes over at mark");
        // alice realizes −30 at mark, pays the 1.7 penalty and keeps the rest
        assertEq(ch.collateralOf(alice), c0 - 30e18 - 1.7e18);
        assertEq(ch.collateralOf(keeper), 1000.85e18);
        assertEq(ausd.balanceOf(address(fund)) - if0, 0.85e6, "IF gets the rest");
        (uint256 lo, uint256 so) = ch.openInterest();
        assertEq(lo, 100e18);
        assertEq(so, 100e18);
    }

    function test_liquidate_partial() public {
        _drop(1.7e18);
        vm.prank(keeper);
        int256 moved = ch.liquidate(alice, 30e18);
        assertEq(moved, 30e18);
        assertEq(ch.getPosition(alice).size, 70e18);
        assertEq(ch.getPosition(alice).openNotional, 140e18);
        assertEq(ch.getPosition(keeper).size, 30e18);
        assertEq(ch.collateralOf(keeper), 1000e18 + 0.255e18, "half of 1% of 51");
    }

    function test_liquidate_shortSide() public {
        oracle.setPrice(2.3e18);
        _roll(1);
        ch.updateFunding();
        // bob is short 100 @ 2 with 10k collateral: healthy
        vm.prank(keeper);
        vm.expectRevert(IClearingHouse.NotLiquidatable.selector);
        ch.liquidate(bob, 1e18);
    }

    function test_liquidate_liquidatorReducesOwnShort() public {
        _deposit(carol, 1000e6);
        _trade(carol, keeper, true, 50, 2e18); // keeper short 50
        _drop(1.7e18);
        vm.prank(keeper);
        ch.liquidate(alice, 100e18); // keeper: −50 + 100 = +50
        assertEq(ch.getPosition(keeper).size, 50e18);
        (uint256 lo, uint256 so) = ch.openInterest();
        assertEq(lo, 100e18, "carol 50 + keeper 50 (alice closed)");
        assertEq(lo, so);
    }

    // ═══ bad debt: IF → accrued protocol fees → uncovered (MATH_SPEC §3.3, PHASES 36) ═══

    /// Carol round-trips `lots` against bob at the index: 2 × lots × 2 × (0.05% − 0.01%) of net protocol fees.
    function _accrueFees(uint64 lots) internal {
        _deposit(carol, 10_000e6);
        _trade(carol, bob, true, lots, 2e18);
        _trade(carol, bob, false, lots, 2e18);
    }

    /// −25% ⇒ alice's equity is negative; returns the debt left once her 100 long closes at 1.5.
    function _debtAfterCrash() internal returns (uint256) {
        _drop(1.5e18);
        assertEq(ch.markPrice(), 1.5e18);
        int256 debt = -(ch.collateralOf(alice) - _acct(alice).pendingFunding - 50e18);
        assertGt(debt, 0);
        return uint256(debt);
    }

    function _fundIF(uint256 amountToken) internal {
        ausd.mint(address(this), amountToken);
        ausd.approve(address(fund), amountToken);
        fund.fund(amountToken);
    }

    /// I1 slack over every account of the fixture: balance·1e12 − (ΣC − ΣON − Σpending + fees) ≥ 0.
    function _solvencySlack() internal view returns (int256 liabilities) {
        address[4] memory who = [alice, bob, carol, keeper];
        liabilities = int256(ch.accruedFees());
        for (uint256 i; i < 4; ++i) {
            liabilities += ch.collateralOf(who[i]) - _acct(who[i]).pendingFunding - ch.getPosition(who[i]).openNotional;
        }
        return int256(ausd.balanceOf(address(ch)) * 1e12) - liabilities;
    }

    /// (c) Underwater account: no penalty, IF covers the deficit, account ends at 0, fees untouched (only the
    /// sub-token excess of the ⌈debt⌉ pull is added).
    function test_liquidate_badDebtCoveredByInsurance() public {
        _fundIF(100e6);
        uint256 debt = _debtAfterCrash();
        uint256 fees0 = ch.accruedFees();
        assertGt(fees0, 0);
        uint256 requested = (debt + 1e12 - 1) / 1e12;
        vm.recordLogs();
        vm.prank(keeper);
        ch.liquidate(alice, type(uint256).max);
        assertEq(ch.collateralOf(alice), 0);
        assertEq(ausd.balanceOf(address(fund)), 100e6 - requested);
        assertEq(ch.totalBadDebt(), 0);
        assertEq(ch.accruedFees(), fees0 + requested * 1e12 - debt, "fees untouched");
        assertEq(ch.collateralOf(keeper), 1000e18, "no penalty on an underwater account");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != IClearingHouse.BadDebtSocialized.selector, "IF covered: no event");
        }
    }

    /// (a) IF empty, fees ≥ debt: fees absorb all of it; nothing is socialized.
    function test_liquidate_badDebt_feesAbsorbWhenInsuranceEmpty() public {
        _accrueFees(10_000);
        uint256 debt = _debtAfterCrash();
        uint256 fees0 = ch.accruedFees();
        assertGe(fees0, debt);
        int256 slack0 = _solvencySlack();
        vm.expectEmit(address(ch));
        emit IClearingHouse.BadDebtSocialized(debt, 0, 0);
        vm.prank(keeper);
        ch.liquidate(alice, type(uint256).max);
        assertEq(ch.collateralOf(alice), 0, "fees covered the hole");
        assertEq(ch.accruedFees(), fees0 - debt, "fees reduced by the debt");
        assertEq(ch.totalBadDebt(), 0);
        assertEq(_solvencySlack(), slack0, "I1: -debt on fees, +debt on the account");
    }

    /// (b) IF empty, fees < debt: fees go to 0, only the rest is uncovered.
    function test_liquidate_insuranceEmpty_feesThenSocializes() public {
        uint256 debt = _debtAfterCrash();
        uint256 fees0 = ch.accruedFees();
        assertGt(fees0, 0);
        assertLt(fees0, debt);
        vm.expectEmit(address(ch));
        emit IClearingHouse.BadDebtSocialized(debt, 0, debt - fees0);
        vm.prank(keeper);
        ch.liquidate(alice, type(uint256).max);
        assertEq(ch.accruedFees(), 0, "fees exhausted first");
        assertEq(ch.totalBadDebt(), debt - fees0);
        assertEq(ch.collateralOf(alice), -int256(debt - fees0), "uncovered debt stays on the account (I1)");
        assertEq(_acct(alice).collateral, 0);
    }

    /// IF partial, then fees, then uncovered.
    function test_liquidate_insurancePartial() public {
        _fundIF(4e6);
        uint256 debt = _debtAfterCrash();
        uint256 fees0 = ch.accruedFees();
        vm.expectEmit(address(ch));
        emit IClearingHouse.BadDebtSocialized(debt, 4e18, debt - 4e18 - fees0);
        vm.prank(keeper);
        ch.liquidate(alice, type(uint256).max);
        assertEq(ausd.balanceOf(address(fund)), 0);
        assertEq(ch.accruedFees(), 0);
        assertEq(ch.totalBadDebt(), debt - 4e18 - fees0);
    }

    /// IF partial, fees cover the rest: the event still fires (IF fell short) with uncovered 0.
    function test_liquidate_badDebt_insurancePartialFeesCoverRest() public {
        _accrueFees(10_000);
        _fundIF(4e6);
        uint256 debt = _debtAfterCrash();
        uint256 fees0 = ch.accruedFees();
        vm.expectEmit(address(ch));
        emit IClearingHouse.BadDebtSocialized(debt, 4e18, 0);
        vm.prank(keeper);
        ch.liquidate(alice, type(uint256).max);
        assertEq(ch.collateralOf(alice), 0);
        assertEq(ch.accruedFees(), fees0 - (debt - 4e18));
        assertEq(ch.totalBadDebt(), 0);
    }

    /// (d) After (a), `collectFees` pays only what is left after the debt; users stay whole.
    function test_liquidate_badDebt_collectFeesPaysOnlyRemainder() public {
        _accrueFees(10_000);
        uint256 debt = _debtAfterCrash();
        uint256 fees0 = ch.accruedFees();
        vm.prank(keeper);
        ch.liquidate(alice, type(uint256).max);
        address treasury = makeAddr("treasury");
        vm.prank(owner);
        uint256 paid = ch.collectFees(treasury);
        assertEq(paid, (fees0 - debt) / 1e12);
        assertEq(ausd.balanceOf(treasury), paid);
        assertGe(_solvencySlack(), 0, "I1 after the protocol is paid");
    }

    function test_liquidate_worksWhileStaleAndPaused() public {
        _drop(1.7e18);
        oracle.setStale(true);
        vm.prank(owner);
        ch.setPaused(true);
        _roll(1);
        vm.prank(keeper);
        ch.liquidate(alice, type(uint256).max);
        assertEq(ch.getPosition(keeper).openNotional, 170e18, "last good mark");
    }

    function test_liquidate_reverts() public {
        vm.startPrank(keeper);
        vm.expectRevert(IClearingHouse.NotLiquidatable.selector);
        ch.liquidate(alice, 1e18); // healthy
        vm.expectRevert(IClearingHouse.NotLiquidatable.selector);
        ch.liquidate(carol, 1e18); // flat
        vm.expectRevert(IClearingHouse.ZeroAmount.selector);
        ch.liquidate(alice, 0);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(IClearingHouse.InvalidParams.selector);
        ch.liquidate(alice, 1e18);
    }

    function test_liquidate_liquidatorNeedsMargin() public {
        _drop(1.7e18);
        vm.prank(carol); // no collateral
        vm.expectRevert(IMarginEngine.InsufficientMargin.selector);
        ch.liquidate(alice, 100e18);
    }

    function test_liquidate_liquidatorPositionCap() public {
        RiskParams memory r = _risk();
        r.maxPositionSize = 100e18;
        vm.prank(owner);
        ch.setRiskParams(r);
        _deposit(carol, 1000e6);
        _trade(keeper, carol, true, 50, 2e18); // keeper long 50
        _drop(1.7e18);
        vm.prank(keeper);
        vm.expectRevert(IClearingHouse.PositionCapExceeded.selector);
        ch.liquidate(alice, 60e18);
        vm.prank(keeper);
        ch.liquidate(alice, 50e18);
    }

    function test_liquidationPrice_matchesEligibility() public {
        AccountView memory v = _acct(alice);
        // (200 − 40)/(100·0.9) = 1.7777…8 ↑
        assertEq(v.liquidationPrice, 1_777_777_777_777_777_778);
        _drop(1.78e18);
        assertFalse(ch.isLiquidatable(alice), "just above");
        _drop(1.777e18);
        assertTrue(ch.isLiquidatable(alice), "just below");
    }
}
