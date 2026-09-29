// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {FundingSwapMarket} from "../../src/swaps/FundingSwapMarket.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {SwapMathLib} from "../../src/libs/SwapMathLib.sol";
import {RiskParams, FundingParams, SwapParams, SwapAccountView} from "../../src/interfaces/PulseTypes.sol";

/// @notice FundingSwapMarket on the REAL perp ClearingHouse + a SECOND real OrderBook (tick 1e14 = 1 bp APR,
///         lot 1,000 MON), MATH_SPEC defaults, thousands of blocks of real per-block funding.
contract FundingSwapIntegrationTest is Test {
    uint256 constant I0 = 0.029e18;
    uint32 constant MID0 = 29_000; // perp tick (1e12) of 0.029
    uint32 constant APR12 = 11_200; // swap tick (1e14) of 1.12 = 12% APR
    int256 constant YEAR = 365 days;

    MockERC20 ausd;
    MockOracleAdapter oracle;
    InsuranceFund fund;
    ClearingHouse ch;
    OrderBook ob;
    FundingSwapMarket fs;
    OrderBook sob;
    address owner = makeAddr("owner");
    address mm = makeAddr("mm");
    address sam = makeAddr("sam"); // swap market maker
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");
    uint64[] perpIds;

    function setUp() public {
        vm.roll(1_000_000);
        vm.warp(1_790_000_000);
        ausd = new MockERC20("Test AUSD", "tAUSD", 6);
        oracle = new MockOracleAdapter(I0);
        fund = new InsuranceFund(address(ausd), owner);
        ch = new ClearingHouse(
            address(ausd),
            address(oracle),
            address(fund),
            RiskParams(0.2e18, 0.1e18, 0.0005e18, -0.0001e18, 0.01e18, 0.5e18, 250_000e18, 25_000e18),
            FundingParams(0.002e18, 3_472_222_222, 555_555_555_556, 555_555_556, 300, 0.05e18),
            owner
        );
        ob = new OrderBook(address(ch), 1e12, 100e18);
        _deploySwaps(block.timestamp + 30 days);
        vm.startPrank(owner);
        ch.setOrderBook(address(ob));
        fund.setMarketAuthorized(address(ch), true);
        vm.stopPrank();
        _perpFund(mm, 100_000e6);
        _quotePerp(MID0);
    }

    function _deploySwaps(uint256 maturity) internal {
        fs = new FundingSwapMarket(
            address(ch),
            address(ausd),
            address(fund),
            uint64(maturity),
            SwapParams(0.05e18, 86_400, 1.5e18, 0.002e18, -0.0005e18, 0.2e18, 0.5e18, 2_000_000e18, 200_000e18 * 10),
            owner
        );
        sob = new OrderBook(address(fs), 1e14, 1000e18);
        vm.startPrank(owner);
        fs.setOrderBook(address(sob));
        fund.setMarketAuthorized(address(fs), true);
        vm.stopPrank();
    }

    // ─── helpers ──────────────────────────────────────────────────────────────
    function _perpFund(address who, uint256 amt) internal {
        ausd.mint(who, amt);
        vm.startPrank(who);
        ausd.approve(address(ch), amt);
        ch.deposit(amt);
        vm.stopPrank();
    }

    function _swapFund(address who, uint256 amt) internal {
        ausd.mint(who, amt);
        vm.startPrank(who);
        ausd.approve(address(fs), amt);
        fs.deposit(amt);
        vm.stopPrank();
    }

    /// The perp MM quotes 3×3 around `mid` (100 lots, 10 ticks apart); cancels its previous quotes first.
    function _quotePerp(uint32 mid) internal {
        vm.startPrank(mm);
        for (uint256 i; i < perpIds.length; ++i) {
            if (ob.getOrder(perpIds[i]).remainingLots != 0) ob.cancelOrder(perpIds[i]);
        }
        delete perpIds;
        for (uint32 i = 1; i <= 3; ++i) {
            (uint64 b,) = ob.placeLimitOrder(true, mid - 10 * i, 100, 0);
            (uint64 a,) = ob.placeLimitOrder(false, mid + 10 * i, 100, 0);
            perpIds.push(b);
            perpIds.push(a);
        }
        vm.stopPrank();
    }

    /// n blocks of ~300 ms with a keeper funding poke every 20 blocks.
    function _run(uint256 n) internal {
        for (uint256 done; done < n; done += 20) {
            vm.roll(block.number + 20);
            vm.warp(block.timestamp + 6);
            ch.updateFunding();
        }
    }

    function _collateral(address who) internal view returns (int256) {
        return fs.collateralOf(who);
    }

    // ═══ accrual = MATH_SPEC §6.2 from the perp's own F and G ═════════════════
    function test_accrual_equalsFormulaFromPerpIndices() public {
        _swapFund(sam, 100_000e6);
        _swapFund(alice, 10_000e6);
        vm.prank(sam);
        sob.placeLimitOrder(false, APR12, 1000, 0); // sam asks 1,000,000 MON at 12%
        vm.prank(alice);
        sob.placeMarketOrder(true, 1000, APR12, 1000, false);
        assertEq(fs.getPosition(alice).size, 1_000_000e18);
        assertEq(fs.getPosition(alice).fixedAprNotional + fs.getPosition(sam).fixedAprNotional, 0, "sum K");
        // a perp long of 1,000 MON pays q·ΔF over the same blocks: the swap's floating leg per MON is the same ΔF
        _perpFund(bob, 1000e6);
        vm.prank(bob);
        ob.placeMarketOrder(true, 10, MID0 + 10, 10, false);

        int256 f0 = fs.getPosition(alice).lastCumFunding;
        int256 g0 = fs.getPosition(alice).lastCumIndexTime;
        int256 c0 = _collateral(alice);
        int256 k = fs.getPosition(alice).fixedAprNotional;
        _run(12_000); // 1 hour of per-block funding (interest 10.95%, premium ≈ 0)
        fs.settle(alice);
        int256 f1 = fs.getPosition(alice).lastCumFunding;
        int256 g1 = fs.getPosition(alice).lastCumIndexTime;
        (int256 fNow, int256 gNow,) = ch.latestObservation();
        assertEq(f1, fNow, "settled at the perp's F");
        assertEq(g1, gNow, "settled at the perp's G");
        int256 net = _collateral(alice) - c0;
        assertEq(net, SwapMathLib.net(1_000_000e18, k, f1 - f0, g1 - g0), "MATH_SPEC 6.2 exactly");
        // floating ≈ 10.95% vs fixed 12% ⇒ alice pays ≈ 1.05% APR on 29,000 for 1 h ≈ 0.0348 AUSD
        int256 apr = ch.averageFundingApr(12_000);
        int256 expected = int256(I0) * 1_000_000 * (apr - 0.12e18) / 1e18 * 3600 / YEAR;
        assertApproxEqRel(net, expected, 0.01e18, "net = q*I*(realized - fixed)*dt/YEAR");
        // floating leg per MON = the perp long's funding per MON (same F), to the wei
        ch.settleFunding(bob);
        int256 floatingPer1000 = 1000e18 * (f1 - f0) / 1e18;
        assertApproxEqAbs(
            floatingPer1000, int256(1000e6 * 1e12) - ch.collateralOf(bob) - _bobFee(), 1, "perp long pays q*dF"
        );
    }

    /// bob's taker fee on the perp open (10 lots at the best ask, 5 bps ↑): 1000 MON · price · 0.0005.
    function _bobFee() internal pure returns (int256) {
        uint256 notional = 1000e18 * (uint256(MID0) + 10) * 1e12 / 1e18;
        return int256((notional * 0.0005e18 + 1e18 - 1) / 1e18);
    }

    // ═══ one order across several makers: taker K = −Σ maker kDelta (ΣK = 0) ═══
    function test_multiMakerSweep_sumKZero() public {
        address[3] memory makers = [sam, makeAddr("m2"), makeAddr("m3")];
        uint32[3] memory ticks = [uint32(11_150), 11_175, 11_213];
        for (uint256 i; i < 3; ++i) {
            _swapFund(makers[i], 50_000e6);
            vm.prank(makers[i]);
            sob.placeLimitOrder(false, ticks[i], 7, 0);
        }
        _swapFund(alice, 20_000e6);
        vm.prank(alice);
        sob.placeMarketOrder(true, 21, 11_300, 21, false);
        int256 sumK = fs.getPosition(alice).fixedAprNotional;
        int256 sumQ = fs.getPosition(alice).size;
        for (uint256 i; i < 3; ++i) {
            sumK += fs.getPosition(makers[i]).fixedAprNotional;
            sumQ += fs.getPosition(makers[i]).size;
        }
        assertEq(sumQ, 0);
        assertEq(sumK, 0, "sum K exactly 0 across a 3-maker sweep");
        // avg fixed APR = (7·11.50% + 7·11.75% + 7·12.13%)/21
        assertApproxEqAbs(_acctApr(alice), 0.117933333333333333e18, 1);
    }

    function _acctApr(address who) internal view returns (int256) {
        SwapAccountView memory v = fs.getAccount(who);
        return v.avgFixedApr;
    }

    // ═══ liquidation after the real perp funding turns negative ═══════════════
    function test_liquidation_whenRealFundingTurnsNegative() public {
        _swapFund(sam, 200_000e6);
        _swapFund(alice, 3000e6); // IM 2,410 + V at the launch mark (0%: −286) + fees
        _swapFund(keeper, 100_000e6);
        vm.prank(sam);
        sob.placeLimitOrder(false, APR12, 1000, 0);
        vm.prank(alice);
        sob.placeMarketOrder(true, 1000, APR12, 1000, false);
        assertFalse(fs.isLiquidatable(alice));
        vm.roll(block.number + 101); // the swap's 12% trade leaves the mark inputs
        // the perp book trades 3% under the index: premium −3% ⇒ the rate walks down δ per block; step until
        // alice (long, receives floating) first becomes liquidatable, the way a keeper would see it
        _quotePerp(MID0 - 900);
        uint256 steps;
        while (!fs.isLiquidatable(alice) && steps < 200) {
            _run(20);
            ++steps;
        }
        assertTrue(fs.isLiquidatable(alice), "long receive-floating is under water");
        assertLt(ch.fundingState().rate, 0, "perp funding negative");
        assertLt(fs.markApr(), 0);
        assertGt(fs.getAccount(alice).equity, 0, "caught before insolvency");
        uint256 if0 = ausd.balanceOf(address(fund));
        vm.prank(keeper);
        fs.liquidate(alice, type(uint256).max);
        assertEq(fs.getPosition(alice).size, 0);
        assertEq(fs.getPosition(keeper).size, 1_000_000e18);
        assertEq(
            fs.getPosition(sam).fixedAprNotional + fs.getPosition(keeper).fixedAprNotional
                + fs.getPosition(alice).fixedAprNotional,
            0
        );
        assertGt(ausd.balanceOf(address(fund)), if0, "IF share of the penalty");
        (uint256 lo, uint256 so) = fs.openInterest();
        assertEq(lo, so);
    }

    // ═══ 1-hour maturity on the real perp ══════════════════════════════════════
    function test_maturity_oneHour_realPerp() public {
        _deploySwaps(block.timestamp + 1 hours);
        _swapFund(sam, 100_000e6);
        _swapFund(alice, 10_000e6);
        vm.prank(sam);
        sob.placeLimitOrder(false, APR12, 1000, 0);
        vm.prank(alice);
        sob.placeMarketOrder(true, 1000, APR12, 1000, false);
        _run(12_000); // 1 h
        assertTrue(fs.isMatured());
        fs.settleMaturity();
        (bool snapped, int256 fm, int256 gm) = fs.maturitySnapshot();
        assertTrue(snapped);
        fs.settle(alice);
        fs.settle(sam);
        int256 a1 = _collateral(alice);
        int256 s1 = _collateral(sam);
        _run(2000); // the perp keeps accruing
        (int256 fNow,,) = ch.latestObservation();
        assertGt(fNow, fm, "perp F moved on");
        fs.settle(alice);
        fs.settle(sam);
        assertEq(_collateral(alice), a1, "no accrual after maturity");
        assertEq(_collateral(sam), s1);
        assertEq(fs.getPosition(alice).lastCumIndexTime, gm);
        // collateral withdrawable (IM = 0 after maturity), increases refused
        uint256 all = uint256(_collateral(alice)) / 1e12;
        vm.prank(alice);
        fs.withdraw(all);
        vm.prank(sam);
        vm.expectRevert(); // reserve after maturity: Matured
        sob.placeLimitOrder(false, APR12, 1, 0);
    }
}
