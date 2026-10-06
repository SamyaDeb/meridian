// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {RiskParams, FundingParams, AccountView} from "../../src/interfaces/MeridianTypes.sol";
import {RealStackHandler} from "./handlers/RealStackHandler.sol";
import {MarkPriceLib} from "../../src/libs/MarkPriceLib.sol";
import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";

/// @notice PHASES G2: invariants I1–I7 and I11 on the REAL OrderBook + ClearingHouse (MATH_SPEC defaults,
///         deployed tick/lot). Default profile 256 runs × depth 128; CI profile 512 × 256.
contract RealStackInvariantsTest is StdInvariant, Test {
    RealStackHandler handler;
    ClearingHouse ch;
    OrderBook ob;
    uint256 deployBlock;

    function setUp() public {
        vm.roll(1000);
        vm.warp(1_790_000_000);
        deployBlock = block.number;
        address owner = makeAddr("owner");
        MockERC20 ausd = new MockERC20("Test AUSD", "tAUSD", 6);
        MockOracleAdapter oracle = new MockOracleAdapter(0.029e18);
        InsuranceFund fund = new InsuranceFund(address(ausd), owner);
        ch = new ClearingHouse(
            address(ausd),
            address(oracle),
            address(fund),
            RiskParams(0.2e18, 0.1e18, 0.0005e18, -0.0001e18, 0.01e18, 0.5e18, 250_000e18, 25_000e18),
            FundingParams(0.002e18, 3_472_222_222, 555_555_555_556, 555_555_556, 300, 0.05e18),
            owner
        );
        ob = new OrderBook(address(ch), 1e12, 100e18);
        vm.startPrank(owner);
        ch.setOrderBook(address(ob));
        fund.setMarketAuthorized(address(ch), true);
        vm.stopPrank();
        // seed the IF so bad debt is usually covered (both paths are exercised by Integration.t.sol)
        ausd.mint(address(fund), 1000e6);

        handler = new RealStackHandler(ch, ob, oracle, ausd);
        handler.setInsuranceFund(fund);
        handler.setOwner(owner);
        vm.prank(owner);
        fund.setMarketAuthorized(address(handler), true); // drainInsurance: bad debt reaches fees, then uncovered
        for (uint256 i; i < 6; ++i) {
            handler.deposit(i, 100e6);
            handler.deposit(i, 50e6); // 150 tAUSD each: the position cap allows ~4.8x, so liquidations are reachable
        }
        // weights: limit ×4, market ×3, price ×3, liquidate ×3, roll ×2, crash ×2, the rest ×1 (deposits rare so leverage builds)
        bytes4[] memory sel = new bytes4[](26);
        sel[0] = handler.deposit.selector;
        sel[1] = handler.withdraw.selector;
        sel[2] = handler.placeLimit.selector;
        sel[3] = handler.placeLimit.selector;
        sel[4] = handler.placeLimit.selector;
        sel[5] = handler.placeLimit.selector;
        sel[6] = handler.placeMarket.selector;
        sel[7] = handler.placeMarket.selector;
        sel[8] = handler.placeMarket.selector;
        sel[9] = handler.cancel.selector;
        sel[10] = handler.replace.selector;
        sel[11] = handler.liquidate.selector;
        sel[12] = handler.liquidate.selector;
        sel[13] = handler.liquidate.selector;
        sel[14] = handler.settle.selector;
        sel[15] = handler.pokeTwice.selector;
        sel[16] = handler.roll.selector;
        sel[17] = handler.roll.selector;
        sel[18] = handler.movePrice.selector;
        sel[19] = handler.movePrice.selector;
        sel[20] = handler.movePrice.selector;
        sel[21] = handler.setStale.selector;
        sel[22] = handler.crash.selector;
        sel[23] = handler.crash.selector;
        sel[24] = handler.drainInsurance.selector;
        sel[25] = handler.setPaused.selector; // CR-007: paused ⇒ increasing makers Skip
        targetSelector(FuzzSelector(address(handler), sel));
        targetContract(address(handler));
    }

    /// Deterministic path: resting book, a crossing buy, −15% with requote, liquidation, all invariants hold.
    function test_realStack_liquidationPath() public {
        for (uint256 i; i < 8; ++i) {
            handler.placeLimit(1, false, 17 + i, 30, 0); // asks above the index (actor 1)
            handler.placeLimit(2, true, 15 - i, 30, 0); // bids below (actor 2)
        }
        handler.placeMarket(0, true, 80, false); // actor 0 goes long 3 × 80 lots ≈ 24,000 MON on 150 tAUSD
        handler.placeMarket(0, true, 80, false);
        handler.placeMarket(0, true, 80, false);
        assertGt(ch.getPosition(address(0xA000)).size, 0);
        handler.roll(1);
        handler.movePrice(-800);
        handler.roll(1);
        handler.movePrice(-800);
        handler.roll(1);
        handler.pokeTwice();
        assertTrue(ch.isLiquidatable(address(0xA000)));
        handler.liquidate(0, type(uint256).max);
        assertEq(handler.okCalls("liquidate"), 1, "liquidation succeeded");
        assertEq(ch.getPosition(address(0xA000)).size, 0);
        invariant_I1_solvency();
        invariant_I2_oiBalance();
        invariant_I3_fundingConservation();
        invariant_I4_oncePerBlock();
        invariant_I5_rateBounds();
        invariant_I6_bookIntegrity();
        invariant_I7_reservations();
        invariant_I11_oracle();
    }

    /// Per-run coverage: successful protocol calls by kind, appended to bench-out/invariant_coverage.csv.
    function afterInvariant() public {
        uint256 maxQ;
        uint256 minRatioBps = type(uint256).max; // equity / maintenance, bps
        for (uint256 i; i < 6; ++i) {
            AccountView memory v = ch.getAccount(address(uint160(0xA000 + i)));
            uint256 q = v.size >= 0 ? uint256(v.size) : uint256(-v.size);
            if (q > maxQ) maxQ = q;
            if (v.maintenanceMargin != 0 && v.equity > 0) {
                uint256 r = uint256(v.equity) * 10_000 / v.maintenanceMargin;
                if (r < minRatioBps) minRatioBps = r;
            }
        }
        vm.writeLine(
            "./bench-out/invariant_diag.csv", string.concat(vm.toString(maxQ / 1e18), ",", vm.toString(minRatioBps))
        );
        vm.writeLine(
            "./bench-out/invariant_coverage.csv",
            string.concat(
                vm.toString(handler.okCalls("limit")),
                ",",
                vm.toString(handler.okCalls("market")),
                ",",
                vm.toString(handler.okCalls("liquidate")),
                ",",
                vm.toString(handler.ghostLiquidatableSeen()),
                ",",
                vm.toString(handler.lastLiqFailure()),
                ",",
                vm.toString(handler.ghostBadDebtShortfalls()),
                ",",
                vm.toString(handler.ghostFeesAbsorbed()),
                ",",
                vm.toString(handler.ghostUncoveredWithFees()),
                ",",
                vm.toString(handler.ghostSkips()),
                ",",
                vm.toString(handler.ghostEvictions())
            )
        );
    }

    function invariant_I1_solvency() public view {
        assertGe(handler.checkSolvencySlack(), 0, "I1");
    }

    /// PHASES 36: uncovered bad debt is only ever added once accrued protocol fees are exhausted.
    function invariant_I1_badDebtWaterfall() public view {
        assertFalse(handler.ghostWaterfallViolation(), "uncovered bad debt while fees > 0");
    }

    function invariant_I2_oiBalance() public view {
        (uint256 lo, uint256 so, uint256 sl, uint256 ss, int256 sumQ) = handler.checkOI();
        assertEq(sumQ, 0, "I2 sum q");
        assertEq(lo, so, "I2 longOI == shortOI");
        assertEq(lo, sl, "I2 longOI == sum long");
        assertEq(so, ss, "I2 shortOI == sum short");
    }

    function invariant_I3_fundingConservation() public view {
        (int256 total, uint256 terms) = handler.checkFundingConservation();
        assertGe(total, 0, "I3 >= 0");
        assertLe(total, int256(terms), "I3 <= #settlements");
    }

    function invariant_I4_oncePerBlock() public view {
        assertFalse(handler.ghostTouchedTwice(), "I4");
    }

    function invariant_I5_rateBounds() public view {
        assertFalse(handler.ghostRateViolation(), "I5");
    }

    function invariant_I6_bookIntegrity() public view {
        handler.checkI6();
        assertFalse(handler.ghostCancelFailed(), "cancel must always work");
    }

    function invariant_I7_reservations() public view {
        handler.checkI7();
    }

    /// MATH_SPEC §2.1: the mark stays in I·(1 ± 5%) of the index it was computed on, through the premium bound
    /// (P2, M-1). Checked when the views are a consistent pair: before this block's first touch `markPrice()` previews
    /// on the live index (stale: both views return the last good pair). After it, the mark is cached for the block
    /// (decision 2) while `indexPrice()` reads the oracle live, so a same-block price move would pair different indices.
    function invariant_markBand() public view {
        if (ch.fundingState().lastUpdateBlock == block.number) return;
        uint256 i = ch.indexPrice();
        uint256 m = ch.markPrice();
        uint256 e = FPM.mulWad(i, MarkPriceLib.MARK_BAND);
        assertGe(m, i - e, "mark below I(1 - band)");
        assertLe(m, i + e, "mark above I(1 + band)");
    }

    function invariant_I11_oracle() public view {
        assertFalse(handler.ghostGDecreased(), "I11 G monotone");
        assertTrue(handler.checkCheckpoints(), "I11 checkpoints");
        int256 cap = int256(ch.fundingParams().rateCap);
        uint256 age = block.number - deployBlock;
        uint64[3] memory w = [uint64(0), uint64(age / 2), uint64(age)];
        for (uint256 i; i < 3; ++i) {
            int256 r = ch.averageFundingRate(w[i]);
            assertLe(r, cap);
            assertGe(r, -cap);
        }
    }
}
