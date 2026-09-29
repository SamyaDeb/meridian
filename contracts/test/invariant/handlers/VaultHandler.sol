// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClearingHouse} from "../../../src/clearing/ClearingHouse.sol";
import {OrderBook} from "../../../src/orderbook/OrderBook.sol";
import {PulseVault} from "../../../src/vault/PulseVault.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../../src/mocks/MockOracleAdapter.sol";
import {MockKuruHedger} from "../../../src/mocks/MockKuruHedger.sol";
import {IFundingRateOracle} from "../../../src/interfaces/IFundingRateOracle.sol";

/// @notice WS-04 handler for I8 / I10 on the REAL perp ClearingHouse + OrderBook (MockKuruHedger spot leg).
///         Actions: deposit, redeem, withdraw, keeper rebalance, funding regime (r̄ pinned), price moves (index +
///         Kuru together), taker skew changes, block rolls. try/catch everywhere; ghosts only on success.
///         Ghosts: per-actor net cash (withdrawn − deposited) for I10 checks at no price move; share-price floor
///         across deposit/withdraw-only steps for I8.
contract VaultHandler is Test {
    PulseVault public vault;
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
    uint256 public unwindWithdrawals; // withdrawals that needed an inline unwind
    uint256 public rebalancesOk;
    uint256 public priceMoves;
    /// @dev I8: share price fell across a deposit/withdraw (must stay false)
    bool public sharePriceFellOnFlow;
    uint256 public maxFallWei;

    constructor(
        PulseVault vault_,
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

    function redeem(uint256 who, uint256 frac) external {
        address a = _actor(who);
        uint256 shares = vault.balanceOf(a) * bound(frac, 1, 100) / 100;
        if (shares == 0) return;
        uint256 idle = ausd.balanceOf(address(vault));
        uint256 p0 = vault.sharePrice();
        vm.prank(a);
        try vault.redeem(shares, a, a) returns (uint256 out) {
            ++withdrawalsOk;
            if (out > idle) ++unwindWithdrawals;
        } catch {}
        _checkFlow(p0);
    }

    function withdraw(uint256 who, uint256 amt) external {
        address a = _actor(who);
        uint256 max = vault.maxWithdraw(a);
        if (max == 0) return;
        amt = bound(amt, 1, max);
        uint256 idle = ausd.balanceOf(address(vault));
        uint256 p0 = vault.sharePrice();
        vm.prank(a);
        try vault.withdraw(amt, a, a) {
            ++withdrawalsOk;
            if (amt > idle) ++unwindWithdrawals;
        } catch {}
        _checkFlow(p0);
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
