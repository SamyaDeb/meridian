// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReviewBFixture} from "../security/ReviewB.t.sol";

/// @notice B-01 regression and bound tests for the swap mark (MATH_SPEC §6.3): the first touch of a block fixes the
///         mark for that block, and across blocks it follows the live mark by at most MARK_MAX_STEP_PER_BLOCK per
///         elapsed block, capped at MARK_MAX_ELAPSED_BLOCKS.
abstract contract MarkAttackBase is ReviewBFixture {
    /// The B-01 attack: sweep the MM bid, print a self-trade at −38%, rest a −40%/−38% book (one block).
    function _attack() internal {
        _fund(address(fs), x, 10_000e6);
        _fund(address(fs), y, 10_000e6);
        vm.prank(x);
        sob.placeMarketOrder(false, 5, 1, 5, false);
        vm.prank(x);
        sob.placeLimitOrder(false, 6200, 1, 0);
        vm.prank(y);
        sob.placeMarketOrder(true, 1, 6200, 1, false);
        vm.prank(x);
        sob.placeLimitOrder(false, 6200, 1, 0);
        vm.prank(y);
        sob.placeLimitOrder(true, 6000, 1, 0);
    }

    function _abs(int256 v) internal pure returns (int256) {
        return v < 0 ? -v : v;
    }
}

contract FundingSwapMarkTest is MarkAttackBase {
    /// Same block: the mark the attacker's own transaction sees is the one fixed at the first touch.
    function test_mark_fixedWithinBlock() public {
        _victimLong();
        int256 before_ = fs.markApr();
        _attack();
        assertEq(fs.markApr(), before_, "mark moved inside the attack block");
        assertFalse(fs.isLiquidatable(alice));
    }

    /// Next block: the manipulated book moves the mark by at most one step.
    function test_mark_nextBlockMovesAtMostOneStep() public {
        _victimLong();
        _attack();
        int256 atAttack = fs.markApr();
        vm.roll(block.number + 1);
        assertLe(_abs(fs.markApr() - atAttack), fs.MARK_MAX_STEP_PER_BLOCK());
    }

    /// After a long idle period the move is capped at MARK_MAX_ELAPSED_BLOCKS steps, not the full ±50 points.
    function test_mark_idleMoveCapped() public {
        _victimLong();
        _attack();
        int256 atAttack = fs.markApr();
        vm.roll(block.number + 100_000);
        assertLe(_abs(fs.markApr() - atAttack), fs.MARK_MAX_STEP_PER_BLOCK() * int256(fs.MARK_MAX_ELAPSED_BLOCKS()));
    }

    /// A sustained manipulation still cannot liquidate the victim inside one block-step: one refresh (≤ 10 points,
    /// ≈ 0.8% of notional at τ = 30 d) stays under the IM–MM gap.
    function test_mark_oneRefreshDoesNotLiquidateHealthyAccount() public {
        _victimLong();
        _attack();
        vm.roll(block.number + 100_000);
        assertFalse(fs.isLiquidatable(alice), "one capped refresh liquidated a healthy account");
    }

    /// A touch (any hook) in a later block stores the bounded mark, and views agree with it for that block.
    function test_mark_touchStoresBoundedMark() public {
        _victimLong();
        _attack();
        int256 atAttack = fs.markApr();
        vm.roll(block.number + 3);
        int256 viewMark = fs.markApr();
        vm.prank(alice);
        fs.settle(alice); // a touch
        assertEq(fs.markApr(), viewMark, "view and stored mark differ");
        assertLe(_abs(viewMark - atAttack), 3 * fs.MARK_MAX_STEP_PER_BLOCK());
    }
}
