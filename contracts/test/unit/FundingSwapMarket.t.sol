// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {FundingSwapMarket} from "../../src/swaps/FundingSwapMarket.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {MockClearingHouse} from "../../src/mocks/MockClearingHouse.sol";
import {MockOrderBook} from "../../src/mocks/MockOrderBook.sol";
import {IFundingSwapMarket} from "../../src/interfaces/IFundingSwapMarket.sol";
import {IMarginEngine} from "../../src/interfaces/IMarginEngine.sol";
import {IOrderBook} from "../../src/interfaces/IOrderBook.sol";
import {SwapParams, SwapAccountView, FundingParams} from "../../src/interfaces/PulseTypes.sol";

/// @dev Shared fixture: MockClearingHouse (hand-driven F, G, rate) + MockOrderBook (tick 1e14 = 1 bp APR, lot 1,000 MON).
abstract contract FundingSwapBase is Test {
    uint256 constant I = 0.029e18;
    int256 constant YEAR = 365 days;
    uint256 constant TICK = 1e14;
    uint256 constant LOT = 1000e18;
    int256 constant R12 = 3_805_175_038; // 12% APR per second (WAD)
    uint256 constant CAP = 555_555_555_556; // 0.2%/h

    MockERC20 ausd;
    MockOracleAdapter oracle;
    MockClearingHouse ch;
    InsuranceFund fund;
    FundingSwapMarket fs;
    MockOrderBook ob;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    uint256 maturity;

    function _params() internal pure returns (SwapParams memory) {
        return SwapParams({
            aprMoveBuffer: 0.05e18,
            liqHorizonSec: 86_400,
            imMultiplier: 1.5e18,
            takerFeeApr: 0.002e18,
            makerFeeApr: -0.0005e18,
            liqPenalty: 0.2e18,
            keeperShare: 0.5e18,
            maxOpenInterest: 2_000_000e18,
            maxPositionSize: 2_000_000e18
        });
    }

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        vm.roll(1000);
        ausd = new MockERC20("Test AUSD", "tAUSD", 6);
        oracle = new MockOracleAdapter(I);
        fund = new InsuranceFund(address(ausd), owner);
        ch = new MockClearingHouse(address(ausd), address(oracle), address(fund));
        ch.setFundingParams(FundingParams(2e15, 3_472_222_222, CAP, 555_555_556, 300, 0.05e18));
        ch.mockAccrue(0, 0, R12);
        maturity = block.timestamp + 30 days;
        _deploy(maturity);
    }

    function _deploy(uint256 mat) internal {
        fs = new FundingSwapMarket(address(ch), address(ausd), address(fund), uint64(mat), _params(), owner);
        ob = new MockOrderBook(address(fs), TICK, LOT);
        vm.startPrank(owner);
        fs.setOrderBook(address(ob));
        fund.setMarketAuthorized(address(fs), true);
        vm.stopPrank();
    }

    function _deposit(address who, uint256 amountToken) internal {
        ausd.mint(who, amountToken);
        vm.startPrank(who);
        ausd.approve(address(fs), amountToken);
        fs.deposit(amountToken);
        vm.stopPrank();
    }

    /// `taker` trades `lots` against `maker` at fixed APR `aprWad` (price = 1 + APR).
    function _trade(address taker, address maker, bool isBid, uint64 lots, int256 aprWad) internal {
        ob.mockSetMaker(maker);
        ob.mockSetFillPrice(uint256(1e18 + aprWad));
        vm.prank(taker);
        ob.placeMarketOrder(isBid, lots, 0, 0, false);
    }

    /// Perp indices for `sec` seconds at index I and a realized APR: ΔG = I·sec, ΔF = apr·ΔG/(1e18·YEAR).
    function _accrue(int256 aprWad, int256 sec) internal {
        int256 dG = int256(I) * sec;
        ch.mockAccrue(aprWad * dG / (1e18 * YEAR), dG, aprWad / YEAR);
    }

    function _acct(address who) internal view returns (SwapAccountView memory) {
        return fs.getAccount(who);
    }

    function _k(address who) internal view returns (int256) {
        return fs.getPosition(who).fixedAprNotional;
    }
}

contract FundingSwapMarketTest is FundingSwapBase {
    // ═══ constructor / admin ═══════════════════════════════════════════════════
    function test_constructor_state() public view {
        assertEq(fs.perpClearingHouse(), address(ch));
        assertEq(fs.collateralToken(), address(ausd));
        assertEq(fs.insuranceFund(), address(fund));
        assertEq(fs.maturity(), maturity);
        assertEq(fs.orderBook(), address(ob));
        assertEq(fs.timeToMaturity(), 30 days);
        assertFalse(fs.isMatured());
        assertEq(abi.encode(fs.swapParams()), abi.encode(_params()));
    }

    function test_constructor_reverts() public {
        vm.expectRevert(IFundingSwapMarket.InvalidParams.selector);
        new FundingSwapMarket(address(0), address(ausd), address(fund), uint64(maturity), _params(), owner);
        vm.expectRevert(IFundingSwapMarket.InvalidParams.selector);
        new FundingSwapMarket(address(ch), address(ausd), address(fund), uint64(block.timestamp), _params(), owner);
    }

    function test_setOrderBook_onceOnlyOwner() public {
        vm.prank(owner);
        vm.expectRevert(IFundingSwapMarket.AlreadyInitialized.selector);
        fs.setOrderBook(address(ob));
        FundingSwapMarket f2 =
            new FundingSwapMarket(address(ch), address(ausd), address(fund), uint64(maturity), _params(), owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        f2.setOrderBook(address(ob));
        vm.prank(owner);
        vm.expectRevert(IFundingSwapMarket.InvalidParams.selector);
        f2.setOrderBook(address(0));
    }

    function test_setSwapParams_bounds() public {
        SwapParams[10] memory bad;
        for (uint256 i; i < bad.length; ++i) {
            bad[i] = _params();
        }
        bad[0].aprMoveBuffer = 1e18 + 1;
        bad[1].liqHorizonSec = 3599;
        bad[2].liqHorizonSec = 7 days + 1;
        bad[3].imMultiplier = 1e18 - 1;
        bad[4].takerFeeApr = 0.1e18 + 1;
        bad[5].makerFeeApr = 0.002e18 + 1;
        bad[6].liqPenalty = 1e18 + 1;
        bad[7].keeperShare = 1e18 + 1;
        bad[8].maxPositionSize = 0;
        bad[9].maxPositionSize = bad[9].maxOpenInterest + 1;
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(IFundingSwapMarket.InvalidParams.selector);
            fs.setSwapParams(bad[i]);
        }
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        fs.setSwapParams(_params());
        vm.expectEmit(address(fs));
        emit IFundingSwapMarket.SwapParamsUpdated(_params());
        vm.prank(owner);
        fs.setSwapParams(_params());
    }

    function test_hooks_onlyOrderBook() public {
        vm.startPrank(alice);
        vm.expectRevert(IMarginEngine.OnlyOrderBook.selector);
        fs.reserveOrderMargin(alice, true, 1e18, 1.1e18);
        vm.expectRevert(IMarginEngine.OnlyOrderBook.selector);
        fs.releaseOrderMargin(alice, true, 1e18, 1.1e18);
        vm.expectRevert(IMarginEngine.OnlyOrderBook.selector);
        fs.settleMakerFill(alice, true, 1e18, 1.1e18);
        vm.expectRevert(IMarginEngine.OnlyOrderBook.selector);
        fs.settleTakerFill(alice, true, 1e18, 1.1e18, false);
        vm.stopPrank();
    }

    // ═══ collateral ════════════════════════════════════════════════════════════
    function test_depositWithdraw_units() public {
        _deposit(alice, 1234.567891e6);
        assertEq(fs.collateralOf(alice), 1234.567891e18);
        vm.prank(alice);
        fs.withdraw(1234.567891e6);
        assertEq(ausd.balanceOf(alice), 1234.567891e6);
        vm.expectRevert(IFundingSwapMarket.ZeroAmount.selector);
        vm.prank(alice);
        fs.deposit(0);
        vm.expectRevert(IFundingSwapMarket.ZeroAmount.selector);
        vm.prank(alice);
        fs.withdraw(0);
        vm.expectRevert(IFundingSwapMarket.InvalidParams.selector);
        fs.depositFor(address(0), 1);
    }

    function test_withdraw_keepsInitialMargin() public {
        _deposit(alice, 5000e6);
        _deposit(bob, 5000e6);
        _trade(alice, bob, true, 1000, 0.12e18);
        uint256 im = _acct(alice).initialMargin;
        uint256 free = (uint256(fs.collateralOf(alice)) - im) / 1e12;
        vm.prank(alice);
        vm.expectRevert(IMarginEngine.InsufficientMargin.selector);
        fs.withdraw(free + 2);
        vm.prank(alice);
        fs.withdraw(free - 2);
    }

    // ═══ MATH_SPEC §6.6 worked examples through the market ═════════════════════
    function test_6_6_long30d_plus143() public {
        _deposit(alice, 5000e6);
        _deposit(bob, 5000e6);
        _trade(alice, bob, true, 1000, 0.12e18); // alice long 1,000,000 MON at 12%
        assertEq(fs.getPosition(alice).size, 1_000_000e18);
        assertEq(_k(alice), 120_000e18, "K = q*A");
        assertEq(_k(alice) + _k(bob), 0, "sum K = 0");
        (uint256 lo, uint256 so) = fs.openInterest();
        assertEq(lo, 1_000_000e18);
        assertEq(so, 1_000_000e18);
        int256 a0 = fs.collateralOf(alice);
        int256 b0 = fs.collateralOf(bob);
        _accrue(0.18e18, 30 days); // realized 18% over 30 days, I constant
        assertApproxEqAbs(_acct(alice).accruedNet, 143.0137e18, 0.001e18, "preview");
        fs.settle(alice);
        fs.settle(bob);
        int256 na = fs.collateralOf(alice) - a0;
        int256 nb = fs.collateralOf(bob) - b0;
        assertApproxEqAbs(na, 143.0137e18, 0.001e18, "MATH_SPEC 6.6: +143.01 AUSD");
        assertLe(na + nb, 0, "dust to the protocol");
        assertGe(na + nb, -2, "at most 1 wei per settlement");
    }

    function test_6_6_initialMarginAtInception() public {
        _deposit(alice, 5000e6);
        _deposit(bob, 5000e6);
        _trade(alice, bob, true, 1000, 0.12e18);
        SwapAccountView memory v = _acct(alice);
        // MATH_SPEC §6.4: MM ≈ 5.24%, IM ≈ 7.87% of 29,000 notional
        assertApproxEqRel(v.maintenanceMargin, 1520.8e18, 0.002e18, "MM 5.24%");
        assertApproxEqRel(v.initialMargin, 2281.2e18, 0.002e18, "IM 7.87%");
        assertApproxEqAbs(v.avgFixedApr, 0.12e18, 1);
        assertFalse(v.liquidatable);
    }

    function test_6_6_offsetLocksSpread() public {
        _deposit(alice, 5000e6);
        _deposit(bob, 5000e6);
        _deposit(carol, 5000e6);
        _trade(alice, bob, true, 1000, 0.12e18);
        _accrue(0.18e18, 10 days);
        _trade(alice, carol, false, 1000, 0.15e18); // alice sells 1M at 15% to carol
        assertEq(fs.getPosition(alice).size, 0);
        assertEq(_k(alice), -30_000e18, "K = 1e6*(0.12 - 0.15)");
        assertEq(_k(alice) + _k(bob) + _k(carol), 0);
        SwapAccountView memory v = _acct(alice);
        assertEq(v.maintenanceMargin, 0, "positive locked stream is never liquidated");
        assertGt(v.unrealizedPnl, 0);
        int256 a0 = fs.collateralOf(alice);
        _accrue(0.4e18, 20 days); // the floating path no longer matters for alice
        fs.settle(alice);
        assertApproxEqAbs(fs.collateralOf(alice) - a0, 47.67e18, 0.01e18, "locked +47.7 AUSD over 20 d");
    }

    // ═══ fees (MATH_SPEC §6.5) ═════════════════════════════════════════════════
    function test_fees_aprTime() public {
        _deposit(alice, 5000e6);
        _deposit(bob, 5000e6);
        _trade(alice, bob, true, 1000, 0.12e18);
        // taker: 1e24 · 0.029 · 0.2% · 30/365 ↑ ; maker rebate 0.05% ↓
        uint256 takerFee = 4.767123287671232877e18; // 4.7671232876712328767… rounded up
        uint256 rebate = 1.191780821917808219e18;
        assertEq(uint256(5000e18 - fs.collateralOf(alice)), takerFee, "taker fee");
        assertEq(uint256(fs.collateralOf(bob) - 5000e18), rebate, "maker rebate");
        assertEq(fs.accruedFees(), takerFee - rebate);
        uint256 before = ausd.balanceOf(owner);
        vm.prank(owner);
        uint256 got = fs.collectFees(owner);
        assertEq(got, (takerFee - rebate) / 1e12);
        assertEq(ausd.balanceOf(owner) - before, got);
    }

    // ═══ order reservations ════════════════════════════════════════════════════
    function test_reserveAndRelease() public {
        _deposit(alice, 5000e6);
        vm.prank(alice);
        ob.placeLimitOrder(true, 11_200, 1000, 0); // bid 1M at 12%
        SwapAccountView memory v = _acct(alice);
        assertGt(v.reservedOrderMargin, 2200e18);
        assertEq(v.initialMargin, v.reservedOrderMargin);
        vm.prank(alice);
        vm.expectRevert(IMarginEngine.InsufficientMargin.selector);
        ob.placeLimitOrder(true, 11_200, 1000, 0);
        vm.prank(alice);
        ob.cancelOrder(1);
        assertEq(_acct(alice).reservedOrderMargin, 0);
        vm.prank(alice);
        fs.withdraw(5000e6);
    }

    function test_reserve_pausedAndMaturedRevert() public {
        _deposit(alice, 5000e6);
        vm.prank(owner);
        fs.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(IFundingSwapMarket.Paused.selector);
        ob.placeLimitOrder(true, 11_200, 1, 0);
        vm.prank(owner);
        fs.setPaused(false);
        vm.warp(maturity);
        vm.prank(alice);
        vm.expectRevert(IFundingSwapMarket.Matured.selector);
        ob.placeLimitOrder(true, 11_200, 1, 0);
    }

    // ═══ fills: eviction, caps, pause, reduce-only ════════════════════════════
    function test_makerWithoutMarginIsEvicted() public {
        _deposit(alice, 5000e6);
        vm.recordLogs();
        _trade(alice, bob, true, 1000, 0.12e18); // bob has no collateral
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool evicted;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IOrderBook.OrderEvicted.selector) evicted = true;
        }
        assertTrue(evicted);
        assertEq(fs.getPosition(alice).size, 0);
        assertEq(fs.getPosition(bob).size, 0);
    }

    function test_takerInsufficientMarginReverts() public {
        _deposit(alice, 100e6);
        _deposit(bob, 5000e6);
        ob.mockSetMaker(bob);
        ob.mockSetFillPrice(1.12e18);
        vm.prank(alice);
        vm.expectRevert(IMarginEngine.InsufficientMargin.selector);
        ob.placeMarketOrder(true, 1000, 0, 0, false);
    }

    function test_caps_positionAndOpenInterest() public {
        SwapParams memory p = _params();
        p.maxPositionSize = 1_500_000e18;
        p.maxOpenInterest = 1_500_000e18;
        vm.prank(owner);
        fs.setSwapParams(p);
        _deposit(alice, 20_000e6);
        _deposit(bob, 20_000e6);
        _deposit(carol, 20_000e6);
        _deposit(dave, 20_000e6);
        _trade(alice, bob, true, 1000, 0.12e18);
        // taker breach (maker carol stays within the cap)
        ob.mockSetMaker(carol);
        ob.mockSetFillPrice(1.12e18);
        vm.prank(alice);
        vm.expectRevert(IFundingSwapMarket.PositionCapExceeded.selector);
        ob.placeMarketOrder(true, 600, 0, 0, false);
        // maker breach: bob (short 1M) selling 600 more is refused ⇒ evicted, carol's minFilled reverts the order
        ob.mockSetMaker(bob);
        vm.prank(carol);
        vm.expectRevert(IOrderBook.SlippageExceeded.selector);
        ob.placeMarketOrder(true, 600, 0, 1, false);
        // OI cap on the order's net result at the taker fill (makers are never OI-checked)
        ob.mockSetMaker(dave);
        vm.prank(carol);
        vm.expectRevert(IFundingSwapMarket.OpenInterestCapExceeded.selector);
        ob.placeMarketOrder(true, 1000, 0, 0, false);
        // admin lowers the cap below OI: reductions still work
        p.maxOpenInterest = 500_000e18;
        p.maxPositionSize = 500_000e18;
        vm.prank(owner);
        fs.setSwapParams(p);
        _trade(alice, bob, false, 500, 0.12e18);
        assertEq(fs.getPosition(alice).size, 500_000e18);
    }

    function test_paused_blocksIncreasesAllowsReductions() public {
        _deposit(alice, 5000e6);
        _deposit(bob, 5000e6);
        _trade(alice, bob, true, 1000, 0.12e18);
        vm.prank(owner);
        fs.setPaused(true);
        ob.mockSetMaker(bob);
        ob.mockSetFillPrice(1.12e18);
        vm.prank(alice);
        vm.expectRevert(); // bob's increase is refused ⇒ skipped (CR-007), minFilled 1 reverts; or alice's increase reverts
        ob.placeMarketOrder(true, 100, 0, 1, false);
        _trade(alice, bob, false, 400, 0.12e18); // both reduce
        assertEq(fs.getPosition(alice).size, 600_000e18);
    }

    /// CR-007: paused ⇒ Skip (nothing written for the fill, reservation kept, ΣK / Σq / OI unchanged);
    /// a reducing maker still fills while paused.
    function test_makerFill_pausedSkips() public {
        _deposit(alice, 5000e6);
        _deposit(bob, 5000e6);
        _trade(alice, bob, true, 1000, 0.12e18); // alice long, bob short
        vm.prank(alice);
        ob.placeLimitOrder(true, 11_200, 500, 0);
        uint256 res = _acct(alice).reservedOrderMargin;
        assertGt(res, 0);
        vm.prank(owner);
        fs.setPaused(true);
        (uint256 lo0, uint256 so0) = fs.openInterest();
        (int256 qa, int256 ka, int256 kb) = (fs.getPosition(alice).size, _k(alice), _k(bob));
        vm.prank(address(ob));
        assertEq(uint8(fs.settleMakerFill(alice, true, 100e18, 1.12e18)), uint8(IMarginEngine.MakerFillResult.Skip));
        assertEq(fs.getPosition(alice).size, qa);
        assertEq(_k(alice), ka, "K unchanged");
        assertEq(_k(bob), kb);
        assertEq(_acct(alice).reservedOrderMargin, res, "reservation kept");
        (uint256 lo1, uint256 so1) = fs.openInterest();
        assertEq(lo1, lo0);
        assertEq(so1, so0);
        // the taker of an order whose only maker skipped is never settled (book: filled == 0), so ΣK = 0 holds;
        // a reducing maker still fills while paused
        vm.prank(address(ob));
        assertEq(uint8(fs.settleMakerFill(alice, false, 100e18, 1.12e18)), uint8(IMarginEngine.MakerFillResult.Filled));
    }

    /// CR-007: matured ⇒ Evict (permanent: a matured order can never fill again), also when paused (maturity is
    /// checked first).
    function test_makerFill_maturedEvicts() public {
        _deposit(alice, 5000e6);
        vm.warp(maturity);
        vm.prank(address(ob));
        assertEq(uint8(fs.settleMakerFill(alice, true, 100e18, 1.12e18)), uint8(IMarginEngine.MakerFillResult.Evict));
        vm.prank(owner);
        fs.setPaused(true);
        vm.prank(address(ob));
        assertEq(uint8(fs.settleMakerFill(alice, true, 100e18, 1.12e18)), uint8(IMarginEngine.MakerFillResult.Evict));
        assertEq(fs.getPosition(alice).size, 0);
    }

    /// CR-007: margin / caps ⇒ Evict (unpaused, not matured).
    function test_makerFill_marginEvicts() public {
        vm.prank(address(ob));
        assertEq(uint8(fs.settleMakerFill(carol, true, 1000e18, 1.12e18)), uint8(IMarginEngine.MakerFillResult.Evict));
        _deposit(alice, 1_000_000e6);
        vm.prank(address(ob));
        assertEq(
            uint8(fs.settleMakerFill(alice, true, _params().maxPositionSize + 1, 1.12e18)),
            uint8(IMarginEngine.MakerFillResult.Evict),
            "position cap"
        );
    }

    function test_reduceOnly() public {
        _deposit(alice, 5000e6);
        _deposit(bob, 5000e6);
        ob.mockSetMaker(bob);
        ob.mockSetFillPrice(1.12e18);
        vm.prank(alice);
        vm.expectRevert(IMarginEngine.ReduceOnlyViolated.selector);
        ob.placeMarketOrder(true, 10, 0, 0, true);
    }

    // ═══ markApr (MATH_SPEC §6.3) ══════════════════════════════════════════════
    function test_markApr_medianAndClamp() public {
        int256 realized = R12 * YEAR; // ≈ 12%
        assertEq(fs.markApr(), realized, "no book, no trade: realized");
        ob.mockSetBook(11_500, 11_700); // mid 16%
        assertEq(fs.markApr(), realized, "median(A, B, A) = A");
        ob.mockSetLastTrade(1.2e18, uint64(block.number)); // 20%, printed this block: not an input yet (B-01)
        assertEq(fs.markApr(), realized, "same-block trade is not a mark input");
        vm.roll(block.number + 1); // one block later it counts
        assertEq(fs.markApr(), 0.16e18, "median(12, 16, 20) = 16");
        vm.roll(block.number + 101);
        assertEq(fs.markApr(), realized, "stale trade ignored");
        ob.mockSetBook(20_000, 20_200); // mid 101%
        ob.mockSetLastTrade(2.2e18, uint64(block.number)); // 120%
        vm.roll(block.number + 1); // a trade only counts from the next block (B-01)
        assertEq(fs.markApr(), realized + 0.5e18, "clamped to realized + 50 APR points");
        assertEq(fs.realizedApr(96_000), realized);
    }

    // ═══ liquidation (MATH_SPEC §6.4) ══════════════════════════════════════════
    function _underwaterLong(int256 newApr) internal {
        _deposit(alice, 2400e6);
        _deposit(bob, 20_000e6);
        _deposit(dave, 10_000e6);
        vm.prank(address(this));
        _trade(alice, bob, true, 1000, 0.12e18);
        vm.roll(block.number + 101); // the 12% trade leaves the mark inputs
        ch.mockAccrue(0, 0, newApr / YEAR);
        _convergeMark(newApr);
    }

    /// B-01: the mark follows a regime change by at most MARK_MAX_STEP_PER_BLOCK × MARK_MAX_ELAPSED_BLOCKS (10 APR
    /// points) per touched refresh, so a keeper touches the market (`settle` of a flat account) while it waits:
    /// one refresh per 10 points of distance from the 12% trade, plus two spare.
    function _convergeMark(int256 targetApr) internal {
        int256 dist = targetApr > 0.12e18 ? targetApr - 0.12e18 : 0.12e18 - targetApr;
        uint256 refreshes = uint256(dist) / 0.1e18 + 2;
        for (uint256 i; i < refreshes; ++i) {
            vm.roll(block.number + 20);
            fs.settle(dave);
        }
    }

    function test_liquidation_transfersPositionValueAndPenalty() public {
        _underwaterLong(-0.5e18);
        vm.prank(dave);
        vm.expectRevert(IFundingSwapMarket.InvalidParams.selector);
        fs.liquidate(dave, 1);
        SwapAccountView memory v = _acct(alice);
        assertTrue(v.liquidatable);
        int256 vx = v.unrealizedPnl; // whole position moves: V_x = V
        uint256 mmx = v.maintenanceMargin;
        int256 c0 = fs.collateralOf(alice);
        int256 d0 = fs.collateralOf(dave);
        uint256 if0 = ausd.balanceOf(address(fund));
        int256 kAlice = _k(alice);
        vm.prank(dave);
        int256 moved = fs.liquidate(alice, type(uint256).max);
        assertEq(moved, 1_000_000e18);
        assertEq(fs.getPosition(alice).size, 0);
        assertEq(_k(alice), 0);
        assertEq(fs.getPosition(dave).size, 1_000_000e18);
        assertEq(_k(dave), kAlice, "K moves with the position");
        assertEq(_k(bob) + _k(dave), 0, "sum K = 0");
        uint256 penalty = (mmx * 0.2e18 + 1e18 - 1) / 1e18;
        uint256 keeper = penalty / 2;
        assertEq(fs.collateralOf(alice), c0 + vx - int256(penalty), "liquidatee: +V_x - penalty");
        assertEq(fs.collateralOf(dave), d0 - vx + int256(keeper), "liquidator: -V_x + keeper share");
        assertEq(ausd.balanceOf(address(fund)) - if0, (penalty - keeper) / 1e12, "IF gets the rest");
        (uint256 lo, uint256 so) = fs.openInterest();
        assertEq(lo, so);
    }

    function test_liquidation_notLiquidatable() public {
        _deposit(alice, 5000e6);
        _deposit(bob, 5000e6);
        _deposit(dave, 10_000e6);
        _trade(alice, bob, true, 1000, 0.12e18);
        vm.prank(dave);
        vm.expectRevert(IFundingSwapMarket.NotLiquidatable.selector);
        fs.liquidate(alice, type(uint256).max);
        vm.prank(dave);
        vm.expectRevert(IFundingSwapMarket.ZeroAmount.selector);
        fs.liquidate(alice, 0);
    }

    function test_liquidation_partial() public {
        _underwaterLong(-0.5e18);
        vm.prank(dave);
        fs.liquidate(alice, 400_000e18);
        assertEq(fs.getPosition(alice).size, 600_000e18);
        assertEq(_k(alice), 72_000e18, "K*x/|q| moved");
        assertEq(_k(dave), 48_000e18);
        assertEq(_k(alice) + _k(bob) + _k(dave), 0);
    }

    // ═══ bad debt: IF → accrued protocol fees → uncovered (MATH_SPEC §6.4, PHASES 36) ═══

    /// Debt left once alice's whole position (and K) moves at the mark: −equity (no penalty when underwater).
    function _swapDebt() internal view returns (uint256) {
        int256 eq = _acct(alice).equity;
        assertLt(eq, 0);
        return uint256(-eq);
    }

    /// −3 APR: a deep hole (≈ 5,000 AUSD), far above the ≈ 3.6 of fees from the 12% trade.
    function _deepHole() internal {
        _underwaterLong(-3e18);
        _deposit(dave, 10_000e6);
    }

    /// Alice tops up all but 1–2 AUSD of the hole, so the ≈ 3.6 of accrued fees can cover the rest.
    function _shallowHole() internal {
        _deepHole();
        _deposit(alice, _swapDebt() / 1e12 - 1e6);
        uint256 debt = _swapDebt();
        assertGt(debt, 1e18);
        assertLe(debt, 2e18);
    }

    /// (c) IF covers all: account at 0, fees untouched (only the sub-token excess of the ⌈debt⌉ pull is added).
    function test_liquidation_badDebtCoveredByInsurance() public {
        ausd.mint(address(this), 20_000e6);
        ausd.approve(address(fund), 20_000e6);
        fund.fund(20_000e6);
        _deepHole();
        uint256 debt = _swapDebt();
        uint256 fees0 = fs.accruedFees();
        assertGt(fees0, 0);
        vm.prank(dave);
        fs.liquidate(alice, type(uint256).max);
        assertEq(fs.collateralOf(alice), 0, "IF covered the hole");
        assertEq(fs.totalBadDebt(), 0);
        uint256 requested = (debt + 1e12 - 1) / 1e12;
        assertEq(ausd.balanceOf(address(fund)), 20_000e6 - requested);
        assertEq(fs.accruedFees(), fees0 + requested * 1e12 - debt, "fees untouched");
    }

    /// (b) IF empty, fees < debt: fees go to 0 first, only the rest stays negative / in totalBadDebt.
    function test_liquidation_badDebtUncoveredStaysNegative() public {
        _deepHole();
        uint256 debt = _swapDebt();
        uint256 fees0 = fs.accruedFees();
        assertGt(fees0, 0);
        assertLt(fees0, debt);
        vm.prank(dave);
        fs.liquidate(alice, type(uint256).max);
        assertEq(fs.accruedFees(), 0, "fees exhausted first");
        assertEq(fs.totalBadDebt(), debt - fees0);
        assertEq(fs.collateralOf(alice), -int256(debt - fees0));
        _deposit(alice, 10_000e6); // a later deposit repays it first
        assertGt(fs.collateralOf(alice), 0);
    }

    /// (a) IF empty, fees ≥ debt: fees absorb all of it; nothing is socialized.
    function test_liquidation_badDebt_feesAbsorbWhenInsuranceEmpty() public {
        _shallowHole();
        uint256 debt = _swapDebt();
        uint256 fees0 = fs.accruedFees();
        assertGe(fees0, debt);
        vm.prank(dave);
        fs.liquidate(alice, type(uint256).max);
        assertEq(fs.collateralOf(alice), 0, "fees covered the hole");
        assertEq(fs.accruedFees(), fees0 - debt, "fees reduced by the debt");
        assertEq(fs.totalBadDebt(), 0);
    }

    /// (d) After (a), `collectFees` pays only what is left after the debt.
    function test_liquidation_badDebt_collectFeesPaysOnlyRemainder() public {
        _shallowHole();
        uint256 debt = _swapDebt();
        uint256 fees0 = fs.accruedFees();
        vm.prank(dave);
        fs.liquidate(alice, type(uint256).max);
        address treasury = makeAddr("treasury");
        vm.prank(owner);
        uint256 paid = fs.collectFees(treasury);
        assertEq(paid, (fees0 - debt) / 1e12);
        assertEq(ausd.balanceOf(treasury), paid);
    }

    // ═══ maturity (1-hour maturity) ════════════════════════════════════════════
    function test_maturity_oneHour() public {
        _deploy(block.timestamp + 1 hours);
        _deposit(alice, 5000e6);
        _deposit(bob, 5000e6);
        _trade(alice, bob, true, 1000, 0.12e18);
        vm.expectRevert(IFundingSwapMarket.NotMatured.selector);
        fs.settleMaturity();
        _accrue(0.18e18, 1 hours);
        vm.warp(block.timestamp + 1 hours);
        assertTrue(fs.isMatured());
        assertEq(fs.timeToMaturity(), 0);
        (int256 f, int256 g,) = ch.latestObservation();
        vm.expectEmit(address(fs));
        emit IFundingSwapMarket.MaturitySettled(f, g, uint64(block.number));
        fs.settleMaturity();
        fs.settleMaturity(); // idempotent
        fs.settle(alice);
        int256 a1 = fs.collateralOf(alice);
        assertGt(a1, 5000e18 - 1e18, "accrued the 18% vs 12% hour");
        _accrue(5e18, 10 days); // after the snapshot nothing accrues
        fs.settle(alice);
        assertEq(fs.collateralOf(alice), a1, "frozen after maturity");
        SwapAccountView memory v = _acct(alice);
        assertEq(v.maintenanceMargin, 0);
        assertEq(v.unrealizedPnl, 0);
        // increases refused (taker reverts, maker evicted), reductions allowed, everything withdrawable
        _deposit(carol, 1000e6);
        ob.mockSetMaker(bob); // bob (short) buys back = reduces
        ob.mockSetFillPrice(1.12e18);
        vm.prank(carol);
        vm.expectRevert(IFundingSwapMarket.Matured.selector);
        ob.placeMarketOrder(false, 1, 0, 0, false); // carol would open a short
        ob.mockSetMaker(carol); // carol as maker would open a short: evicted
        vm.prank(alice);
        vm.expectRevert(IOrderBook.SlippageExceeded.selector);
        ob.placeMarketOrder(true, 1, 0, 1, false);
        _trade(alice, bob, false, 1000, 0.1e18);
        assertEq(fs.getPosition(alice).size, 0);
        fs.settle(bob); // accrual first: the withdrawable amount is the settled collateral
        uint256 all = uint256(fs.collateralOf(bob)) / 1e12; // read before the prank (it would consume it)
        vm.prank(bob);
        fs.withdraw(all);
        assertLt(fs.collateralOf(bob), 1e12, "all but sub-token dust withdrawn after maturity");
    }

    function test_maturity_lazySnapshotOnFirstTouch() public {
        _deploy(block.timestamp + 1 hours);
        _deposit(alice, 5000e6);
        _deposit(bob, 5000e6);
        _trade(alice, bob, true, 1000, 0.12e18);
        _accrue(0.18e18, 1 hours);
        vm.warp(block.timestamp + 1 hours + 5);
        vm.recordLogs();
        fs.settle(alice); // no explicit settleMaturity: the first touch snapshots
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool snapped;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IFundingSwapMarket.MaturitySettled.selector) snapped = true;
        }
        assertTrue(snapped);
        (bool s,,) = fs.maturitySnapshot();
        assertTrue(s);
        int256 a1 = fs.collateralOf(alice);
        _accrue(1e18, 1 days);
        fs.settle(bob);
        fs.settle(alice);
        assertEq(fs.collateralOf(alice), a1);
    }
}
