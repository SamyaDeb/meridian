// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClearingHouse} from "../../../src/clearing/ClearingHouse.sol";
import {OrderBook} from "../../../src/orderbook/OrderBook.sol";
import {MeridianVault} from "../../../src/vault/MeridianVault.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../../src/mocks/MockOracleAdapter.sol";
import {MockKuruHedger} from "../../../src/mocks/MockKuruHedger.sol";
import {IFundingRateOracle} from "../../../src/interfaces/IFundingRateOracle.sol";
import {IMeridianVault} from "../../../src/interfaces/IMeridianVault.sol";

/// @notice WS-04 handler for I8 / I10 on the REAL perp ClearingHouse + OrderBook (MockKuruHedger spot leg).
///         Actions: deposit, redeem, withdraw (idle-only, CR-014), requestRedeem / cancelRedeem / keeper
///         fulfillRedeems / claimRedeem (the async queue), keeper rebalance, funding regime (r̄ pinned), price moves
///         (index + Kuru together), taker skew changes, block rolls. try/catch everywhere; ghosts only on success.
///         Ghosts: per-actor net cash (withdrawn − deposited) for I10 checks at no price move; share-price floor
///         across deposit/withdraw-only steps for I8.
contract VaultHandler is Test {
    MeridianVault public vault;
    ClearingHouse public ch;
    OrderBook public ob;
    MockERC20 public ausd;
    MockOracleAdapter public oracle;
    MockKuruHedger public hedger;
    address public keeper;
    address public whale;
    address public mm;
    address[] public actors;
    uint64[] internal _mmIds;

    uint256 public depositsOk;
    uint256 public withdrawalsOk;
    uint256 public unwindWithdrawals; // fulfils that needed an unwind (CR-014: the sync path never unwinds)
    uint256 public syncBeyondIdle; // sync withdrawals that paid more than idleFree (must stay 0)
    uint256 public requestsOk;
    uint256 public cancelsOk;
    uint256 public fulfilsOk; // fulfillRedeems calls that succeeded
    uint256 public fulfilledIds;
    uint256 public claimsOk;
    uint256 public claimedAssets;
    uint256[] internal _openIds; // requested, not yet claimed or cancelled (bounded by the run depth)
    uint256 public rebalancesOk;
    uint256 public priceMoves;
    /// @dev I8: share price fell across a deposit/withdraw (must stay false)
    bool public sharePriceFellOnFlow;
    uint256 public maxFallWei;

    constructor(
        MeridianVault vault_,
        ClearingHouse ch_,
        OrderBook ob_,
        MockOracleAdapter oracle_,
        MockKuruHedger hedger_
    ) {
        (vault, ch, ob, oracle, hedger) = (vault_, ch_, ob_, oracle_, hedger_);
        ausd = MockERC20(vault_.asset());
    }

    function setRoles(address keeper_, address whale_, address mm_, address[] memory actors_) external {
        (keeper, whale, mm) = (keeper_, whale_, mm_);
        actors = actors_;
    }

    /// The MM (registered skew provider) re-quotes 3 × 2,000 lots per side around the index.
    function requote() public {
        uint32 mid = uint32(oracle.price() / 1e12);
        vm.startPrank(mm);
        for (uint256 i; i < _mmIds.length; ++i) {
            if (ob.getOrder(_mmIds[i]).remainingLots != 0) ob.cancelOrder(_mmIds[i]);
        }
        delete _mmIds;
        for (uint32 i = 1; i <= 3; ++i) {
            (uint64 b,) = ob.placeLimitOrder(true, mid - 10 * i, 2000, 0);
            (uint64 a,) = ob.placeLimitOrder(false, mid + 10 * i, 2000, 0);
            _mmIds.push(b);
            _mmIds.push(a);
        }
        vm.stopPrank();
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    /// I8 on a deposit/withdraw: the share price may not drop (1 wei of WAD tolerance for the division).
    function _checkFlow(uint256 p0) internal {
        uint256 p1 = vault.sharePrice();
        if (p1 + 1 < p0) {
            sharePriceFellOnFlow = true;
            if (p0 - p1 > maxFallWei) maxFallWei = p0 - p1;
        }
    }

    function deposit(uint256 who, uint256 amt) external {
        address a = _actor(who);
        amt = bound(amt, 1, 3000e6);
        if (amt > vault.maxDeposit(a)) return;
        ausd.mint(a, amt);
        uint256 p0 = vault.sharePrice();
        vm.startPrank(a);
        ausd.approve(address(vault), amt);
        try vault.deposit(amt, a) {
            ++depositsOk;
        } catch {}
        vm.stopPrank();
        _checkFlow(p0);
    }

    function _idleFree() internal view returns (uint256) {
        uint256 b = ausd.balanceOf(address(vault));
        uint256 c = vault.claimableAssets();
        return b > c ? b - c : 0;
    }

    /// Sync redeem within maxRedeem (idle-only): must succeed and pay ≤ idleFree.
    function redeem(uint256 who, uint256 frac) external {
        address a = _actor(who);
        uint256 shares = vault.maxRedeem(a) * bound(frac, 1, 100) / 100;
        if (shares == 0) return;
        uint256 free = _idleFree();
        uint256 p0 = vault.sharePrice();
        vm.prank(a);
        try vault.redeem(shares, a, a) returns (uint256 out) {
            ++withdrawalsOk;
            if (out > free) ++syncBeyondIdle;
        } catch {}
        _checkFlow(p0);
    }

    function withdraw(uint256 who, uint256 amt) external {
        address a = _actor(who);
        uint256 max = vault.maxWithdraw(a);
        if (max == 0) return;
        amt = bound(amt, 1, max);
        uint256 free = _idleFree();
        uint256 p0 = vault.sharePrice();
        vm.prank(a);
        try vault.withdraw(amt, a, a) {
            ++withdrawalsOk;
            if (amt > free) ++syncBeyondIdle;
        } catch {}
        _checkFlow(p0);
    }

    // ─── CR-014 queue ─────────────────────────────────────────────────────────
    function requestRedeem(uint256 who, uint256 frac) external {
        address a = _actor(who);
        uint256 shares = vault.balanceOf(a) * bound(frac, 1, 100) / 100;
        if (shares == 0) return;
        // one request ≤ one slice (RequestTooLarge): shrink to fit
        while (shares != 0 && vault.previewRedeem(shares) > 2500e6) {
            shares /= 2;
        }
        if (shares == 0) return;
        vm.prank(a);
        try vault.requestRedeem(shares, a, a) returns (uint256 id) {
            ++requestsOk;
            _openIds.push(id);
        } catch {}
    }

    function cancelRedeem(uint256 idx) external {
        if (_openIds.length == 0) return;
        uint256 id = _openIds[idx % _openIds.length];
        try vault.getRedeemRequest(id) returns (IMeridianVault.RedeemRequest memory r) {
            if (r.status != IMeridianVault.RedeemStatus.Pending) return;
            vm.prank(r.owner);
            try vault.cancelRedeem(id) {
                ++cancelsOk;
                _drop(idx % _openIds.length);
            } catch {}
        } catch {}
    }

    /// Keeper fulfils up to `k` open ids (≤ MAX_BATCH) in one batch; claimable and already-final ids are skipped by
    /// the vault. I8 on the batch: the remaining holders' share price must not fall.
    function fulfil(uint256 k) external {
        uint256 n = _openIds.length;
        if (n == 0) return;
        k = bound(k, 1, n < 32 ? n : 32);
        uint256[] memory ids = new uint256[](k);
        for (uint256 i; i < k; ++i) {
            ids[i] = _openIds[n - 1 - i];
        }
        uint256 free = _idleFree();
        (uint256 assets,) = _preview(ids);
        uint256 pendingBefore = _countStatus(ids, IMeridianVault.RedeemStatus.Pending); // ids are distinct
        uint256 p0 = vault.sharePrice();
        vm.prank(keeper);
        try vault.fulfillRedeems(ids, hex"01") {
            ++fulfilsOk;
            fulfilledIds += pendingBefore;
            if (assets > free) ++unwindWithdrawals;
        } catch {}
        _checkFlow(p0);
    }

    function _countStatus(uint256[] memory ids, IMeridianVault.RedeemStatus st) internal view returns (uint256 c) {
        for (uint256 i; i < ids.length; ++i) {
            if (vault.getRedeemRequest(ids[i]).status == st) ++c;
        }
    }

    function _preview(uint256[] memory ids) internal view returns (uint256 assets, uint256 sell) {
        try vault.previewFulfill(ids) returns (uint256 a, uint256 s) {
            return (a, s);
        } catch {
            return (0, 0);
        }
    }

    function claim(uint256 idx) external {
        if (_openIds.length == 0) return;
        uint256 j = idx % _openIds.length;
        uint256 id = _openIds[j];
        IMeridianVault.RedeemRequest memory r = vault.getRedeemRequest(id);
        if (r.status != IMeridianVault.RedeemStatus.Claimable) return;
        uint256 p0 = vault.sharePrice();
        try vault.claimRedeem(id) returns (uint256 out) {
            ++claimsOk;
            claimedAssets += out;
            _drop(j);
        } catch {}
        _checkFlow(p0);
    }

    function _drop(uint256 j) internal {
        _openIds[j] = _openIds[_openIds.length - 1];
        _openIds.pop();
    }

    function rebalance() external {
        vm.prank(keeper);
        try vault.rebalance() {
            ++rebalancesOk;
        } catch {}
        vm.roll(block.number + 1);
    }

    /// r̄(8 h) regime in [−40%, +60%] APR.
    function fundingRegime(uint256 aprPct) external {
        int256 apr = int256(bound(aprPct, 0, 100)) * 0.01e18 - 0.4e18;
        vm.mockCall(
            address(ch),
            abi.encodeWithSelector(IFundingRateOracle.averageFundingRate.selector, uint64(96_000)),
            abi.encode(apr / 365 days)
        );
    }

    /// Index and Kuru move together by up to ±5% per step (bounded to [0.02, 0.04]).
    function movePrice(uint256 bp) external {
        int256 d = int256(bound(bp, 0, 1000)) - 500;
        uint256 p = uint256(int256(oracle.price()) * (10_000 + d) / 10_000);
        if (p < 0.02e18 || p > 0.04e18) return;
        oracle.setPrice(p);
        hedger.setPrice(p);
        ++priceMoves;
        vm.roll(block.number + 1); // the mark follows the index at the next block's first touch
        requote();
    }

    /// Taker skew: the whale buys or sells up to 500 lots against the MM (a registered skew provider).
    function skew(bool buy, uint256 lots) external {
        lots = bound(lots, 1, 500);
        uint32 lim = buy ? type(uint32).max - 1 : 1;
        vm.prank(whale);
        try ob.placeMarketOrder(buy, uint64(lots), lim, 0, false) {} catch {}
    }

    function roll(uint256 n) external {
        n = bound(n, 1, 200);
        vm.roll(block.number + n);
        vm.warp(block.timestamp + (n * 3 + 9) / 10);
        try ch.updateFunding() {} catch {}
    }
}
