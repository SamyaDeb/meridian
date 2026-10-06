// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MeridianVaultBase} from "../unit/MeridianVault.t.sol";

/// @notice ERC-4626 rounding (MATH_SPEC §5.4): shares minted ↓, assets out ↓, shares burned ↑.
contract MeridianVaultFuzzTest is MeridianVaultBase {
    /// I10: deposit → redeem with no price move returns ≤ the deposit (and ≥ deposit − fee − 1).
    function testFuzz_roundTripNoFreeMoney(uint256 a, uint256 b, uint256 donation) public {
        a = bound(a, 1, 4000e6);
        b = bound(b, 1, 4000e6);
        donation = bound(donation, 0, 1000e6);
        _deposit(bob, b);
        if (donation != 0) {
            ausd.mint(address(vault), donation); // someone donates: raises the price for existing holders only
        }
        uint256 shares = _deposit(alice, a);
        vm.prank(alice);
        uint256 out = vault.redeem(shares, alice, alice);
        assertLe(out, a, "no free money");
        assertGe(out + a / 1000 + 2, a, "loses at most the 5 bps fee + rounding");
    }

    /// withdraw(assets) burns ≥ the shares redeem would need for the same assets; share price never falls.
    function testFuzz_withdrawBurnsUpSharePriceMonotone(uint256 a, uint256 w) public {
        a = bound(a, 1e6, 5000e6);
        uint256 shares = _deposit(alice, a);
        _deposit(bob, 1000e6);
        uint256 p0 = vault.sharePrice();
        w = bound(w, 1, vault.maxWithdraw(alice));
        vm.prank(alice);
        uint256 burned = vault.withdraw(w, alice, alice);
        assertLe(burned, shares);
        assertGe(vault.previewRedeem(burned), w, "burned shares are worth at least what was paid");
        assertGe(vault.sharePrice(), p0, "a withdrawal never lowers the share price");
    }
}
