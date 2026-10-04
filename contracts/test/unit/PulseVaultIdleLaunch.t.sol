// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PulseVaultBase} from "./PulseVault.t.sol";
import {RouteOnlyHedger} from "../review/ReviewA.t.sol";
import {PulseVault} from "../../src/vault/PulseVault.sol";
import {IPulseVault} from "../../src/interfaces/IPulseVault.sol";
import {VaultParams} from "../../src/interfaces/PulseTypes.sol";

/// @notice A-01 idle launch (PHASES decision, 5 Oct 2026): until CR-010 lands, the mainnet vault launches with
///         `skewCapacity = 0`, so the hedge target is 0 whatever the keeper does and every redemption is served from
///         idle AUSD. The hedger here is the 143 shape (route-only: the empty route cannot fill), the entry rule is
///         fully on (skew available, funding at +30% APR), the keeper and the skew provider are wired as DeployPulse
///         wires them, and the cap is the launch cap (1,200 AUSD).
abstract contract IdleLaunchBase is PulseVaultBase {
    RouteOnlyHedger rh;
    bytes constant FLOW = hex"01";
    uint256 constant LAUNCH_CAP = 1200e6;

    function _params() internal pure override returns (VaultParams memory p) {
        p = super._params();
        p.depositCap = LAUNCH_CAP;
        p.skewCapacity = 0; // idle launch
    }

    function setUp() public virtual override {
        super.setUp();
        rh = new RouteOnlyHedger(address(wmon), address(ausd), I0);
        vault = new PulseVault(ausd, address(ch), address(ob), address(rh), _params(), owner);
        vm.startPrank(owner);
        vault.setKeeper(keeper, true);
        vault.setSkewProvider(mm, true);
        vm.stopPrank();
        _whaleLong(3000); // takers are net long ⇒ with skewCapacity > 0 there would be capacity to hedge against
        _setAvgApr(0.3e18); // funding well above the entry threshold
    }
}

contract PulseVaultIdleLaunchTest is IdleLaunchBase {
    function test_idle_noCapacityNoHedgeTarget() public {
        _deposit(alice, 700e6);
        assertEq(vault.shortCapacity(), 0, "skewCapacity 0 gives capacity 0");
        assertEq(uint256(vault.needsRebalance()), uint256(IPulseVault.RebalanceReason.None), "nothing to do");
    }

    function test_idle_keeperCannotHedge() public {
        _deposit(alice, 700e6);
        vm.startPrank(keeper);
        vm.expectRevert(); // NothingToDo
        vault.rebalance();
        vm.expectRevert();
        vault.rebalanceWithRoute(FLOW);
        vm.expectRevert();
        vault.enterHedge();
        vm.stopPrank();
        assertFalse(vault.hedgeState().hedged, "still idle");
        assertEq(vault.hedgeState().spotBase, 0);
        assertEq(vault.hedgeState().perpSize, 0);
    }

    /// A-01 regression (idle shape): everything up to the 1,200 AUSD cap can be redeemed in full from idle with the
    /// route-only hedger, the exact setup in which the hedged vault reverts SlippageExceeded.
    function test_idle_depositsToCapAreFullyRedeemable() public {
        uint256 a = _deposit(alice, 700e6);
        uint256 b = _deposit(bob, 500e6);
        assertEq(vault.maxDeposit(alice), 0, "cap reached");
        ausd.mint(alice, 1e6);
        vm.startPrank(alice);
        ausd.approve(address(vault), 1e6);
        vm.expectRevert(); // ERC4626ExceededMaxDeposit: the cap refuses what it could not cover
        vault.deposit(1e6, alice);
        vm.stopPrank();

        assertGe(ausd.balanceOf(address(vault)), vault.previewRedeem(a) + vault.previewRedeem(b), "idle covers all");
        vm.prank(alice);
        uint256 outA = vault.redeem(a, alice, alice);
        vm.prank(bob);
        uint256 outB = vault.redeem(b, bob, bob);
        assertLe(outA, 700e6, "the first redeemer gets no more than the deposit (rounds against the redeemer)");
        // the 5 bps fee goes to the remaining holders, so the last redeemer can get slightly more than they put in;
        // what must hold is that the vault never pays out more than it took in
        assertLe(outA + outB, 1200e6, "total out <= total in");
        assertGt(outA + outB, 1195e6, "only the fee-bounded dust stays behind");
        assertEq(vault.balanceOf(alice) + vault.balanceOf(bob), 0);
    }

    /// `withdraw` of the maximum also never needs a route.
    function test_idle_maxWithdrawServedFromIdle() public {
        _deposit(alice, 700e6);
        _deposit(bob, 500e6);
        uint256 w = vault.maxWithdraw(alice);
        assertGt(w, 0);
        vm.prank(alice);
        vault.withdraw(w, alice, alice);
        assertEq(ausd.balanceOf(alice), w);
    }

    /// The Safe can raise skewCapacity later (`setVaultParams`) to start hedging once CR-010 is applied.
    function test_idle_safeCanEnableHedgeLater() public {
        _deposit(alice, 700e6);
        VaultParams memory p = vault.vaultParams();
        p.skewCapacity = 0.8e18;
        vm.prank(owner);
        vault.setVaultParams(p);
        assertGt(vault.shortCapacity(), 0);
    }
}
