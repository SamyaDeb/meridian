// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {FundingSwapMarket} from "../../src/swaps/FundingSwapMarket.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {RiskParams, FundingParams, SwapParams, SwapAccountView} from "../../src/interfaces/PulseTypes.sol";

/// @notice Founder B's security review (docs/outputs/security/review-B.md): proof-of-concept tests for the
///         High/Medium findings in A's contracts. Each test asserts the CORRECT behaviour, so it FAILS on the
///         current code and passes once the finding is fixed. B-01 and B-02 are FIXED (per-block bound on
///         the swap mark; a reduction may not create or worsen a maintenance shortfall) and both run always as
///         regression tests (the env flag below is no longer needed):
///           REVIEW_B_POC=true forge test --match-path test/security/ReviewB.t.sol -vv
///         Fixture: the real perp ClearingHouse + OrderBook and the real FundingSwapMarket + its own OrderBook
///         (tick 1e14 = 1 bp APR, lot 1,000 MON), MATH_SPEC defaults (same as FundingSwapIntegration.t.sol).
abstract contract ReviewBFixture is Test {
    uint256 constant I0 = 0.029e18;
    uint32 constant MID0 = 29_000; // perp tick (1e12) of 0.029

    MockERC20 ausd;
    MockOracleAdapter oracle;
    InsuranceFund fund;
    ClearingHouse ch;
    OrderBook ob;
    FundingSwapMarket fs;
    OrderBook sob;
    address owner = makeAddr("owner");
    address mm = makeAddr("mm"); // perp MM
    address sam = makeAddr("sam"); // swap MM
    address alice = makeAddr("alice"); // victim
    address x = makeAddr("attackerX");
    address y = makeAddr("attackerY");
    uint64 samBid;

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
        fs = new FundingSwapMarket(
            address(ch),
            address(ausd),
            address(fund),
            uint64(block.timestamp + 30 days),
            SwapParams(0.05e18, 86_400, 1.5e18, 0.002e18, -0.0005e18, 0.2e18, 0.5e18, 2_000_000e18, 2_000_000e18),
            owner
        );
        sob = new OrderBook(address(fs), 1e14, 1000e18);
        vm.startPrank(owner);
        ch.setOrderBook(address(ob));
        fs.setOrderBook(address(sob));
        fund.setMarketAuthorized(address(ch), true);
        fund.setMarketAuthorized(address(fs), true);
        vm.stopPrank();
        // a live perp: two-sided book and 200 blocks of funding (rate settles at the 10.95% interest floor)
        _fund(address(ch), mm, 100_000e6);
        vm.startPrank(mm);
        ob.placeLimitOrder(true, MID0 - 10, 100, 0);
        ob.placeLimitOrder(false, MID0 + 10, 100, 0);
        vm.stopPrank();
        _run(200);
        ausd.mint(address(this), 10_000e6);
        ausd.approve(address(fund), 10_000e6);
        fund.fund(10_000e6); // IF seed
    }

    function _fund(address market, address who, uint256 amt) internal {
        ausd.mint(who, amt);
        vm.startPrank(who);
        ausd.approve(market, amt);
        if (market == address(ch)) ch.deposit(amt);
        else fs.deposit(amt);
        vm.stopPrank();
    }

    function _run(uint256 n) internal {
        for (uint256 done; done < n; done += 20) {
            vm.roll(block.number + 20);
            vm.warp(block.timestamp + 6);
            ch.updateFunding();
        }
    }

    /// alice long 100,000 MON of the 30-day swap at 11.00% with ≈ 1.3× IM; the swap MM keeps a 5-lot bid.
    function _victimLong() internal {
        _fund(address(fs), sam, 200_000e6);
        _fund(address(fs), alice, 300e6);
        vm.prank(sam);
        sob.placeLimitOrder(false, 11_100, 100, 0);
        vm.prank(alice);
        sob.placeMarketOrder(true, 100, 11_100, 100, false);
        _run(120); // alice's trade leaves the 100-block last-trade window
        vm.startPrank(sam);
        (samBid,) = sob.placeLimitOrder(true, 11_090, 5, 0); // MM: bid 10.90%
        sob.placeLimitOrder(false, 11_110, 5, 0); // MM: ask 11.10%
        vm.stopPrank();
    }
}

contract ReviewBTest is ReviewBFixture {
    // ═══ B-01 (High): the swap mark can be moved ±50 APR points inside ONE transaction ═══════════════════
    /// markApr is recomputed live on every call (no per-block cache, unlike the perp mark, decision 2) and is
    /// clamped only to realizedApr ± 50 APR points. Two attacker accounts sweep the thin MM bid, print a 1-lot
    /// self-trade at −38% and rest a −40%/−38% book: median(book, last trade, realized) = −38%. At τ = 30 d that
    /// moves V by 49 pts × 30/365 ≈ 4% of notional, more than the IM–MM gap, so a healthy long is liquidated in
    /// the same transaction. Correct behaviour: a same-transaction book/trade manipulation must not change
    /// liquidation eligibility.
    function test_B01_swapMarkAtomicManipulationLiquidatesHealthyAccount() public {
        _victimLong();
        int256 mark0 = fs.markApr();
        assertFalse(fs.isLiquidatable(alice), "healthy before");
        SwapAccountView memory v0 = fs.getAccount(alice);

        // ── everything below is one attacker transaction (same block, no MM re-quote in between) ──
        _fund(address(fs), x, 10_000e6);
        _fund(address(fs), y, 10_000e6);
        vm.prank(x);
        sob.placeMarketOrder(false, 5, 1, 5, false); // sweep the MM bid (fair price, no loss)
        vm.prank(x);
        sob.placeLimitOrder(false, 6200, 1, 0); // ask at −38%
        vm.prank(y);
        sob.placeMarketOrder(true, 1, 6200, 1, false); // self-trade: last trade −38%
        vm.prank(x);
        sob.placeLimitOrder(false, 6200, 1, 0); // rest ask −38%
        vm.prank(y);
        sob.placeLimitOrder(true, 6000, 1, 0); // rest bid −40% ⇒ mid −39%
        int256 mark1 = fs.markApr();
        console2.log("markApr before (bp)", mark0 / 1e14);
        console2.log("markApr after  (bp)", mark1 / 1e14);
        console2.log("alice equity before (AUSD e-6)", v0.equity / 1e12);
        console2.log("alice equity after  (AUSD e-6)", fs.getAccount(alice).equity / 1e12);
        console2.log("alice MM (AUSD e-6)", fs.getAccount(alice).maintenanceMargin / 1e12);

        assertFalse(fs.isLiquidatable(alice), "B-01: same-tx mark manipulation makes a healthy account liquidatable");
    }

    // ═══ B-02 (Medium): a swap 'reduction' can grow |K| and leave the account below MM ════════════════════
    /// `_check` classifies risk by |q| only; a pure reduction just needs equity ≥ 0. But K is never reduced
    /// proportionally, so closing q at an off-market APR (the swap book has no price band) turns the position
    /// into a large locked stream whose value is −K·I·τ/YEAR. The account ends with 0 ≤ equity < MM: it is
    /// liquidatable immediately and any index rise before the liquidation is bad debt for the IF, while the
    /// colluding counterparty keeps the mirror stream (a free option paid by the IF). Correct behaviour: a
    /// voluntary trade must not leave an account below maintenance (or must not increase MM).
    function test_B02_swapReductionAtOffMarketAprLeavesAccountBelowMM() public {
        _victimLong();
        _fund(address(fs), y, 10_000e6);
        vm.prank(sam);
        sob.cancelOrder(samBid);
        vm.prank(y);
        sob.placeLimitOrder(true, 1, 100, 0); // colluding bid at price 0.0001 (APR −99.99%)
        assertFalse(fs.isLiquidatable(alice), "healthy before");
        vm.prank(alice);
        try sob.placeMarketOrder(false, 100, 1, 100, true) {
            // reduce-only close is accepted today
            SwapAccountView memory v = fs.getAccount(alice);
            console2.log("after close: size", v.size);
            console2.log("after close: equity (AUSD e-6)", v.equity / 1e12);
            console2.log("after close: MM (AUSD e-6)", v.maintenanceMargin / 1e12);
            // a 20% MON move before the keeper acts turns it into bad debt
            oracle.setPrice(I0 * 12 / 10);
            vm.roll(block.number + 1);
            console2.log("after +20% index: equity (AUSD e-6)", fs.getAccount(alice).equity / 1e12);
            assertFalse(fs.isLiquidatable(alice), "B-02: a voluntary reduce-only trade left the account liquidatable");
        } catch {
            // fixed: the trade is refused
        }
    }
}
