// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ClearingHouseBase} from "./ClearingHouseBase.t.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {IClearingHouse} from "../../src/interfaces/IClearingHouse.sol";
import {IMarginEngine} from "../../src/interfaces/IMarginEngine.sol";
import {RiskParams, AccountView} from "../../src/interfaces/PulseTypes.sol";

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

    /// Underwater account: no penalty, IF covers the deficit, account ends at 0.
    function test_liquidate_badDebtCoveredByInsurance() public {
        ausd.mint(address(this), 100e6);
        ausd.approve(address(fund), 100e6);
        fund.fund(100e6);
        _drop(1.5e18);
        assertEq(ch.markPrice(), 1.5e18);
        int256 debt = -(ch.collateralOf(alice) - _acct(alice).pendingFunding - 50e18);
        assertGt(debt, 0);
        vm.prank(keeper);
        ch.liquidate(alice, type(uint256).max);
        assertEq(ch.collateralOf(alice), 0);
        uint256 requested = (uint256(debt) + 1e12 - 1) / 1e12;
        assertEq(ausd.balanceOf(address(fund)), 100e6 - requested);
        assertEq(ch.totalBadDebt(), 0);
        assertEq(ch.collateralOf(keeper), 1000e18, "no penalty on an underwater account");
    }

    function test_liquidate_insuranceEmpty_socializes() public {
        _drop(1.5e18);
        int256 debt = -(ch.collateralOf(alice) - _acct(alice).pendingFunding - 50e18);
        vm.expectEmit(address(ch));
        emit IClearingHouse.BadDebtSocialized(uint256(debt), 0, uint256(debt));
        vm.prank(keeper);
        ch.liquidate(alice, type(uint256).max);
        assertEq(ch.totalBadDebt(), uint256(debt));
        assertEq(ch.collateralOf(alice), -debt, "uncovered debt stays on the account (I1)");
        assertEq(_acct(alice).collateral, 0);
    }

    function test_liquidate_insurancePartial() public {
        ausd.mint(address(this), 4e6);
        ausd.approve(address(fund), 4e6);
        fund.fund(4e6);
        _drop(1.5e18);
        int256 debt = -(ch.collateralOf(alice) - _acct(alice).pendingFunding - 50e18);
        vm.prank(keeper);
        ch.liquidate(alice, type(uint256).max);
        assertEq(ausd.balanceOf(address(fund)), 0);
        assertEq(ch.totalBadDebt(), uint256(debt) - 4e18);
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
