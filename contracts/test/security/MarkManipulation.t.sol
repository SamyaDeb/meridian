// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {IClearingHouse} from "../../src/interfaces/IClearingHouse.sol";
import {IOrderBook} from "../../src/interfaces/IOrderBook.sol";
import {RiskParams, FundingParams, AccountView} from "../../src/interfaces/MeridianTypes.sol";

/// @notice Audit finding M-1 (docs/HARDENING_PLAN.md P2.1): two of the three perp mark inputs (book mid, last trade)
///         come from our own book, so on a thin book an attacker can sweep one side, print a wash trade from a second
///         account and move the NEXT block's mark to the edge of the ±5% band, liquidating a short ≈ 4% from its
///         liquidation price. FIXED in P2 (MarkPriceLib.boundPremium: the basis moves ≤ 10 bps per block); the PoC now
///         runs always as a regression test (it failed on the pre-P2 code with mark = I·1.05 at block b+1).
///         Fixture: real ClearingHouse + OrderBook (tick 1e12, lot 100 MON), MATH_SPEC defaults, mock oracle.
contract MarkManipulationTest is Test {
    uint256 constant I0 = 0.029e18;
    uint32 constant MID0 = 29_000;
    uint256 constant I1 = 0.0306e18; // index after a genuine +5.5% move
    uint32 constant MID1 = 30_600;
    uint32 constant PUMP = 33_660; // I1·1.10

    MockERC20 ausd;
    MockOracleAdapter oracle;
    InsuranceFund fund;
    ClearingHouse ch;
    OrderBook ob;
    address owner = makeAddr("owner");
    address mm = makeAddr("mm");
    address alice = makeAddr("alice"); // victim short
    address x = makeAddr("attackerX");
    address y = makeAddr("attackerY");
    uint64 mmBid;
    uint64 mmAsk;

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
        vm.startPrank(owner);
        ch.setOrderBook(address(ob));
        fund.setMarketAuthorized(address(ch), true);
        vm.stopPrank();
        _fund(mm, 100_000e6);
        _quote(MID0);
        _run(200);

        // alice shorts 5,000 MON at 0.02899 with ≈ 1.03× IM
        _fund(alice, 30e6);
        vm.prank(alice);
        ob.placeMarketOrder(false, 50, MID0 - 10, 50, false);
        // a genuine index move: +5.5%; the MM re-quotes around it; alice's trade leaves the 100-block window
        oracle.setPrice(I1);
        _requote(MID1);
        _run(120);
        _fund(x, 10_000e6);
        _fund(y, 10_000e6);
    }

    function _fund(address who, uint256 amt) internal {
        ausd.mint(who, amt);
        vm.startPrank(who);
        ausd.approve(address(ch), amt);
        ch.deposit(amt);
        vm.stopPrank();
    }

    function _quote(uint32 mid) internal {
        vm.startPrank(mm);
        (mmBid,) = ob.placeLimitOrder(true, mid - 10, 100, 0);
        (mmAsk,) = ob.placeLimitOrder(false, mid + 10, 100, 0);
        vm.stopPrank();
    }

    function _requote(uint32 mid) internal {
        vm.startPrank(mm);
        ob.cancelOrder(mmBid);
        ob.cancelOrder(mmAsk);
        vm.stopPrank();
        _quote(mid);
    }

    function _run(uint256 n) internal {
        for (uint256 done; done < n; done += 20) {
            vm.roll(block.number + 20);
            vm.warp(block.timestamp + 6);
            ch.updateFunding();
        }
    }

    function _next() internal {
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1);
    }

    /// One attacker transaction in block b: sweep the MM's asks, wash-trade 1 lot at +10% (X → Y), rest the pumped
    /// ask and a bid far enough below it that the spread stays > 2% (no premium sample, only the mark moves).
    function _attack() internal {
        vm.prank(x);
        ob.placeMarketOrder(true, 100, PUMP, 100, false); // sweep the MM's 100-lot ask at I1 + 10 ticks
        vm.prank(x);
        ob.placeLimitOrder(false, PUMP, 1, 0);
        vm.prank(y);
        ob.placeMarketOrder(true, 1, PUMP, 1, false); // last trade = I1·1.10
        vm.prank(x);
        ob.placeLimitOrder(false, PUMP, 1, 0); // best ask I1·1.10
        vm.prank(y);
        ob.placeLimitOrder(true, 32_000, 1, 0); // best bid I1·1.046
    }

    function test_fixture_victimIsAbout4PctFromLiquidation() public view {
        AccountView memory v = ch.getAccount(alice);
        assertLt(v.size, 0, "short");
        uint256 m = ch.markPrice();
        assertApproxEqRel(m, I1, 0.002e18, "mark settled at the index");
        assertFalse(ch.isLiquidatable(alice), "healthy");
        uint256 dist = (v.liquidationPrice - m) * 1e18 / m;
        assertGt(dist, 0.03e18, "> 3% from liquidation");
        assertLt(dist, 0.045e18, "< 4.5% from liquidation");
    }

    /// M-1: a one-block book + wash-trade manipulation must not make a healthy account liquidatable in the next block.
    function test_M1_oneBlockManipulationDoesNotLiquidate() public {
        uint256 m0 = ch.markPrice();
        assertFalse(ch.isLiquidatable(alice), "healthy before");

        _next();
        _attack();

        _next(); // block b+1: its first touch reads the manipulated book and last trade
        ch.updateFunding();
        uint256 m1 = ch.markPrice();
        emit log_named_decimal_uint("mark before   ", m0, 18);
        emit log_named_decimal_uint("mark at b+1   ", m1, 18);
        emit log_named_decimal_uint("index         ", I1, 18);
        emit log_named_string("victim liquidatable", ch.isLiquidatable(alice) ? "yes" : "no");
        assertFalse(ch.isLiquidatable(alice), "healthy short liquidated by a one-block manipulation");
        assertLe(m1, m0 + I1 / 1000 + 1, "mark basis moved more than 10 bps in one block");
        vm.prank(x);
        vm.expectRevert(IClearingHouse.NotLiquidatable.selector);
        ch.liquidate(alice, type(uint256).max);
    }

    /// Held manipulation: the victim 3.9% away only becomes liquidatable after the attacker keeps the book pumped for
    /// ≈ 39 consecutive touched blocks (10 bps per block), long enough for the MM to re-quote.
    function test_M1_heldManipulation_needsAbout40Blocks() public {
        uint256 m0 = ch.markPrice();
        _next();
        _attack();
        uint256 n;
        uint256 prev = m0;
        while (!ch.isLiquidatable(alice) && n < 100) {
            _next();
            ch.updateFunding();
            uint256 m = ch.markPrice();
            assertLe(m - prev, I1 / 1000 + 1, "<= 10 bps per block");
            prev = m;
            ++n;
        }
        emit log_named_uint("blocks of held manipulation to liquidate", n);
        assertGe(n, 35, "liquidatable too early");
        assertLe(n, 45, "bound slower than 10 bps per block");
    }

    /// Same-block trades: every fill touches the CH (settleMakerFill) before the OrderBook prints the trade, so the
    /// first touch of block b never sees a trade from block b. Proved on the event order of the first tx in a block.
    function test_sameBlock_firstTouchRunsBeforeTheTradePrints() public {
        uint256 m0 = ch.markPrice();
        _next();
        vm.recordLogs();
        vm.prank(x);
        ob.placeMarketOrder(true, 100, PUMP, 100, false); // the block's first tx: the sweep
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 touchAt = type(uint256).max;
        uint256 tradeAt = type(uint256).max;
        uint256 touches;
        for (uint256 i; i < logs.length; ++i) {
            bytes32 t0 = logs[i].topics[0];
            if (logs[i].emitter == address(ch) && t0 == IClearingHouse.FundingUpdated.selector) {
                ++touches;
                if (touchAt == type(uint256).max) touchAt = i;
            }
            if (logs[i].emitter == address(ob) && t0 == IOrderBook.Trade.selector && tradeAt == type(uint256).max) {
                tradeAt = i;
            }
        }
        assertEq(touches, 1, "one touch per block");
        assertLt(touchAt, tradeAt, "the touch precedes the first Trade");
        (, uint64 lastBlk) = ob.lastTrade();
        assertEq(lastBlk, block.number, "the sweep printed a trade in this block");
        assertEq(ch.markPrice(), m0, "this block's mark was fixed before the print");
        // the rest of the attack in the same block changes nothing for this block
        vm.prank(x);
        ob.placeLimitOrder(false, PUMP, 1, 0);
        vm.prank(y);
        ob.placeMarketOrder(true, 1, PUMP, 1, false);
        assertEq(ch.markPrice(), m0);
        assertFalse(ch.isLiquidatable(alice));
    }
}
