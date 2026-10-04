// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReductionBase} from "../unit/FundingSwapReduction.t.sol";

/// @notice B-02 fuzz: for any close price and size, an accepted reduction leaves slack ≥ min(0, slack before) and
///         equity ≥ 0; a refused one changes nothing. MM rounds up (MATH_SPEC §6.4), so slack rounds against the
///         account and the rule errs towards refusing.
contract FundingSwapReductionFuzzTest is ReductionBase {
    function testFuzz_reductionNeverCreatesOrWorsensShortfall(uint256 tick, uint256 lots) public {
        tick = bound(tick, 1, 30_000); // −99.99% … +200% APR
        lots = bound(lots, 1, 100);
        _victimLong();
        _bidFromY(uint32(tick), uint64(lots));
        int256 before_ = _slack(alice);
        int256 sizeBefore = fs.getAccount(alice).size;
        vm.prank(alice);
        try sob.placeMarketOrder(false, uint64(lots), uint32(tick), uint64(lots), true) {
            int256 floor_ = before_ < 0 ? before_ : int256(0);
            assertGe(_slack(alice), floor_, "slack created or worsened");
            assertGe(fs.getAccount(alice).equity, 0, "bad debt");
        } catch {
            assertEq(fs.getAccount(alice).size, sizeBefore, "a refused trade changed the position");
        }
    }
}
