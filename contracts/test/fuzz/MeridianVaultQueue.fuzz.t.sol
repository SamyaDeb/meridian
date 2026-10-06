// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MeridianVaultBase} from "../unit/MeridianVault.t.sol";

/// @notice CR-014 queue math (MATH_SPEC §5.6): assets paid ↓, the batch pays its unwind, claimable never in NAV.
contract MeridianVaultQueueFuzzTest is MeridianVaultBase {
    function _ids1(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function _hedged() internal {
        _whaleLong(3000);
        _setAvgApr(0.3e18);
        _deposit(alice, 5000e6);
        _deposit(bob, 2400e6);
        _rebalanceAll();
        vm.roll(block.number + 10);
    }

    /// I10: deposit → request → fulfil → claim with no price move returns ≤ the deposit (and loses at most the fee +
    /// rounding when idle pays it), whatever the other holder and a donation did before.
    function testFuzz_I10_queueRoundTripNoFreeMoney(uint256 a, uint256 b, uint256 donation) public {
        a = bound(a, 1, 2500e6);
        b = bound(b, 1, 4000e6);
        donation = bound(donation, 0, 1000e6);
        _deposit(bob, b);
        if (donation != 0) ausd.mint(address(vault), donation);
        uint256 shares = _deposit(alice, a);
        vm.prank(alice);
        uint256 id = vault.requestRedeem(shares, alice, alice);
        vm.prank(keeper);
        vault.fulfillRedeems(_ids1(id), "");
        uint256 out = vault.claimRedeem(id);
        assertLe(out, a, "no free money");
        assertGe(out + a / 1000 + 2, a, "loses at most the 5 bps fee + rounding");
    }

    /// Found #24 (MATH_SPEC §5.6): with Pending requests outstanding, the rule path deploys only cash above the
    /// buffer + their value (rounded up), so the fulfil afterwards pays from idle with no unwind and no cost.
    function testFuzz_deployReservesPending(uint256 reqShares, uint256 b) public {
        _whaleLong(3000);
        b = bound(b, 1000e6, 5000e6);
        _deposit(alice, 2500e6);
        _deposit(bob, b);
        reqShares = bound(reqShares, 1e18, 2490e18);
        vm.prank(alice);
        uint256 id = vault.requestRedeem(reqShares, alice, alice);
        uint256 owed = vault.previewRedeem(reqShares);
        _setAvgApr(0.3e18);
        _rebalanceAll();
        assertGe(ausd.balanceOf(address(vault)), owed, "pending value kept idle (reserve rounds up)");
        uint256 spot0 = vault.hedgeState().spotBase;
        (uint256 gross, uint256 sell) = vault.previewFulfill(_ids1(id));
        assertEq(sell, 0);
        vm.prank(keeper);
        vault.fulfillRedeems(_ids1(id), "");
        assertEq(vault.hedgeState().spotBase, spot0, "no unwind");
        assertEq(vault.claimRedeem(id), gross, "no unwind cost");
    }

    /// I10 on a hedged vault (the fulfil unwinds through the route): still ≤ the deposit.
    function testFuzz_I10_hedgedQueueRoundTrip(uint256 a, uint256 spreadBps) public {
        _hedged();
        a = bound(a, 1e6, 2400e6);
        hedger.setSpread(bound(spreadBps, 0, 45) * 1e14);
        uint256 shares = _deposit(makeAddr("carol"), a);
        vm.prank(makeAddr("carol"));
        uint256 id = vault.requestRedeem(shares, makeAddr("carol"), makeAddr("carol"));
        vm.prank(keeper);
        vault.fulfillRedeems(_ids1(id), "");
        assertLe(vault.claimRedeem(id), a, "no free money");
    }

    /// Fulfil never moves the remaining holders' share price down, and up by at most the slippage bound (the fee
    /// and rounding dust stay with them; the unwind cost, ≤ maxSlippage per leg, is charged to the batch).
    function testFuzz_fulfilMovesNonRedeemersWithinSlippage(uint256 frac, uint256 spreadBps) public {
        _hedged();
        hedger.setSpread(bound(spreadBps, 0, 45) * 1e14); // < maxSlippage 0.5%: the unwind must succeed
        uint256 shares = vault.balanceOf(bob) * bound(frac, 1, 100) / 100;
        vm.prank(bob);
        uint256 id = vault.requestRedeem(shares, bob, bob);
        uint256 p0 = vault.sharePrice();
        vm.prank(keeper);
        vault.fulfillRedeems(_ids1(id), "");
        uint256 p1 = vault.sharePrice();
        assertGe(p1 + 1, p0, "non-redeemers not diluted");
        assertLe(p1, p0 + p0 * 50 / 10_000, "moved by at most maxSlippage");
        assertLe(vault.convertToAssets(vault.totalSupply()), vault.totalAssets(), "I8");
        assertGe(ausd.balanceOf(address(vault)), vault.claimableAssets(), "claimable backed");
    }

    /// A-11: with claimable outstanding (hedged or not), the sync max never reverts and never pays claimable AUSD.
    function testFuzz_syncMaxNeverRevertsNorSpendsClaimable(uint256 frac, bool hedge, bool useWithdraw) public {
        if (hedge) {
            _hedged();
        } else {
            _deposit(alice, 5000e6);
            _deposit(bob, 2400e6);
        }
        uint256 shares = vault.balanceOf(alice) * bound(frac, 1, 45) / 100;
        vm.prank(alice);
        uint256 id = vault.requestRedeem(shares, alice, alice);
        vm.prank(keeper);
        vault.fulfillRedeems(_ids1(id), "");
        uint256 owed = vault.claimableAssets();
        if (useWithdraw) {
            uint256 mw = vault.maxWithdraw(bob);
            vm.prank(bob);
            vault.withdraw(mw, bob, bob);
        } else {
            uint256 mr = vault.maxRedeem(bob);
            vm.prank(bob);
            vault.redeem(mr, bob, bob);
        }
        assertGe(ausd.balanceOf(address(vault)), owed, "claimable untouched");
        assertEq(vault.claimRedeem(id), owed);
    }
}
