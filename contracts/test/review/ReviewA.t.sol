// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MeridianVaultBase} from "../unit/MeridianVault.t.sol";
import {MeridianVault} from "../../src/vault/MeridianVault.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {IKuruHedger} from "../../src/interfaces/IKuruHedger.sol";
import {IMeridianVault} from "../../src/interfaces/IMeridianVault.sol";
import {MeridianConstants, HedgeState, VaultParams, RiskParams} from "../../src/interfaces/MeridianTypes.sol";

/// @notice SCRATCH (security review A, docs/outputs/security/review-A.md). Each test states the behaviour the fix must
///         produce and FAILS on the reviewed code (main @ 47ea85f). Handed to B: move them into the vault's unit tests
///         in B's fix branch. They are not on `main`, so `forge test` there stays green.

/// @dev Mainnet shape of the spot leg: the direct Kuru MON/AUSD market is dead (ARCHITECTURE R19, config/143.json
///      `_monAusdMarket`), so an EMPTY route cannot fill (the real KuruHedger then fails its balance-delta minOut
///      check: SlippageExceeded). A non-empty route stands for a Kuru Flow quote and fills at the oracle price.
contract RouteOnlyHedger is IKuruHedger {
    address public immutable baseToken;
    address public immutable quoteToken;
    address public constant kuruMarket = address(0);
    address public constant flowEntrypoint = address(0xF10);
    uint256 public priceWad;

    constructor(address base_, address quote_, uint256 p) {
        (baseToken, quoteToken, priceWad) = (base_, quote_, p);
    }

    function setPrice(uint256 p) external {
        priceWad = p;
    }

    function buySpot(uint256 quoteIn, uint256 minBaseOut, bytes calldata route) external returns (uint256 baseOut) {
        if (route.length == 0) revert SlippageExceeded(); // dead direct market: nothing fills
        MockERC20(quoteToken).burn(msg.sender, quoteIn);
        baseOut = quoteIn * MeridianConstants.AUSD_TO_WAD * MeridianConstants.WAD / priceWad;
        if (baseOut < minBaseOut) revert SlippageExceeded();
        MockERC20(baseToken).mint(msg.sender, baseOut);
    }

    function sellSpot(uint256 baseIn, uint256 minQuoteOut, bytes calldata route) external returns (uint256 quoteOut) {
        if (route.length == 0) revert SlippageExceeded();
        MockERC20(baseToken).burn(msg.sender, baseIn);
        quoteOut = baseIn * priceWad / MeridianConstants.WAD / MeridianConstants.AUSD_TO_WAD;
        if (quoteOut < minQuoteOut) revert SlippageExceeded();
        MockERC20(quoteToken).mint(msg.sender, quoteOut);
    }

    function bestBidAsk() external view returns (uint256, uint256) {
        return (priceWad, priceWad);
    }
}

/// A-01 (High), acceptance tests for CR-014 (vault v2, HARDENING_PLAN P5): on the mainnet wiring the empty route is
/// the dead direct market, so every path that sells spot must take a keeper/Safe route. Before CR-014 a hedged vault
/// locked every deposit beyond idle (sync redeem unwound through the empty route ⇒ SlippageExceeded) and neither the
/// keeper nor the Safe could force it flat. After: sync withdrawals are idle-only (capped, never reverting inside the
/// max), beyond idle a request is fulfilled by the keeper WITH a route and claimed, the keeper has a routed forced
/// exit, and the Safe has `emergencyUnwind`. These tests run always (the REVIEW_A01_OPEN gate is gone).
contract ReviewA01_RouteOnlyUnwind is MeridianVaultBase {
    RouteOnlyHedger rh;
    bytes constant FLOW = hex"01";

    function setUp() public override {
        super.setUp();
        rh = new RouteOnlyHedger(address(wmon), address(ausd), I0);
        vault = new MeridianVault(ausd, address(ch), address(ob), address(rh), _params(), owner);
        vm.startPrank(owner);
        vault.setKeeper(keeper, true);
        vault.setSkewProvider(mm, true);
        vm.stopPrank();
    }

    /// alice 5,000 + bob 2,400 AUSD (one request ≤ maxSliceAssets 2,500), hedged through the Flow route.
    function _hedgeViaFlow() internal {
        _whaleLong(3000);
        _setAvgApr(0.3e18);
        _deposit(alice, 5000e6);
        _deposit(bob, 2400e6);
        for (uint256 i; i < 20 && vault.needsRebalance() != IMeridianVault.RebalanceReason.None; ++i) {
            vm.prank(keeper);
            vault.rebalanceWithRoute(FLOW);
            vm.roll(block.number + 1);
        }
        assertTrue(vault.hedgeState().hedged, "setup: hedged through the Flow route");
        vm.roll(block.number + 10); // past the forced-path cooldown
    }

    /// Beyond idle: request → keeper fulfils with a route → anyone claims; bob is paid more than the idle buffer.
    function test_A01_requestFulfilClaim_beyondIdle_withRoute() public {
        _hedgeViaFlow();
        uint256 idle = ausd.balanceOf(address(vault));
        uint256 shares = vault.balanceOf(bob);
        assertGt(vault.previewRedeem(shares), idle, "bob's claim exceeds idle");
        vm.prank(bob);
        uint256 id = vault.requestRedeem(shares, bob, bob);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        // the empty route still can't sell spot: the fulfil reverts clearly instead of locking anything
        vm.prank(keeper);
        vm.expectRevert(IKuruHedger.SlippageExceeded.selector);
        vault.fulfillRedeems(ids, "");
        vm.prank(keeper);
        vault.fulfillRedeems(ids, FLOW);
        vm.prank(alice); // anyone may claim; the AUSD goes to the receiver
        uint256 out = vault.claimRedeem(id);
        assertEq(ausd.balanceOf(bob), out);
        assertGt(out, idle, "paid beyond idle");
        assertApproxEqRel(out, 2400e6, 0.003e18, "fee + unwind cost only");
        assertEq(vault.balanceOf(bob), 0);
    }

    /// The sync path beyond idle is capped (maxRedeem / maxWithdraw ≤ idle) and never reverts inside the max (A-11).
    function test_A01_syncRedeemBeyondIdle_isCappedNotReverting() public {
        _hedgeViaFlow();
        uint256 idle = ausd.balanceOf(address(vault));
        uint256 maxShares = vault.maxRedeem(bob);
        assertLt(maxShares, vault.balanceOf(bob), "capped below bob's balance");
        assertLe(vault.previewRedeem(maxShares), idle);
        assertLe(vault.maxWithdraw(bob), idle);
        vm.prank(bob);
        uint256 out = vault.redeem(maxShares, bob, bob);
        assertGt(out, 0);
        assertLe(out, idle);
        uint256 mw = vault.maxWithdraw(alice);
        vm.prank(alice);
        vault.withdraw(mw, alice, alice); // what's left of idle: also inside the max
    }

    /// The keeper's routed forced exit works; the empty-route forced exit still reverts clearly.
    function test_A01_forcedExit_worksWithRouteOnlyHedger() public {
        _hedgeViaFlow();
        int256 size0 = vault.hedgeState().perpSize;
        vm.prank(keeper);
        vm.expectRevert(IKuruHedger.SlippageExceeded.selector);
        vault.exitHedge();
        vm.prank(keeper);
        vault.exitHedgeWithRoute(FLOW);
        assertGt(vault.hedgeState().perpSize, size0, "short reduced");
        assertFalse(vault.entered());
    }

    /// The Safe can force a hedged vault flat through a route, in one call, while entered.
    function test_A01_emergencyUnwind_flattensHedgedVault() public {
        _hedgeViaFlow();
        assertTrue(vault.entered());
        uint256 nav0 = vault.totalAssets();
        vm.prank(owner);
        vault.emergencyUnwind(type(uint256).max, FLOW);
        HedgeState memory h = vault.hedgeState();
        assertEq(h.perpSize, 0, "perp flat");
        assertLt(h.spotBase, 100e18, "spot sold (< 1 lot)");
        assertLt(ch.getAccount(address(vault)).collateral, 1e12, "collateral back in the vault (< 1 token unit)");
        assertFalse(vault.entered());
        assertApproxEqRel(vault.totalAssets(), nav0, 0.003e18, "NAV kept, minus the unwind cost");
        // everyone can now leave through the sync path
        uint256 bobShares = vault.balanceOf(bob);
        assertEq(vault.maxRedeem(bob), bobShares, "all of bob's shares are redeemable from idle");
        vm.prank(bob);
        vault.redeem(bobShares, bob, bob);
    }
}

/// A-02 (Medium): one lot (100 MON ≈ $2.7) of WMON donated to a flat, not-entered vault makes `_needs` return
/// ExitHedge forever and `_exitSlice` revert NothingToDo (q = 0 ⇒ `_reduceBoth(0)`): the entry rule can never fire.
contract ReviewA02_DonationBricksRule is MeridianVaultBase {
    function test_A02_wmonDonation_doesNotBlockRuleBasedEntry() public {
        _whaleLong(3000);
        _deposit(alice, 5000e6);
        wmon.mint(address(vault), 100e18); // griefer: one lot of WMON
        _setAvgApr(0.3e18); // entry test passes
        // Expected: the rule path still works (sell the stray spot, or enter). Today: ExitHedge + NothingToDo.
        vm.prank(keeper);
        vault.rebalance();
        _rebalanceAll();
        assertTrue(vault.hedgeState().hedged, "vault entered by rule despite the donation");
    }

    /// Same state reached by `exitHedge()`: the forced exit can't clear stray spot either.
    function test_A02_wmonDonation_exitHedgeClearsSpot() public {
        _deposit(alice, 5000e6);
        wmon.mint(address(vault), 100e18);
        vm.prank(keeper);
        vault.exitHedge();
        assertLt(vault.hedgeState().spotBase, 100e18);
    }
}

/// A-03 (Medium): MarginLow tops up only from idle and reduces the legs only when idle == 0 exactly. A griefer who
/// sends 1 unit (1e-6 AUSD) before each keeper rebalance keeps the top-up at dust: no margin added, no reduction,
/// and a further pump liquidates the vault's short.
contract ReviewA03_DustIdleMarginLow is MeridianVaultBase {
    function test_A03_dustIdle_marginLowStillMakesProgress() public {
        _whaleLong(3000);
        _setAvgApr(0.3e18);
        _deposit(alice, 10_000e6);
        _rebalanceAll();
        _setPrice(I0 * 145 / 100); // +45%
        vm.roll(block.number + 1);
        // first MarginLow uses the real idle buffer
        vm.prank(keeper);
        vault.rebalance();
        vm.roll(block.number + 1);
        assertEq(uint8(vault.needsRebalance()), uint8(IMeridianVault.RebalanceReason.MarginLow), "still low");
        assertEq(ausd.balanceOf(address(vault)), 0, "idle spent");
        HedgeState memory h0 = vault.hedgeState();
        // griefer front-runs the keeper with 1 unit
        ausd.mint(address(vault), 1);
        vm.prank(keeper);
        vault.rebalance();
        HedgeState memory h1 = vault.hedgeState();
        // Expected: the keeper's call reduces the legs (or restores the ratio). Today: 1 unit deposited, nothing else.
        assertTrue(
            h1.marginRatio >= 0.25e18 || uint256(-h1.perpSize) < uint256(-h0.perpSize),
            "MarginLow rebalance made no progress"
        );
    }
}

/// A-04 (Medium): `_targetBase` ignores the CH per-account `maxPositionSize`. With the launch config (perp cap 25k MON,
/// vault depositCap 1,200 AUSD, PHASES decision 12) the target N/P = 0.57·1,200/P exceeds 25k MON whenever MON <
/// ≈ $0.0274 (today ≈ 0.0272): the first (only) slice reverts PositionCapExceeded and the vault never deploys, while
/// needsRebalance keeps reporting EnterHedge/Deploy.
contract ReviewA04_TargetIgnoresPositionCap is MeridianVaultBase {
    function _params() internal pure override returns (VaultParams memory p) {
        p = super._params();
        p.depositCap = 1200e6;
    }

    function test_A04_launchCaps_vaultDeploysUpToPositionCap() public {
        _whaleLong(3000); // takers net long 300k MON ⇒ capacity 240k, not the binding limit
        _setPrice(0.0272e18);
        _quote(27_200, 2000);
        RiskParams memory r = ch.riskParams();
        r.maxPositionSize = 25_000e18; // config/143.json launch cap
        vm.prank(owner);
        ch.setRiskParams(r);
        _setAvgApr(0.3e18);
        _deposit(alice, 1200e6);
        // Expected: the vault shorts min(N/P, capacity, maxPositionSize) = 25k MON. Today: PositionCapExceeded.
        _rebalanceAll();
        HedgeState memory h = vault.hedgeState();
        assertTrue(h.hedged, "vault deployed");
        assertLe(uint256(-h.perpSize), 25_000e18);
    }
}
