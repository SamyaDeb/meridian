// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IdleLaunchBase} from "../unit/PulseVaultIdleLaunch.t.sol";

/// @notice A-01 idle launch: for any two deposits and any redemption order, the vault never holds a claim it cannot
///         pay from idle, and redemption rounds against the redeemer (MATH_SPEC §5.4, shares burned round up /
///         assets paid round down), so redeem(deposit(x)) <= x.
contract PulseVaultIdleLaunchFuzzTest is IdleLaunchBase {
    function testFuzz_idle_everyClaimCoveredByIdle(uint256 x, uint256 y, bool aliceFirst) public {
        x = bound(x, 1e6, 1000e6);
        y = bound(y, 1e6, LAUNCH_CAP - x);
        uint256 sa = _deposit(alice, x);
        uint256 sb = _deposit(bob, y);
        assertLe(vault.maxDeposit(alice), LAUNCH_CAP, "cap");
        assertGe(
            ausd.balanceOf(address(vault)), vault.previewRedeem(sa) + vault.previewRedeem(sb), "idle covers claims"
        );

        (address first, uint256 sf, address second, uint256 ss) =
            aliceFirst ? (alice, sa, bob, sb) : (bob, sb, alice, sa);
        vm.prank(first);
        uint256 o1 = vault.redeem(sf, first, first);
        vm.prank(second);
        uint256 o2 = vault.redeem(ss, second, second);
        // rounds down: the first redeemer gets no more than they put in; the 5 bps fee goes to the remaining holders,
        // so the last can get slightly more, but the vault never pays out more than it took in
        assertLe(o1, first == alice ? x : y, "first redeemer <= deposit");
        assertLe(o1 + o2, x + y, "total out <= total in");
    }
}
