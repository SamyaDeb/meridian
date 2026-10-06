// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {PythChainlinkOracleAdapter} from "../../src/oracle/PythChainlinkOracleAdapter.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {IClearingHouse} from "../../src/interfaces/IClearingHouse.sol";
import {IFundingRateOracle} from "../../src/interfaces/IFundingRateOracle.sol";
import {IPythMinimal} from "../../src/interfaces/external/IPythMinimal.sol";
import {AggregatorV3Interface} from "../../src/interfaces/external/AggregatorV3Interface.sol";
import {
    PulseConstants,
    RiskParams,
    FundingParams,
    FundingState,
    Position,
    AccountView
} from "../../src/interfaces/PulseTypes.sol";
import {OracleMockPyth} from "./OracleMockPyth.sol";

/// @notice CP1 gate logic (PHASES G2): the REAL OrderBook + ClearingHouse + InsuranceFund with MATH_SPEC defaults.
///         Subclasses supply the oracle (settable mock, or the real Pyth adapter over a mock Pyth).
abstract contract IntegrationBase is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant TICK = 1e12; // 0.000001 AUSD
    uint256 internal constant LOT = 100e18; // 100 MON
    uint256 internal constant I0 = 0.029e18;
    uint32 internal constant MID0 = 29_000;
    int256 internal constant INTEREST = 3_472_222_222; // 10.95% APR per second (MATH_SPEC §1.3)
    uint256 internal constant START = 1000;

    MockERC20 internal ausd;
    InsuranceFund internal fund;
    ClearingHouse internal ch;
    OrderBook internal ob;
    address internal owner = makeAddr("owner");
    address internal mm = makeAddr("mm"); // market maker
    address internal alice = makeAddr("alice"); // taker
    address internal bob = makeAddr("bob"); // ~5x long
    address internal carol = makeAddr("carol"); // liquidator / keeper
    address internal dave = makeAddr("dave");
    address[] internal actors;
    uint64[] internal mmIds;

    // FundingCheckpoint events seen so far (from vm.recordLogs), for the APR-from-events check.
    uint64[] internal ckBlock;
    int256[] internal ckF;
    int256[] internal ckG;

    function _oracle() internal virtual returns (address);

    function _risk() internal pure returns (RiskParams memory) {
        return RiskParams({
            imr: 0.2e18,
            mmr: 0.1e18,
            takerFee: 0.0005e18,
            makerFee: -0.0001e18,
            liqPenalty: 0.01e18,
            keeperShare: 0.5e18,
            maxOpenInterest: 250_000e18,
            maxPositionSize: 25_000e18
        });
    }

    function _funding() internal pure returns (FundingParams memory) {
        return FundingParams({
            alpha: 0.002e18,
            interestRate: INTEREST,
            rateCap: 555_555_555_556,
            maxRateChangePerBlock: 555_555_556,
            blockTimeMs: 300,
            premiumBandWad: 0.05e18
        });
    }

    function setUp() public virtual {
        vm.roll(START);
        vm.warp(1_790_000_000);
        ausd = new MockERC20("Test AUSD", "tAUSD", 6);
        address oracle = _oracle();
        fund = new InsuranceFund(address(ausd), owner);
        vm.recordLogs();
        ch = new ClearingHouse(address(ausd), oracle, address(fund), _risk(), _funding(), owner);
        _collectCheckpoints(vm.getRecordedLogs());
        ob = new OrderBook(address(ch), TICK, LOT);
        vm.startPrank(owner);
        ch.setOrderBook(address(ob));
        fund.setMarketAuthorized(address(ch), true);
        vm.stopPrank();
        actors = [mm, alice, bob, carol, dave];
        _fund(mm, 100_000e6);
        _quote(MID0);
    }

    // ─── helpers ──────────────────────────────────────────────────────────────
    function _fund(address who, uint256 amountToken) internal {
        ausd.mint(who, amountToken);
        vm.startPrank(who);
        ausd.approve(address(ch), amountToken);
        ch.deposit(amountToken);
        vm.stopPrank();
    }

    /// mm quotes 3 bids and 3 asks, 100 lots each, 10 ticks apart around `mid`.
    function _quote(uint32 mid) internal {
        vm.startPrank(mm);
        for (uint256 i; i < mmIds.length; ++i) {
            if (ob.getOrder(mmIds[i]).remainingLots != 0) ob.cancelOrder(mmIds[i]);
        }
        delete mmIds;
        for (uint32 i = 1; i <= 3; ++i) {
            (uint64 b,) = ob.placeLimitOrder(true, mid - 10 * i, 100, 0);
            (uint64 a,) = ob.placeLimitOrder(false, mid + 10 * i, 100, 0);
            mmIds.push(b);
            mmIds.push(a);
        }
        vm.stopPrank();
    }

    function _roll(uint256 n) internal {
        vm.roll(block.number + n);
        vm.warp(block.timestamp + (n * 3 + 9) / 10); // ~300 ms blocks, 1 s timestamp resolution
    }

    function _collectCheckpoints(Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != IFundingRateOracle.FundingCheckpoint.selector) continue;
            (uint64 b, int256 f, int256 g) = abi.decode(logs[i].data, (uint64, int256, int256));
            ckBlock.push(b);
            ckF.push(f);
            ckG.push(g);
        }
    }

    /// Σq = 0 and longOI = shortOI = Σ max(q, 0) over all actors (MATH_SPEC I2).
    function _assertI2() internal view {
        int256 sumQ;
        uint256 longs;
        uint256 shorts;
        for (uint256 i; i < actors.length; ++i) {
            int256 q = ch.getPosition(actors[i]).size;
            sumQ += q;
            if (q > 0) longs += uint256(q);
            else shorts += uint256(-q);
        }
        (uint256 lo, uint256 so) = ch.openInterest();
        assertEq(sumQ, 0, "I2: sum q");
        assertEq(lo, so, "I2: longOI == shortOI");
        assertEq(lo, longs, "I2: longOI == sum of longs");
        assertEq(so, shorts, "I2: shortOI == sum of shorts");
    }

    /// MATH_SPEC I1 (amended, decision 7): balance·1e12 ≥ ΣC − ΣON − Σpending + accruedFees, dust ≥ 0 and tiny.
    function _assertI1() internal view returns (int256 dust) {
        int256 sumC;
        int256 sumON;
        int256 sumPending;
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            sumC += ch.collateralOf(a);
            sumON += ch.getPosition(a).openNotional;
            sumPending += ch.getAccount(a).pendingFunding;
        }
        int256 lhs = int256(ausd.balanceOf(address(ch)) * 1e12);
        int256 rhs = sumC - sumON - sumPending + int256(ch.accruedFees());
        dust = lhs - rhs;
        assertGe(dust, 0, "I1: solvency");
        assertLe(dust, 1e12, "I1: dust below one token unit");
    }

    function _openAliceLong50() internal {
        _fund(alice, 1000e6);
        vm.prank(alice);
        ob.placeMarketOrder(true, 50, MID0 + 10, 50, false);
    }

    /// bob opens ~4.85x long: 10,000 MON at 0.02901 on 60 tAUSD.
    function _openBobLong() internal {
        _fund(bob, 60e6);
        vm.prank(bob);
        ob.placeMarketOrder(true, 100, MID0 + 10, 100, false);
    }
}

/// @notice The CP1 scenario on the settable MockOracleAdapter.
contract IntegrationTest is IntegrationBase {
    MockOracleAdapter internal oracle;

    function _oracle() internal override returns (address) {
        oracle = new MockOracleAdapter(I0);
        return address(oracle);
    }

    // ═══ 1. trade: positions, fees, reservations ════════════════════════════
    function test_trade_positionsFeesReservations() public {
        uint256 bidRes = FPM.mulWadUp(FPM.mulWadUp(100 * LOT, 28_990 * TICK), 0.2e18);
        uint256 askRes = FPM.mulWadUp(FPM.mulWadUp(100 * LOT, 29_010 * TICK), 0.2e18);
        uint256 reservedBefore = ch.getAccount(mm).reservedOrderMargin;
        assertGt(reservedBefore, bidRes + askRes); // 6 orders reserved

        _openAliceLong50(); // 5,000 MON at 0.02901
        uint256 notional = 5000 * 0.02901e18; // 145.05 AUSD, exact
        uint256 takerFee = FPM.mulWadUp(notional, 0.0005e18);
        uint256 rebate = FPM.mulWad(notional, 0.0001e18);
        assertEq(takerFee, 0.072525e18);
        assertEq(rebate, 0.014505e18);

        assertEq(ch.getPosition(alice).size, 5000e18);
        assertEq(ch.getPosition(alice).openNotional, int256(notional));
        assertEq(ch.getPosition(mm).size, -5000e18);
        assertEq(ch.collateralOf(alice), int256(1000e18 - takerFee));
        assertEq(ch.collateralOf(mm), int256(100_000e18 + rebate));
        assertEq(ch.accruedFees(), takerFee - rebate);
        // the filled half of the best ask's reservation is released (exact here: no rounding)
        assertEq(ch.getAccount(mm).reservedOrderMargin, reservedBefore - askRes / 2);
        assertEq(ch.getAccount(alice).reservedOrderMargin, 0);
        (uint64 lots,) = ob.getLevel(MID0 + 10);
        assertEq(lots, 50);
        _assertI2();
        _assertI1();
    }

    /// @dev One block of the funding run, as an external self-call so memory (the logs) is freed per block.
    function stepBlock() external returns (int256 f, int256 g, int256 pendingAlice) {
        _roll(1);
        ch.updateFunding();
        ch.updateFunding(); // second touch in the same block: no second write
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IClearingHouse.FundingUpdated.selector) {
                ++n;
                (,,, f, g,,) = abi.decode(logs[i].data, (int256, int256, int256, int256, int256, uint256, uint256));
            }
        }
        assertEq(n, 1, "exactly one FundingUpdated per block");
        _collectCheckpoints(logs);
        pendingAlice = ch.getAccount(alice).pendingFunding;
    }

    // ═══ 2–3. 12,000 blocks of per-block funding; APR oracle from events ════
    function test_funding12000Blocks_andAprFromEvents() public {
        _openAliceLong50();
        int256 prevPendingAlice = ch.getAccount(alice).pendingFunding;
        int256 lastF;
        int256 lastG;
        int256 prevF;
        vm.recordLogs();
        for (uint256 b; b < 12_000; ++b) {
            prevF = lastF;
            int256 pa_;
            (lastF, lastG, pa_) = this.stepBlock();
            assertGt(pa_, prevPendingAlice, "long's pending funding grows every block");
            prevPendingAlice = pa_;
        }
        // Balanced book (mid = index): premium 0, rate converged to the interest rate; longs pay shorts.
        FundingState memory s = ch.fundingState();
        assertEq(s.rate, INTEREST);
        assertEq(s.emaPremium, 0);
        assertEq(s.cumFunding, lastF);
        assertEq(s.cumIndexTime, lastG);
        assertEq(lastF - prevF, 30_208_333, "MATH_SPEC 1.7(b): per-block dF at i, I = 0.029");
        int256 pa = ch.getAccount(alice).pendingFunding;
        int256 pm = ch.getAccount(mm).pendingFunding;
        assertGt(pa, 0);
        assertLt(pm, 0);
        assertGe(pa + pm, 0);
        assertLe(pa + pm, 2, "funding conservation: dust <= #settlements");
        assertEq(ckBlock.length, 61, "one checkpoint per 200-block bucket: 1000..13000");

        // averageFundingApr(w) == ΔF·1e18/ΔG·YEAR from the emitted events, to the wei
        uint64[5] memory windows = [uint64(12_000), 6000, 2400, 1000, 200];
        for (uint256 k; k < windows.length; ++k) {
            uint256 target = block.number - windows[k];
            uint256 j = ckBlock.length - 1;
            while (ckBlock[j] > target) --j;
            int256 expected = (lastF - ckF[j]) * 1e18 / (lastG - ckG[j]) * int256(PulseConstants.SECONDS_PER_YEAR);
            assertEq(ch.averageFundingApr(windows[k]), expected, "APR from events");
        }
        // 10.95% APR at the interest floor over the last hour of steady state (within rounding of the δ ramp)
        assertApproxEqRel(ch.averageFundingApr(6000), INTEREST * int256(PulseConstants.SECONDS_PER_YEAR), 1e12);

        // settle both: collateral moves by exactly the pending amounts
        int256 ca = ch.collateralOf(alice);
        ch.settleFunding(alice);
        assertEq(ch.collateralOf(alice), ca - pa);
        _assertI2();
        _assertI1();
    }

    // ═══ 4. −15% liquidates the ~5x long; IF and keeper paid ════════════════
    function test_crash15_liquidatesLong_keeperAndIFPaid() public {
        _openBobLong();
        _fund(carol, 1000e6);
        vm.prank(owner);
        ausd.mint(owner, 1000e6);
        vm.startPrank(owner);
        ausd.approve(address(fund), 1000e6);
        fund.fund(1000e6);
        vm.stopPrank();
        assertFalse(ch.isLiquidatable(bob));

        _roll(1);
        oracle.setPrice(I0 * 85 / 100);
        _quote(uint32(I0 * 85 / 100 / TICK)); // the MM requotes around the new index
        _roll(1);
        AccountView memory v = ch.getAccount(bob);
        uint256 mark = ch.markPrice();
        assertApproxEqRel(mark, 0.02465e18, 0.001e18);
        assertTrue(v.liquidatable);
        assertLt(v.equity, int256(v.maintenanceMargin));

        uint256 notional = FPM.mulWad(10_000e18, mark);
        uint256 penalty = FPM.min(FPM.mulWadUp(notional, 0.01e18), uint256(v.equity));
        uint256 keeperReward = FPM.mulWad(penalty, 0.5e18);
        uint256 ifBefore = ausd.balanceOf(address(fund));
        int256 carolBefore = ch.collateralOf(carol);

        vm.expectEmit(address(ch));
        emit IClearingHouse.Liquidated(bob, carol, 10_000e18, mark, penalty, keeperReward, penalty - keeperReward, 0);
        vm.prank(carol);
        int256 moved = ch.liquidate(bob, type(uint256).max);

        assertEq(moved, 10_000e18);
        assertEq(ch.getPosition(bob).size, 0);
        assertEq(ch.getPosition(bob).openNotional, 0);
        assertEq(ch.getPosition(carol).size, 10_000e18);
        assertEq(ch.collateralOf(bob), v.equity - int256(penalty), "liquidatee keeps equity after the penalty");
        assertEq(ch.collateralOf(carol), carolBefore + int256(keeperReward));
        assertEq(ausd.balanceOf(address(fund)) - ifBefore, (penalty - keeperReward) / 1e12);
        assertEq(ch.totalBadDebt(), 0);
        _assertI2();
        _assertI1();
    }

    // ═══ 5. bad debt: covered by the IF, then socialized when the IF is empty ═
    function _gapAndLiquidate() internal returns (int256 equityBefore, uint256 ifBefore) {
        _openBobLong();
        _fund(carol, 1000e6);
        _roll(1);
        oracle.setPrice(I0 * 60 / 100); // −40% gap
        _quote(uint32(I0 * 60 / 100 / TICK));
        _roll(1);
        equityBefore = ch.getAccount(bob).equity;
        assertLt(equityBefore, 0, "gap leaves negative equity");
        ifBefore = ausd.balanceOf(address(fund));
        uint256 badDebt = uint256(-equityBefore);
        vm.expectEmit(address(ch));
        emit IClearingHouse.Liquidated(bob, carol, 10_000e18, ch.markPrice(), 0, 0, 0, badDebt);
        vm.prank(carol);
        ch.liquidate(bob, type(uint256).max);
    }

    function test_badDebt_coveredByInsuranceFund() public {
        ausd.mint(owner, 1000e6);
        vm.startPrank(owner);
        ausd.approve(address(fund), 1000e6);
        fund.fund(1000e6);
        vm.stopPrank();
        (int256 eq, uint256 ifBefore) = _gapAndLiquidate();
        uint256 requested = FPM.divUp(uint256(-eq), 1e12);
        assertEq(ifBefore - ausd.balanceOf(address(fund)), requested);
        assertEq(ch.collateralOf(bob), 0);
        assertEq(ch.totalBadDebt(), 0);
        _assertI2();
        _assertI1();
    }

    /// PHASES 36 waterfall: IF empty ⇒ accrued protocol fees absorb what they can, only the rest is socialized.
    function test_badDebt_socializedWhenInsuranceFundEmpty() public {
        assertEq(ausd.balanceOf(address(fund)), 0);
        vm.recordLogs();
        (int256 eq,) = _gapAndLiquidate();
        uint256 badDebt = uint256(-eq);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        uint256 uncovered;
        uint256 fromFees;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IClearingHouse.BadDebtSocialized.selector) {
                uint256 req;
                uint256 covered;
                (req, covered, uncovered) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                assertEq(req, badDebt);
                assertEq(covered, 0);
                fromFees = req - covered - uncovered;
                seen = true;
            }
        }
        assertTrue(seen, "BadDebtSocialized emitted");
        assertGt(fromFees, 0, "the session's fees absorbed part of it");
        assertGt(uncovered, 0, "fees < debt here");
        assertEq(ch.accruedFees(), 0, "fees exhausted before socializing");
        assertEq(ch.collateralOf(bob), -int256(uncovered), "uncovered bad debt stays as negative collateral");
        assertEq(ch.totalBadDebt(), uncovered);
        _assertI2();
        _assertI1();
        // decision 5: a later deposit repays it first
        _fund(bob, 100e6);
        assertEq(ch.collateralOf(bob), -int256(uncovered) + 100e18);
    }

    // ═══ 6. stale oracle ════════════════════════════════════════════════════
    function test_staleOracle_blocksIncreases_allowsReductionsCancelsDepositsLiquidation() public {
        _openAliceLong50(); // alice +5,000; mm −5,000
        // dave goes long and rests a reducing ask below the MM's asks (a reducing maker for the taker test)
        _fund(dave, 1000e6);
        vm.startPrank(dave);
        ob.placeMarketOrder(true, 20, MID0 + 10, 20, false);
        (uint64 daveAsk,) = ob.placeLimitOrder(false, MID0 + 5, 20, 0);
        vm.stopPrank();
        ch.updateFunding();
        FundingState memory s0 = ch.fundingState();

        oracle.setStale(true);
        _roll(50);
        ch.updateFunding();
        FundingState memory s1 = ch.fundingState();
        assertEq(s1.cumFunding, s0.cumFunding, "F frozen while stale");
        assertEq(s1.cumIndexTime, s0.cumIndexTime, "G frozen while stale");
        assertEq(s1.lastUpdateBlock, block.number);

        // position-increasing taker trade against a reducing maker: OracleStale
        vm.prank(alice);
        vm.expectRevert(IClearingHouse.OracleStale.selector);
        ob.placeMarketOrder(true, 10, MID0 + 10, 0, false);
        // new resting orders need a fresh oracle
        vm.prank(alice);
        vm.expectRevert(IClearingHouse.OracleStale.selector);
        ob.placeLimitOrder(true, MID0 - 50, 1, 0);
        // reduce-only works (alice sells into the MM's bid; the MM is short, so its fill reduces too)
        vm.prank(alice);
        (uint64 filled,) = ob.placeMarketOrder(false, 10, MID0 - 10, 10, true);
        assertEq(filled, 10);
        assertEq(ch.getPosition(alice).size, 4000e18);
        // cancels and deposits work
        vm.prank(dave);
        ob.cancelOrder(daveAsk);
        _fund(dave, 10e6);
        _assertI2();
        _assertI1();

        // accrual resumes from the stale touch (no retroactive accrual over the stale period)
        oracle.setStale(false);
        _roll(1);
        ch.updateFunding();
        FundingState memory s2 = ch.fundingState();
        assertEq(s2.cumIndexTime - s1.cumIndexTime, int256(I0 * 300 / 1000), "one block of G");
    }

    function test_staleOracle_liquidationAtLastGoodMark() public {
        _openBobLong();
        _fund(carol, 1000e6);
        _roll(1);
        oracle.setPrice(I0 * 85 / 100);
        _quote(uint32(I0 * 85 / 100 / TICK));
        _roll(1);
        ch.updateFunding(); // mark cached at the new price
        uint256 goodMark = ch.markPrice();
        oracle.setStale(true);
        _roll(10);
        assertEq(ch.markPrice(), goodMark, "last good mark while stale");
        assertTrue(ch.isLiquidatable(bob));
        vm.prank(carol);
        ch.liquidate(bob, type(uint256).max);
        assertEq(ch.getPosition(bob).size, 0);
        _assertI2();
        _assertI1();
    }
}

/// @notice Same core on the REAL PythChainlinkOracleAdapter over a mock Pyth, with secondary = address(0)
///         (testnet path, PHASES decision 10: no Chainlink on testnet). The keeper pushes prices.
contract IntegrationPythAdapterTest is IntegrationBase {
    bytes32 internal constant ID = 0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1;
    OracleMockPyth internal pyth;
    PythChainlinkOracleAdapter internal adapter;

    function _oracle() internal override returns (address) {
        pyth = new OracleMockPyth(1);
        pyth.setPrice(ID, 2_900_000, 1000, -8, block.timestamp); // 0.029, conf 0.0034%
        adapter = new PythChainlinkOracleAdapter(
            address(this),
            IPythMinimal(address(pyth)),
            ID,
            AggregatorV3Interface(address(0)),
            60,
            0.02e18,
            3600,
            "MON/USD"
        );
        return address(adapter);
    }

    function _push(int64 price) internal {
        bytes[] memory upd = new bytes[](1);
        upd[0] = abi.encode(ID, price, uint64(1000), int32(-8), block.timestamp);
        adapter.updatePrice{value: 1}(upd);
    }

    function test_pythAdapter_fundingAccruesWithPushes_andPausesWhenStale() public {
        assertEq(ch.indexPrice(), I0);
        _openAliceLong50();
        for (uint256 b; b < 1200; ++b) {
            _roll(1);
            if (b % 10 == 0) _push(2_900_000); // keeper pushes every ~3 s
            ch.updateFunding();
        }
        FundingState memory s = ch.fundingState();
        assertEq(s.rate, INTEREST);
        assertGt(ch.getAccount(alice).pendingFunding, 0);

        // no pushes for > 60 s ⇒ adapter stale ⇒ CH freezes F and G and blocks increases
        vm.warp(block.timestamp + 61);
        _roll(1);
        ch.updateFunding();
        FundingState memory st = ch.fundingState();
        _roll(20);
        ch.updateFunding();
        assertEq(ch.fundingState().cumIndexTime, st.cumIndexTime);
        (bool ok,,) = adapter.tryGetIndexPrice();
        assertFalse(ok);
        _fund(dave, 100e6);
        vm.prank(dave);
        vm.expectRevert(IClearingHouse.OracleStale.selector);
        ob.placeLimitOrder(true, MID0 - 50, 1, 0);

        // keeper pushes again ⇒ accrual resumes
        _push(2_900_000);
        _roll(1);
        ch.updateFunding();
        assertEq(ch.fundingState().cumIndexTime - st.cumIndexTime, int256(I0 * 300 / 1000));
        _assertI2();
        _assertI1();
    }

    function test_pythAdapter_crashLiquidation() public {
        _openBobLong();
        _fund(carol, 1000e6);
        _roll(1);
        _push(2_465_000); // −15%
        _quote(24_650);
        _roll(1);
        assertTrue(ch.isLiquidatable(bob));
        vm.prank(carol);
        ch.liquidate(bob, type(uint256).max);
        assertEq(ch.getPosition(bob).size, 0);
        _assertI2();
        _assertI1();
    }
}
