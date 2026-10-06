// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MeridianVaultBase} from "./MeridianVault.t.sol";
import {IMeridianVault} from "../../src/interfaces/IMeridianVault.sol";
import {HedgeState, VaultParams} from "../../src/interfaces/MeridianTypes.sol";

/// @notice CR-014 vault v2 (HARDENING_PLAN P5.2, MATH_SPEC §5.6): idle-only sync withdrawals, the request → fulfil →
///         claim queue, the forced-path cooldown (A-09) and the Safe's emergency unwind. Real CH + OrderBook,
///         MockKuruHedger (ignores the route), as in MeridianVault.t.sol.
contract MeridianVaultQueueTest is MeridianVaultBase {
    bytes constant ROUTE = hex"01";

    // ─── helpers ──────────────────────────────────────────────────────────────
    function _request(address who, uint256 shares) internal returns (uint256 id) {
        vm.prank(who);
        id = vault.requestRedeem(shares, who, who);
    }

    function _ids1(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function _fulfil(uint256[] memory ids) internal {
        vm.prank(keeper);
        vault.fulfillRedeems(ids, ROUTE);
    }

    /// alice 5,000 + bob 2,400 AUSD, hedged by rule (+30% APR, takers net long 300k MON), then past the cooldown.
    function _hedged() internal {
        _whaleLong(3000);
        _setAvgApr(0.3e18);
        _deposit(alice, 5000e6);
        _deposit(bob, 2400e6);
        _rebalanceAll();
        assertTrue(vault.hedgeState().hedged, "setup hedged");
        vm.roll(block.number + 10);
    }

    function _idle() internal view returns (uint256) {
        return ausd.balanceOf(address(vault));
    }

    // ═══ requestRedeem ═══════════════════════════════════════════════════════
    function test_request_escrowsSharesKeepsSupply() public {
        uint256 shares = _deposit(alice, 1000e6);
        uint256 ts = vault.totalSupply();
        vm.expectEmit(true, true, false, true, address(vault));
        emit IMeridianVault.RedeemRequested(1, alice, bob, 400e18);
        vm.prank(alice);
        uint256 id = vault.requestRedeem(400e18, bob, alice);
        assertEq(id, 1, "ids start at 1");
        assertEq(vault.balanceOf(alice), shares - 400e18);
        assertEq(vault.balanceOf(address(vault)), 400e18, "escrowed in the vault");
        assertEq(vault.totalSupply(), ts, "escrowed shares stay in totalSupply");
        assertEq(vault.pendingRedeemShares(), 400e18);
        IMeridianVault.RedeemRequest memory r = vault.getRedeemRequest(id);
        assertEq(r.owner, alice);
        assertEq(r.receiver, bob);
        assertEq(r.shares, 400e18);
        assertEq(r.assets, 0);
        assertEq(r.requestedBlock, block.number);
        assertEq(uint8(r.status), uint8(IMeridianVault.RedeemStatus.Pending));
        assertEq(_request(alice, 1e18), 2, "next id");
    }

    function test_request_operatorNeedsAllowance() public {
        _deposit(alice, 1000e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, bob, 0, 100e18));
        vault.requestRedeem(100e18, bob, alice);
        vm.prank(alice);
        vault.approve(bob, 150e18);
        vm.prank(bob);
        uint256 id = vault.requestRedeem(100e18, bob, alice);
        assertEq(vault.allowance(alice, bob), 50e18, "allowance spent");
        assertEq(vault.getRedeemRequest(id).owner, alice, "owner is the share owner, not the operator");
    }

    function test_request_reverts() public {
        uint256 all = _deposit(alice, 3000e6);
        vm.startPrank(alice);
        vm.expectRevert(IMeridianVault.NothingToDo.selector);
        vault.requestRedeem(0, alice, alice);
        vm.expectRevert(IMeridianVault.InvalidParams.selector);
        vault.requestRedeem(1e18, address(0), alice);
        // previewRedeem(3,000 AUSD of shares) > maxSliceAssets 2,500: split it
        vm.expectRevert(IMeridianVault.RequestTooLarge.selector);
        vault.requestRedeem(all, alice, alice);
        vault.requestRedeem(2000e18, alice, alice); // ≤ 2,500 ok
        vm.expectRevert(); // more than the balance left (1,000 shares)
        vault.requestRedeem(1500e18, alice, alice);
        vm.stopPrank();
    }

    // ═══ cancelRedeem ════════════════════════════════════════════════════════
    function test_cancel_returnsSharesToOwner() public {
        uint256 shares = _deposit(alice, 1000e6);
        uint256 id = _request(alice, 600e18);
        vm.prank(bob);
        vm.expectRevert(IMeridianVault.NotRequestOwner.selector);
        vault.cancelRedeem(id);
        vm.expectEmit(true, false, false, false, address(vault));
        emit IMeridianVault.RedeemCancelled(id);
        vm.prank(alice);
        vault.cancelRedeem(id);
        assertEq(vault.balanceOf(alice), shares);
        assertEq(vault.pendingRedeemShares(), 0);
        assertEq(uint8(vault.getRedeemRequest(id).status), uint8(IMeridianVault.RedeemStatus.Cancelled));
        vm.prank(alice);
        vm.expectRevert(IMeridianVault.NothingToDo.selector); // Pending only
        vault.cancelRedeem(id);
        vm.prank(alice);
        vm.expectRevert(IMeridianVault.RequestNotFound.selector);
        vault.cancelRedeem(99);
    }

    function test_cancel_afterFulfil_reverts() public {
        _deposit(alice, 1000e6);
        uint256 id = _request(alice, 600e18);
        _fulfil(_ids1(id));
        vm.prank(alice);
        vm.expectRevert(IMeridianVault.NothingToDo.selector);
        vault.cancelRedeem(id);
    }

    // ═══ fulfillRedeems from idle ════════════════════════════════════════════
    function test_fulfil_fromIdle_pricesAtNavAndExcludesClaimable() public {
        _deposit(alice, 1000e6);
        _deposit(bob, 1000e6);
        uint256 id = _request(alice, 600e18);
        uint256 expected = vault.previewRedeem(600e18);
        assertEq(expected, 600e6 - 0.3e6, "5 bps fee");
        (uint256 pa, uint256 sell) = vault.previewFulfill(_ids1(id));
        assertEq(pa, expected);
        assertEq(sell, 0, "idle covers it");
        uint256 p0 = vault.sharePrice();
        uint256 ts0 = vault.totalSupply();
        vm.expectEmit(true, false, false, true, address(vault));
        emit IMeridianVault.RedeemFulfilled(id, expected, 0);
        _fulfil(_ids1(id));
        assertEq(vault.claimableAssets(), expected);
        assertEq(vault.totalSupply(), ts0 - 600e18, "escrowed shares burned");
        assertEq(vault.pendingRedeemShares(), 0);
        assertEq(vault.balanceOf(address(vault)), 0);
        assertEq(_idle(), 2000e6, "AUSD still in the vault until the claim");
        assertEq(vault.totalAssets(), 2000e6 - expected, "totalAssets = NAV - claimableAssets");
        assertGe(vault.sharePrice(), p0, "the fee stays with the remaining holders");
        IMeridianVault.RedeemRequest memory r = vault.getRedeemRequest(id);
        assertEq(uint8(r.status), uint8(IMeridianVault.RedeemStatus.Claimable));
        assertEq(r.assets, expected);
    }

    function test_fulfil_reverts() public {
        _deposit(alice, 1000e6);
        uint256 id = _request(alice, 100e18);
        vm.prank(alice);
        vm.expectRevert(IMeridianVault.OnlyKeeper.selector);
        vault.fulfillRedeems(_ids1(id), ROUTE);
        vm.startPrank(keeper);
        vm.expectRevert(IMeridianVault.NothingToDo.selector);
        vault.fulfillRedeems(new uint256[](0), ROUTE);
        vm.expectRevert(IMeridianVault.InvalidParams.selector);
        vault.fulfillRedeems(new uint256[](33), ROUTE); // > MAX_BATCH
        vm.expectRevert(IMeridianVault.NothingToDo.selector); // only unknown ids: nothing to fulfil
        vault.fulfillRedeems(_ids1(42), ROUTE);
        vm.stopPrank();
    }

    /// previewFulfill is O(n²) in the ids: bounded by MAX_BATCH like fulfillRedeems (CLAUDE.md rule 5).
    function test_previewFulfill_boundedByMaxBatch() public {
        _deposit(alice, 1000e6);
        vault.previewFulfill(new uint256[](32));
        vm.expectRevert(IMeridianVault.InvalidParams.selector);
        vault.previewFulfill(new uint256[](33));
    }

    /// 32 ids (the MAX_BATCH bound) incl. one cancelled id and one duplicate: both skipped, no event for them.
    function test_fulfil_batch32_skipsCancelledAndDuplicates() public {
        uint256[] memory ids = new uint256[](32);
        address[] memory who = new address[](31);
        for (uint256 i; i < 31; ++i) {
            who[i] = makeAddr(string.concat("u", vm.toString(i)));
            _deposit(who[i], 100e6);
            ids[i] = _request(who[i], 50e18);
        }
        vm.prank(who[5]);
        vault.cancelRedeem(ids[5]);
        ids[31] = ids[7]; // duplicate
        uint256 each = vault.previewRedeem(50e18);
        vm.recordLogs();
        _fulfil(ids);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 events;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == IMeridianVault.RedeemFulfilled.selector) {
                ++events;
            }
        }
        assertEq(events, 30, "30 distinct pending ids fulfilled once each");
        assertEq(vault.claimableAssets(), 30 * each);
        assertEq(uint8(vault.getRedeemRequest(ids[5]).status), uint8(IMeridianVault.RedeemStatus.Cancelled));
        assertEq(vault.getRedeemRequest(ids[7]).assets, each, "duplicate priced once");
        assertEq(vault.pendingRedeemShares(), 0);
    }

    // ═══ fulfillRedeems beyond idle (pro-rata unwind, cost to the batch) ═════
    function test_fulfil_beyondIdle_unwindsAndChargesBatch() public {
        _hedged();
        hedger.setSpread(0.004e18); // unwinding costs 0.4% on the spot leg
        uint256 p0 = vault.sharePrice();
        uint256 idle0 = _idle();
        uint256 id = _request(bob, vault.balanceOf(bob));
        (uint256 gross, uint256 sell) = vault.previewFulfill(_ids1(id));
        assertGt(gross, idle0, "needs an unwind");
        assertGt(sell, 0, "preview reports the spot to sell");
        uint256 spot0 = vault.hedgeState().spotBase;
        _fulfil(_ids1(id));
        assertEq(spot0 - vault.hedgeState().spotBase, sell, "sold exactly the previewed base");
        IMeridianVault.RedeemRequest memory r = vault.getRedeemRequest(id);
        assertLt(r.assets, gross, "the batch pays the unwind cost");
        assertGe(vault.sharePrice(), p0, "remaining holders not diluted");
        assertGe(_idle(), vault.claimableAssets(), "claimable is backed by idle AUSD");
        (uint256 lo, uint256 so) = ch.openInterest();
        assertEq(lo, so);
        vm.prank(bob);
        assertEq(vault.claimRedeem(id), r.assets);
    }

    /// A-07: with the perp leg under water, fulfil must not unwind everything for a small batch: it reverts and the
    /// Safe uses emergencyUnwind.
    function test_fulfil_perpEquityNonPositive_revertsNoFullUnwind() public {
        _hedged();
        uint256 id = _request(bob, vault.balanceOf(bob));
        _setPrice(I0 * 18 / 10); // +80%: the short's loss exceeds its 40% margin
        assertLe(vault.hedgeState().perpEquity, 0);
        vm.prank(keeper);
        vm.expectRevert(IMeridianVault.SlippageExceeded.selector);
        vault.fulfillRedeems(_ids1(id), ROUTE);
    }

    // ═══ claimRedeem ═════════════════════════════════════════════════════════
    function test_claim_paysReceiver_doubleClaimReverts() public {
        _deposit(alice, 1000e6);
        vm.prank(alice);
        uint256 id = vault.requestRedeem(500e18, bob, alice);
        vm.prank(alice);
        vm.expectRevert(IMeridianVault.NothingToDo.selector); // still Pending
        vault.claimRedeem(id);
        _fulfil(_ids1(id));
        uint256 owed = vault.claimableAssets();
        vm.expectEmit(true, true, false, true, address(vault));
        emit IMeridianVault.RedeemClaimed(id, bob, owed);
        vm.prank(makeAddr("anyone"));
        uint256 out = vault.claimRedeem(id);
        assertEq(out, owed);
        assertEq(ausd.balanceOf(bob), owed, "paid to the receiver");
        assertEq(vault.claimableAssets(), 0);
        assertEq(uint8(vault.getRedeemRequest(id).status), uint8(IMeridianVault.RedeemStatus.Claimed));
        vm.expectRevert(IMeridianVault.NothingToDo.selector);
        vault.claimRedeem(id);
        vm.expectRevert(IMeridianVault.RequestNotFound.selector);
        vault.claimRedeem(77);
        vm.expectRevert(IMeridianVault.RequestNotFound.selector);
        vault.getRedeemRequest(77);
    }

    // ═══ sync path: idle-only, never reverts inside the max (A-11) ═══════════
    function test_sync_maxUsesIdleFree_neverRevertsAtMax() public {
        _deposit(alice, 1000e6);
        _deposit(bob, 1000e6);
        uint256 id = _request(alice, 900e18);
        _fulfil(_ids1(id)); // 899.55 claimable, 1,100.45 idle free
        uint256 free = _idle() - vault.claimableAssets();
        assertLe(vault.maxWithdraw(bob), free);
        uint256 mr = vault.maxRedeem(bob);
        vm.prank(bob);
        vault.redeem(mr, bob, bob);
        assertGe(_idle(), vault.claimableAssets(), "claimable untouched");
        vm.prank(alice);
        assertEq(vault.claimRedeem(id), 900e6 - 0.45e6);
    }

    function test_sync_hedged_maxCappedAtIdleFree() public {
        _hedged();
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 id = _request(alice, aliceShares / 4);
        _fulfil(_ids1(id)); // claimable comes out of idle
        uint256 free = _idle() - vault.claimableAssets();
        uint256 mr = vault.maxRedeem(bob);
        assertLt(mr, vault.balanceOf(bob));
        assertLe(vault.previewRedeem(mr), free, "maxRedeem pays at most idleFree");
        assertLe(vault.maxWithdraw(bob), free);
        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        vault.redeem(mr, bob, bob);
        assertGe(_idle(), vault.claimableAssets());
        vm.revertToState(snap);
        uint256 mw = vault.maxWithdraw(bob);
        vm.prank(bob);
        vault.withdraw(mw, bob, bob);
        assertGe(_idle(), vault.claimableAssets());
        vm.prank(bob);
        vm.expectRevert(); // one more share than the max: ERC4626ExceededMaxRedeem
        vault.redeem(1e18, bob, bob);
    }

    function test_deployBudgetAndMaxDeposit_excludeClaimable() public {
        _whaleLong(3000);
        _deposit(alice, 5000e6);
        uint256 id = _request(alice, 2000e18);
        _fulfil(_ids1(id));
        uint256 owed = vault.claimableAssets();
        assertEq(vault.maxDeposit(bob), 10_000e6 - (5000e6 - owed), "cap measured on NAV without claimable");
        _setAvgApr(0.3e18);
        _rebalanceAll();
        assertTrue(vault.hedgeState().hedged);
        assertGe(_idle(), owed, "the deploy never spends claimable AUSD");
        assertGe(vault.hedgeState().idleAssets, 0);
        vm.prank(alice);
        vault.claimRedeem(id);
    }

    /// Found #24: a rebalance before the fulfil keeps the Pending requests' value idle, so the fulfil needs no unwind.
    function test_deployBudget_reservesPending_fulfilNeedsNoUnwind() public {
        _whaleLong(3000);
        _deposit(alice, 5000e6);
        _deposit(bob, 2400e6);
        _setAvgApr(0.3e18);
        uint256 snap = vm.snapshotState();
        _rebalanceAll();
        uint256 spotNoPending = vault.hedgeState().spotBase;
        vm.revertToState(snap);

        uint256 id = _request(alice, 2400e18);
        uint256 owed = vault.previewRedeem(2400e18);
        _rebalanceAll();
        assertTrue(vault.hedgeState().hedged, "still hedges with the rest");
        uint256 spot0 = vault.hedgeState().spotBase;
        assertLt(spot0, spotNoPending, "budget reduced by the pending value");
        assertGe(_idle(), owed, "pending value stays idle");
        (uint256 gross, uint256 sell) = vault.previewFulfill(_ids1(id));
        assertEq(sell, 0, "no unwind needed");
        _fulfil(_ids1(id));
        assertEq(vault.hedgeState().spotBase, spot0, "fulfil sold no spot");
        assertEq(vault.getRedeemRequest(id).assets, gross, "no unwind cost");
    }

    /// I10 at unit level: deposit → request → fulfil → claim with no price move returns ≤ the deposit.
    function test_roundTrip_noFreeMoney() public {
        _deposit(bob, 1000e6);
        uint256 shares = _deposit(alice, 777e6);
        uint256 id = _request(alice, shares);
        _fulfil(_ids1(id));
        vm.prank(alice);
        uint256 out = vault.claimRedeem(id);
        assertLe(out, 777e6);
        assertGe(out + 777e6 / 1000 + 2, 777e6);
    }

    // ═══ cooldown on forced paths (A-09) ═════════════════════════════════════
    function test_cooldown_forcedPaths() public {
        _whaleLong(3000);
        _setAvgApr(0.3e18);
        _deposit(alice, 5000e6); // two slices of deployment
        vm.startPrank(keeper);
        vault.rebalance(); // rule entry at block B
        vm.expectRevert(IMeridianVault.CooldownActive.selector);
        vault.enterHedge(); // forced: needs 10 blocks since any rebalance
        vault.rebalance(); // the rule path keeps its own gating (no cooldown): second slice, same block
        vm.expectRevert(IMeridianVault.CooldownActive.selector);
        vault.exitHedge();
        vm.expectRevert(IMeridianVault.CooldownActive.selector);
        vault.exitHedgeWithRoute(ROUTE);
        vm.roll(block.number + 9);
        vm.expectRevert(IMeridianVault.CooldownActive.selector);
        vault.exitHedgeWithRoute(ROUTE);
        vm.roll(block.number + 1); // 10 blocks
        vault.exitHedgeWithRoute(ROUTE);
        assertFalse(vault.entered());
        vm.expectRevert(IMeridianVault.CooldownActive.selector);
        vault.enterHedge(); // alternating forced calls (the A-09 drain) need 10 blocks each
        vm.stopPrank();
    }

    function test_exitHedgeWithRoute_onlyKeeper() public {
        vm.prank(alice);
        vm.expectRevert(IMeridianVault.OnlyKeeper.selector);
        vault.exitHedgeWithRoute(ROUTE);
    }

    // ═══ emergencyUnwind (Safe) ══════════════════════════════════════════════
    function test_emergencyUnwind_partialThenFull_noCooldown() public {
        _hedged();
        vm.prank(keeper);
        vault.exitHedgeWithRoute(ROUTE); // forced call: the cooldown is now active for the keeper, not for the Safe
        HedgeState memory h0 = vault.hedgeState();
        uint256 q0 = uint256(-h0.perpSize);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.emergencyUnwind(1, ROUTE);
        vm.expectEmit(false, false, false, false, address(vault));
        emit IMeridianVault.EmergencyUnwind(0, 0, 0);
        vm.prank(owner);
        vault.emergencyUnwind(q0 / 2, ROUTE); // same block as the forced call: exempt
        HedgeState memory h1 = vault.hedgeState();
        assertLe(q0 - uint256(-h1.perpSize), q0 / 2, "bought back at most maxBase");
        assertGt(q0 - uint256(-h1.perpSize), 0);
        assertApproxEqAbs(h1.netDelta, h0.netDelta, 1000e18, "spot sold with the short");
        assertFalse(vault.entered(), "entered state cleared");
        vm.prank(owner);
        vault.emergencyUnwind(type(uint256).max, ROUTE);
        HedgeState memory h2 = vault.hedgeState();
        assertEq(h2.perpSize, 0);
        assertLt(h2.spotBase, 100e18);
        assertLt(ch.getAccount(address(vault)).collateral, 1e12, "collateral withdrawn once flat (< 1 token unit)");
        vm.prank(owner);
        vm.expectRevert(IMeridianVault.NothingToDo.selector);
        vault.emergencyUnwind(type(uint256).max, ROUTE);
    }

    // ═══ gas (reported in HARDENING_LOOP) ════════════════════════════════════
    function test_gas_queue() public {
        address[] memory who = new address[](32);
        uint256[] memory ids = new uint256[](32);
        for (uint256 i; i < 32; ++i) {
            who[i] = makeAddr(string.concat("g", vm.toString(i)));
            _deposit(who[i], 100e6);
        }
        vm.prank(who[0]);
        uint256 g = gasleft();
        ids[0] = vault.requestRedeem(50e18, who[0], who[0]);
        emit log_named_uint("gas requestRedeem (first)", g - gasleft());
        for (uint256 i = 1; i < 32; ++i) {
            ids[i] = _request(who[i], 50e18);
        }
        vm.prank(keeper);
        g = gasleft();
        vault.fulfillRedeems(_ids1(ids[0]), ROUTE);
        emit log_named_uint("gas fulfillRedeems 1 id (idle)", g - gasleft());
        uint256[] memory rest = new uint256[](31);
        for (uint256 i; i < 31; ++i) {
            rest[i] = ids[i + 1];
        }
        vm.prank(keeper);
        g = gasleft();
        vault.fulfillRedeems(rest, ROUTE);
        emit log_named_uint("gas fulfillRedeems 31 ids (idle)", g - gasleft());
        g = gasleft();
        vault.claimRedeem(ids[0]);
        emit log_named_uint("gas claimRedeem", g - gasleft());
    }
}
