// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MarkAttackBase} from "../unit/FundingSwapMark.t.sol";

/// @notice Fuzz of the B-01 per-block bound (MATH_SPEC §6.3, rounds neutral: the bound is symmetric, so the assertion
///         is on |Δ| in both directions).
contract FundingSwapMarkFuzzTest is MarkAttackBase {
    function testFuzz_markMoveBoundedByElapsedBlocks(uint256 elapsed) public {
        elapsed = bound(elapsed, 1, 1_000_000);
        _victimLong();
        _attack();
        int256 atAttack = fs.markApr();
        vm.roll(block.number + elapsed);
        uint256 steps = elapsed < fs.MARK_MAX_ELAPSED_BLOCKS() ? elapsed : fs.MARK_MAX_ELAPSED_BLOCKS();
        assertLe(_abs(fs.markApr() - atAttack), fs.MARK_MAX_STEP_PER_BLOCK() * int256(steps));
    }
}
