// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReviewBFixture} from "../security/ReviewB.t.sol";
import {IMarginEngine} from "../../src/interfaces/IMarginEngine.sol";
import {SwapAccountView} from "../../src/interfaces/MeridianTypes.sol";

/// @notice B-02 (MATH_SPEC §6.4): a voluntary reduction never creates bad debt and never creates or worsens a
///         maintenance shortfall (slack = equity − MM, the `isLiquidatable` measure). Fixture: alice long 100,000 MON
///         of the 30-day swap at 11.00%, the swap MM quoting 10.90% / 11.10% (ReviewBFixture).
abstract contract ReductionBase is ReviewBFixture {
    function _slack(address who) internal view returns (int256) {
        SwapAccountView memory v = fs.getAccount(who);
        return v.equity - int256(v.maintenanceMargin);
    }

    /// `y` rests a bid of `lots` at `tick` (y is funded) after the MM's bid is cancelled.
    function _bidFromY(uint32 tick, uint64 lots) internal {
        vm.prank(sam);
        sob.cancelOrder(samBid);
        _fund(address(fs), y, 10_000e6);
        vm.prank(y);
        sob.placeLimitOrder(true, tick, lots, 0);
    }
}

contract FundingSwapReductionTest is ReductionBase {
    /// Revert path: closing at −99.99% APR (an off-market colluding bid) would leave 0 ≤ equity < MM.
    function test_reduction_offMarketCloseCreatingShortfallReverts() public {
        _victimLong();
        _bidFromY(1, 100);
        assertGe(_slack(alice), 0, "healthy before");
        vm.prank(alice);
        vm.expectRevert(IMarginEngine.InsufficientMargin.selector);
        sob.placeMarketOrder(false, 100, 1, 100, true);
        assertEq(fs.getAccount(alice).size, 100_000e18, "nothing changed");
    }

    /// An honest close at the market (10.90%) still goes through and leaves no shortfall.
    function test_reduction_closeAtMarketAllowed() public {
        _victimLong();
        _bidFromY(11_090, 100);
        vm.prank(alice);
        sob.placeMarketOrder(false, 100, 11_090, 100, true);
        assertEq(fs.getAccount(alice).size, 0);
        assertGe(_slack(alice), 0);
        assertFalse(fs.isLiquidatable(alice));
    }

    /// A partial close near the mark also passes (no shortfall before or after).
    function test_reduction_partialCloseAtMarketAllowed() public {
        _victimLong();
        _bidFromY(11_090, 40);
        vm.prank(alice);
        sob.placeMarketOrder(false, 40, 11_090, 40, true);
        assertEq(fs.getAccount(alice).size, 60_000e18);
        assertGe(_slack(alice), 0);
    }

    /// An account already below MM may still reduce near the mark: its slack improves, so it is not trapped.
    function test_reduction_shortfallAccountCanReduceWhenItImproves() public {
        _victimLong();
        // an honest market move: the book trades at −38% / −40% and the mark follows over many touched blocks
        _fund(address(fs), x, 10_000e6);
        _fund(address(fs), y, 10_000e6);
        vm.prank(sam);
        sob.cancelOrder(samBid);
        vm.prank(x);
        sob.placeLimitOrder(false, 6200, 30, 0);
        vm.prank(y);
        sob.placeLimitOrder(true, 6000, 100, 0);
        for (uint256 i; i < 15; ++i) {
            vm.prank(y);
            sob.placeMarketOrder(true, 1, 6200, 1, false); // a trade prints at −38% (an input from the next block)
            vm.roll(block.number + 20);
            fs.settle(x); // touch: the bounded mark advances ≤ 10 APR points
        }
        assertTrue(fs.isLiquidatable(alice), "setup: alice below MM");
        int256 before_ = _slack(alice);
        vm.prank(alice);
        sob.placeMarketOrder(false, 50, 6000, 50, true); // sells half at −40%, near the −38..−39% mark
        assertEq(fs.getAccount(alice).size, 50_000e18);
        assertGe(_slack(alice), before_, "slack did not get worse");
    }
}
