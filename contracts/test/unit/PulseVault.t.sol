// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {PulseVault} from "../../src/vault/PulseVault.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {MockKuruHedger} from "../../src/mocks/MockKuruHedger.sol";
import {IPulseVault} from "../../src/interfaces/IPulseVault.sol";
import {IKuruHedger} from "../../src/interfaces/IKuruHedger.sol";
import {IFundingRateOracle} from "../../src/interfaces/IFundingRateOracle.sol";
import {RiskParams, FundingParams, VaultParams, HedgeState, AccountView} from "../../src/interfaces/PulseTypes.sol";

/// @dev REAL ClearingHouse + OrderBook (MATH_SPEC defaults, caps raised so the §5.5 example fits), MockKuruHedger
///      for the spot leg, MockOracleAdapter. r̄ (8 h) is pinned with vm.mockCall on the real CH for rule tests.
abstract contract PulseVaultBase is Test {
    uint256 constant I0 = 0.029e18;
    uint32 constant MID0 = 29_000;
    int256 constant YEAR = 365 days;
    uint64 constant WINDOW = 96_000;

    MockERC20 ausd;
    MockERC20 wmon;
    MockOracleAdapter oracle;
    InsuranceFund fund;
    ClearingHouse ch;
    OrderBook ob;
    MockKuruHedger hedger;
    PulseVault vault;
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address mm = makeAddr("mm");
    address whale = makeAddr("whale");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint64[] mmIds;

    function _params() internal pure virtual returns (VaultParams memory) {
        return VaultParams({
            leverage: 1.5e18,
            driftBand: 0.02e18,
            targetMarginRatio: 0.6e18,
            minMarginRatio: 0.25e18,
            exitHorizonSec: 3 days,
            roundTripFee: 0.0015e18,
            maxSlippage: 0.005e18,
            idleBuffer: 0.05e18,
            depositCap: 10_000e6,
            skewCapacity: 0.8e18,
            entryHorizonSec: 7 days,
            maxSliceAssets: 2500e6
        });
    }

    function setUp() public virtual {
        vm.roll(1_000_000);
        vm.warp(1_790_000_000);
        ausd = new MockERC20("Test AUSD", "tAUSD", 6);
        wmon = new MockERC20("Wrapped MON (mock)", "WMON", 18);
        oracle = new MockOracleAdapter(I0);
        fund = new InsuranceFund(address(ausd), owner);
        ch = new ClearingHouse(
            address(ausd),
            address(oracle),
            address(fund),
            RiskParams(0.2e18, 0.1e18, 0.0005e18, -0.0001e18, 0.01e18, 0.5e18, 10_000_000e18, 1_000_000e18),
            FundingParams(0.002e18, 3_472_222_222, 555_555_555_556, 555_555_556, 300, 0.05e18),
            owner
        );
        ob = new OrderBook(address(ch), 1e12, 100e18);
        vm.startPrank(owner);
        ch.setOrderBook(address(ob));
        fund.setMarketAuthorized(address(ch), true);
        vm.stopPrank();
        hedger = new MockKuruHedger(address(wmon), address(ausd), I0);
        vault = new PulseVault(ausd, address(ch), address(ob), address(hedger), _params(), owner);
        vm.startPrank(owner);
        vault.setKeeper(keeper, true);
        vault.setSkewProvider(mm, true);
        vm.stopPrank();
        _perpDeposit(mm, 2_000_000e6);
        _quote(MID0, 2000);
    }

    // ─── helpers ──────────────────────────────────────────────────────────────
    function _perpDeposit(address who, uint256 amt) internal {
        ausd.mint(who, amt);
        vm.startPrank(who);
        ausd.approve(address(ch), amt);
        ch.deposit(amt);
        vm.stopPrank();
    }

    /// The MM (a registered skew provider) quotes 3 levels × `lots` each side, 10 ticks apart, around `mid`.
    function _quote(uint32 mid, uint64 lots) internal {
        vm.startPrank(mm);
        for (uint256 i; i < mmIds.length; ++i) {
            if (ob.getOrder(mmIds[i]).remainingLots != 0) ob.cancelOrder(mmIds[i]);
        }
        delete mmIds;
        for (uint32 i = 1; i <= 3; ++i) {
            (uint64 b,) = ob.placeLimitOrder(true, mid - 10 * i, lots, 0);
            (uint64 a,) = ob.placeLimitOrder(false, mid + 10 * i, lots, 0);
            mmIds.push(b);
            mmIds.push(a);
        }
        vm.stopPrank();
    }

    /// A taker (not a provider) goes long `lots` against the MM: the long skew the vault may absorb.
    function _whaleLong(uint64 lots) internal {
        _perpDeposit(whale, 1_000_000e6);
        vm.prank(whale);
        ob.placeMarketOrder(true, lots, MID0 + 40, lots, false);
    }

    function _setAvgApr(int256 aprWad) internal {
        vm.mockCall(
            address(ch),
            abi.encodeWithSelector(IFundingRateOracle.averageFundingRate.selector, WINDOW),
            abi.encode(aprWad / YEAR)
        );
    }

    function _deposit(address who, uint256 amt) internal returns (uint256 shares) {
        ausd.mint(who, amt);
        vm.startPrank(who);
        ausd.approve(address(vault), amt);
        shares = vault.deposit(amt, who);
        vm.stopPrank();
    }

    /// Keeper rebalances until nothing is left to do (bounded).
    function _rebalanceAll() internal returns (uint256 n) {
        for (; n < 20; ++n) {
            if (vault.needsRebalance() == IPulseVault.RebalanceReason.None) return n;
            vm.prank(keeper);
            vault.rebalance();
            vm.roll(block.number + 1);
        }
        revert("rebalance did not converge");
    }

    function _setPrice(uint256 p) internal {
        oracle.setPrice(p);
        hedger.setPrice(p);
    }

    function _hs() internal view returns (HedgeState memory) {
        return vault.hedgeState();
    }
}

contract PulseVaultNoBuffer is PulseVaultBase {
    function _params() internal pure override returns (VaultParams memory p) {
        p = super._params();
        p.idleBuffer = 0;
    }

    /// MATH_SPEC §5.5: 10,000 AUSD, L = 1.5, P = 0.029 ⇒ spot ≈ short ≈ 206,897 MON (±1 lot), margin ≈ 4,000.
    function test_5_5_example() public {
        _whaleLong(3000); // others net long 300,000 MON ⇒ capacity 240,000 ≥ 206,897
        _setAvgApr(0.3e18);
        _deposit(alice, 10_000e6);
        assertEq(uint8(vault.needsRebalance()), uint8(IPulseVault.RebalanceReason.EnterHedge));
        uint256 steps = _rebalanceAll();
        assertEq(steps, 3, "2,500 AUSD spot slices: 3 slices for 6,000 AUSD of spot");
        HedgeState memory h = _hs();
        assertApproxEqAbs(uint256(-h.perpSize), 206_897e18, 100e18, "short = N/P, +-1 lot");
        assertApproxEqAbs(h.spotBase, uint256(-h.perpSize), uint256(-h.perpSize) / 100, "spot matches the short");
        assertLt(vault.hedgeState().netDelta < 0 ? uint256(-h.netDelta) : uint256(h.netDelta), 206_897e18 / 50);
        assertApproxEqRel(h.marginRatio, 0.6667e18, 0.01e18, "M = N/L");
        assertTrue(h.hedged);
        assertApproxEqRel(h.nav, 10_000e6, 0.001e18, "NAV unchanged but for fees");
    }
}

contract PulseVaultTest is PulseVaultBase {
    // ═══ skew capacity (MATH_SPEC §5.2, as amended) ════════════════════════════
    function test_shortCapacity_isTakersNetLongTimesCapacity() public {
        assertEq(vault.shortCapacity(), 0, "no taker skew");
        _whaleLong(1000); // 100,000 MON
        assertEq(vault.shortCapacity(), 80_000e18);
        vm.prank(owner);
        vault.setSkewProvider(mm, false);
        assertEq(vault.shortCapacity(), 0, "without the provider the rule is degenerate: vault short 0");
    }

    function test_skewCapLimitsShortAndSpotMatches() public {
        _whaleLong(1000); // capacity 80,000 < target ≈ 196,552
        _setAvgApr(0.3e18);
        _deposit(alice, 10_000e6);
        _rebalanceAll();
        HedgeState memory h = _hs();
        assertEq(uint256(-h.perpSize), 80_000e18, "short = capacity (lots)");
        uint256 netAbs = h.netDelta < 0 ? uint256(-h.netDelta) : uint256(h.netDelta);
        assertLt(netAbs * 1e18 / uint256(-h.perpSize), 0.02e18, "netDelta/N < theta");
        assertLe(uint256(-h.perpSize), vault.shortCapacity() + 100e18);
    }

    function test_skewFalling_triggersSkewCapReduction() public {
        _whaleLong(1000);
        _setAvgApr(0.3e18);
        _deposit(alice, 10_000e6);
        _rebalanceAll();
        // the whale closes half: the takers' net long falls to 50,000 ⇒ capacity 40,000 < short 80,000
        vm.prank(whale);
        ob.placeMarketOrder(false, 500, MID0 - 40, 500, true);
        assertEq(uint8(vault.needsRebalance()), uint8(IPulseVault.RebalanceReason.SkewCap));
        vm.prank(keeper);
        assertEq(uint8(vault.rebalance()), uint8(IPulseVault.RebalanceReason.SkewCap));
        _rebalanceAll();
        assertLe(uint256(-_hs().perpSize), vault.shortCapacity() + 100e18);
    }

    // ═══ entry / exit / hysteresis (MATH_SPEC §5.3) ════════════════════════════
    function test_entryRuleOff_staysIdle() public {
        _whaleLong(1000);
        _deposit(alice, 5000e6);
        // no 8 h history on the real CH yet: r̄ unavailable ⇒ never enter
        assertEq(uint8(vault.needsRebalance()), uint8(IPulseVault.RebalanceReason.None));
        _setAvgApr(0.12e18); // below the ≈ 15.6% entry threshold
        assertEq(uint8(vault.needsRebalance()), uint8(IPulseVault.RebalanceReason.None));
        vm.prank(keeper);
        vm.expectRevert(IPulseVault.NothingToDo.selector);
        vault.rebalance();
        assertFalse(_hs().hedged);
        _setAvgApr(0.16e18); // just above 2c·365/7
        assertEq(uint8(vault.needsRebalance()), uint8(IPulseVault.RebalanceReason.EnterHedge));
    }

    function test_exitThenHysteresis() public {
        _whaleLong(1000);
        _setAvgApr(0.3e18);
        _deposit(alice, 10_000e6);
        _rebalanceAll();
        assertTrue(_hs().hedged);
        _setAvgApr(0); // between −18.3% and +15.6%: hold
        assertEq(uint8(vault.needsRebalance()), uint8(IPulseVault.RebalanceReason.None));
        assertFalse(vault.shouldExitHedge());
        _setAvgApr(-0.3e18); // below −c·365/3 ≈ −18.3%
        assertTrue(vault.shouldExitHedge());
        vm.expectEmit(false, false, false, false, address(vault));
        emit IPulseVault.HedgeExited(0);
        _rebalanceAll();
        HedgeState memory h = _hs();
        assertFalse(h.hedged);
        assertEq(h.perpSize, 0);
        assertLt(h.spotBase, 100e18);
        assertApproxEqRel(h.idleAssets, 10_000e6, 0.002e18, "back to idle, minus fees");
        _setAvgApr(0.1e18); // back between the thresholds: no re-entry (hysteresis)
        assertEq(uint8(vault.needsRebalance()), uint8(IPulseVault.RebalanceReason.None));
        _setAvgApr(0.2e18);
        assertEq(uint8(vault.needsRebalance()), uint8(IPulseVault.RebalanceReason.EnterHedge));
    }

    /// Review finding B-S1: an exit whose last step leaves spot ≥ 1 lot with the perp already flat must keep
    /// unwinding (sell the spot), not revert NothingToDo in `_reduceBoth(n, 0)` and stay stuck in ExitHedge.
    function test_exit_perpFlatSpotLeft_keepsSellingSpot() public {
        _whaleLong(3000);
        _setAvgApr(0.3e18);
        _deposit(alice, 10_000e6);
        _rebalanceAll();
        assertTrue(_hs().hedged);
        // excess spot of more than one slice (2,500 AUSD ≈ 86k MON) on top of the hedge, e.g. a large drift
        wmon.mint(address(vault), 200_000e18);
        _setAvgApr(-0.3e18);
        _rebalanceAll();
        HedgeState memory h = _hs();
        assertEq(h.perpSize, 0);
        assertLt(h.spotBase, 100e18, "all spot sold");
        assertEq(uint8(vault.needsRebalance()), uint8(IPulseVault.RebalanceReason.None));
    }

    // ═══ NAV at the index (MATH_SPEC §5.4) ═════════════════════════════════════
    function test_priceMove20pct_navUnchanged_notLiquidatable() public {
        _whaleLong(3000);
        _setAvgApr(0.3e18);
        _deposit(alice, 10_000e6);
        _rebalanceAll();
        uint256 nav0 = vault.totalAssets();
        uint256[2] memory px = [uint256(I0 * 12 / 10), I0 * 8 / 10];
        for (uint256 i; i < 2; ++i) {
            _setPrice(px[i]);
            vm.roll(block.number + 1);
            ch.updateFunding();
            assertApproxEqRel(vault.totalAssets(), nav0, 0.002e18, "NAV price-neutral (index valuation)");
            assertFalse(ch.isLiquidatable(address(vault)));
        }
        _setPrice(I0);
    }

    function test_positiveFunding_sharePriceRisesEveryBlock() public {
        _whaleLong(3000);
        _setAvgApr(0.3e18);
        _deposit(alice, 10_000e6);
        _rebalanceAll();
        // the rate walks up to i (10.95%) δ per block; the vault is short ⇒ receives funding every block
        vm.roll(block.number + 200);
        ch.updateFunding();
        uint256 p = vault.sharePrice();
        for (uint256 i; i < 20; ++i) {
            vm.roll(block.number + 1);
            ch.updateFunding();
            uint256 q = vault.sharePrice();
            assertGt(q, p, "share price up every block");
            p = q;
        }
    }

    function test_marginLow_topsUpFromIdle() public {
        _whaleLong(3000);
        _setAvgApr(0.3e18);
        _deposit(alice, 10_000e6);
        _rebalanceAll();
        _setPrice(I0 * 14 / 10); // +40% pump: ratio ≈ (0.667 − 0.4)/1.4 ≈ 19% < 25%
        vm.roll(block.number + 1);
        assertLt(_hs().marginRatio, 0.25e18);
        assertEq(uint8(vault.needsRebalance()), uint8(IPulseVault.RebalanceReason.MarginLow));
        vm.prank(keeper);
        vault.rebalance();
        assertGt(_hs().marginRatio, 0.25e18);
        assertFalse(ch.isLiquidatable(address(vault)));
    }

    function test_deltaDrift_sellsExcessSpot() public {
        _whaleLong(3000);
        _setAvgApr(0.3e18);
        _deposit(alice, 10_000e6);
        _rebalanceAll();
        wmon.mint(address(vault), uint256(-_hs().perpSize) / 20); // +5% spot
        assertEq(uint8(vault.needsRebalance()), uint8(IPulseVault.RebalanceReason.DeltaDrift));
        vm.prank(keeper);
        vault.rebalance();
        HedgeState memory h = _hs();
        uint256 netAbs = h.netDelta < 0 ? uint256(-h.netDelta) : uint256(h.netDelta);
        assertLt(netAbs * 1e18 / uint256(-h.perpSize), 0.02e18);
    }

    // ═══ keeper bounds ═════════════════════════════════════════════════════════
    function test_keeperCannotExceedSlippage_spot() public {
        _whaleLong(3000);
        _setAvgApr(0.3e18);
        _deposit(alice, 10_000e6);
        hedger.setSpread(0.006e18); // Kuru 0.6% worse than the index > maxSlippage 0.5%
        vm.prank(keeper);
        vm.expectRevert(IKuruHedger.SlippageExceeded.selector);
        vault.rebalance();
    }

    function test_keeperCannotExceedSlippage_perp() public {
        _whaleLong(3000);
        _setAvgApr(0.3e18);
        _deposit(alice, 10_000e6);
        _quote(MID0 - 200, 2000); // perp bids ~0.7% under the index: below I·(1 − 0.5%)
        vm.prank(keeper);
        vm.expectRevert(); // OrderBook: min fill not reached within the limit tick
        vault.rebalance();
    }

    function test_onlyKeeper() public {
        vm.prank(alice);
        vm.expectRevert(IPulseVault.OnlyKeeper.selector);
        vault.rebalance();
        vm.prank(alice);
        vm.expectRevert(IPulseVault.OnlyKeeper.selector);
        vault.rebalanceWithRoute("");
        vm.prank(alice);
        vm.expectRevert(IPulseVault.OnlyKeeper.selector);
        vault.exitHedge();
        vm.prank(alice);
        vm.expectRevert(IPulseVault.OnlyKeeper.selector);
        vault.enterHedge();
    }

    // ═══ deposits / withdrawals ═══════════════════════════════════════════════
    function test_depositCap() public {
        _deposit(alice, 10_000e6);
        ausd.mint(bob, 1);
        vm.startPrank(bob);
        ausd.approve(address(vault), 1);
        vm.expectRevert(IPulseVault.DepositCapExceeded.selector);
        vault.deposit(1, bob);
        vm.stopPrank();
    }

    function test_withdrawFromIdle_fee5bps() public {
        uint256 shares = _deposit(alice, 1000e6);
        assertEq(shares, 1000e18, "18-dp shares at par");
        assertEq(vault.sharePrice(), 1e18);
        vm.prank(alice);
        uint256 out = vault.redeem(shares, alice, alice);
        assertEq(out, 1000e6 - 0.5e6, "5 bps fee");
        assertEq(ausd.balanceOf(address(vault)), 0.5e6, "fee stays for the remaining holders");
    }

    /// I8: an unwind for a withdrawal never lowers the remaining holders' share price (the withdrawer pays it).
    function test_withdrawUnwindsProRata_remainingSharePriceNotDiluted() public {
        _whaleLong(3000);
        _setAvgApr(0.3e18);
        _deposit(alice, 5000e6);
        _deposit(bob, 5000e6);
        _rebalanceAll();
        hedger.setSpread(0.004e18); // unwinding costs 0.4% on the spot leg
        uint256 p0 = vault.sharePrice();
        uint256 half = vault.balanceOf(bob);
        uint256 idle0 = ausd.balanceOf(address(vault));
        vm.prank(bob);
        uint256 out = vault.redeem(half, bob, bob);
        assertGt(out, idle0, "needed an unwind");
        assertGe(vault.sharePrice(), p0, "remaining holders not diluted");
        assertLt(out, 5000e6, "withdrawer pays fee + unwind cost");
        (uint256 lo, uint256 so) = ch.openInterest();
        assertEq(lo, so);
    }

    /// I10 / inflation: a first depositor's donation can't steal more than 1 wei-equivalent from the next one.
    function test_inflationAttack() public {
        _deposit(bob, 1); // 1 token unit
        ausd.mint(bob, 5000e6);
        vm.prank(bob);
        ausd.transfer(address(vault), 5000e6); // donation
        uint256 shares = _deposit(alice, 4000e6);
        assertGt(shares, 0);
        uint256 worth = vault.convertToAssets(shares);
        assertGe(worth + 1, 4000e6 - 1, "victim keeps its deposit");
    }

    // ═══ admin ═════════════════════════════════════════════════════════════════
    function test_setVaultParams_bounds() public {
        VaultParams memory p = _params();
        p.leverage = 6e18;
        vm.prank(owner);
        vm.expectRevert(IPulseVault.InvalidParams.selector);
        vault.setVaultParams(p);
        p = _params();
        p.minMarginRatio = p.targetMarginRatio;
        vm.prank(owner);
        vm.expectRevert(IPulseVault.InvalidParams.selector);
        vault.setVaultParams(p);
        p = _params();
        p.maxSlippage = 0;
        vm.prank(owner);
        vm.expectRevert(IPulseVault.InvalidParams.selector);
        vault.setVaultParams(p);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setVaultParams(_params());
        vm.expectEmit(address(vault));
        emit IPulseVault.VaultParamsUpdated(_params());
        vm.prank(owner);
        vault.setVaultParams(_params());
    }

    function test_setSkewProvider_bounds() public {
        vm.startPrank(owner);
        vm.expectRevert(IPulseVault.InvalidParams.selector);
        vault.setSkewProvider(address(0), true);
        vm.expectRevert(IPulseVault.InvalidParams.selector);
        vault.setSkewProvider(address(vault), true);
        vault.setSkewProvider(mm, true); // idempotent
        assertEq(vault.skewProviders(0), mm);
        vault.setSkewProvider(mm, false);
        vm.stopPrank();
        vm.expectRevert();
        vault.skewProviders(0);
    }

    function test_constructor_rejectsMiswiring() public {
        vm.expectRevert(IPulseVault.InvalidParams.selector);
        new PulseVault(ausd, address(ch), address(0xdead), address(hedger), _params(), owner);
        MockERC20 other = new MockERC20("x", "x", 6);
        vm.expectRevert(IPulseVault.InvalidParams.selector);
        new PulseVault(other, address(ch), address(ob), address(hedger), _params(), owner);
    }
}

/// Review A-05/A-06: NAV uses the SIGNED perp collateral (AccountView.collateral is clamped at 0), and deposits close
/// while the vault's perp account carries bad debt.
contract PulseVaultBadDebtNav is PulseVaultBase {
    function test_A05_A06_negativePerpCollateral_navAndDepositsClosed() public {
        _deposit(alice, 1000e6);
        assertGt(vault.maxDeposit(bob), 0);
        // the CH reports the vault's account after a deficit liquidation: flat, collateral −50 AUSD (clamped to 0)
        AccountView memory a;
        a.equity = -50e18;
        vm.mockCall(address(ch), abi.encodeWithSelector(ch.getAccount.selector, address(vault)), abi.encode(a));
        assertEq(vault.totalAssets(), 950e6, "NAV = idle - the perp deficit");
        assertEq(vault.maxDeposit(bob), 0, "no deposits into the deficit");
    }
}

// ═══ Review A findings (docs/outputs/security/review-A.md), moved from test/review/ReviewA.t.sol ═══

/// A-02 (Medium): one lot (100 MON ≈ $2.7) of WMON donated to a flat, not-entered vault makes `_needs` return
/// ExitHedge forever and `_exitSlice` revert NothingToDo (q = 0 ⇒ `_reduceBoth(0)`): the entry rule can never fire.
contract ReviewA02_DonationBricksRule is PulseVaultBase {
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
contract ReviewA03_DustIdleMarginLow is PulseVaultBase {
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
        assertEq(uint8(vault.needsRebalance()), uint8(IPulseVault.RebalanceReason.MarginLow), "still low");
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
contract ReviewA04_TargetIgnoresPositionCap is PulseVaultBase {
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
