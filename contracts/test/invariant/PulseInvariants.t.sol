// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {MockClearingHouse} from "../../src/mocks/MockClearingHouse.sol";
import {MockOrderBook} from "../../src/mocks/MockOrderBook.sol";
import {MockInsuranceFund} from "../../src/mocks/MockInsuranceFund.sol";
import {MockPulseVault} from "../../src/mocks/MockPulseVault.sol";
import {PulseConstants, FundingParams, Position, AccountView} from "../../src/interfaces/PulseTypes.sol";
import {SwapLedgerModel} from "./models/SwapLedgerModel.sol";
import {MockStackDriver} from "./drivers/MockStackDriver.sol";

/// @title PulseInvariants: MATH_SPEC §7 (I1–I11) against the Day-1 mock stack
/// @notice Skeleton suite (WS-08). As WS-01/02/04/05 merge, their contracts replace the mocks in setUp and their
///         handlers (test/invariant/handlers/*Handler.sol) join the driver. Where the mocks lack the spec's rounding
///         discipline, the check uses a documented MOCK tolerance; `STRICT` flips every check to the spec bound.
contract PulseInvariantsTest is StdInvariant, Test {
    /// @dev false while the stack is mocks (no rounding discipline, no fees). Set true when real WS-02 lands.
    bool internal constant STRICT = false;

    MockERC20 ausd;
    MockOracleAdapter oracle;
    MockClearingHouse ch;
    MockOrderBook ob;
    MockPulseVault vault;
    SwapLedgerModel swaps;
    MockStackDriver d;

    function setUp() public {
        ausd = new MockERC20("Agora USD (mock)", "AUSD", 6);
        oracle = new MockOracleAdapter(2e18);
        ch = new MockClearingHouse(address(ausd), address(oracle), address(new MockInsuranceFund(address(ausd))));
        ob = new MockOrderBook(address(ch), 1e14, 1e18);
        ch.setOrderBook(address(ob));
        ob.mockSetFillPrice(2e18);
        ob.mockSetBook(uint32(2e18 / 1e14) - 1, uint32(2e18 / 1e14) + 1);
        // MATH_SPEC §1.3 defaults (per-second WAD)
        ch.setFundingParams(
            FundingParams({
                alpha: 0.002e18,
                interestRate: 3_472_222_222,
                rateCap: 555_555_555_556,
                maxRateChangePerBlock: 555_555_556,
                blockTimeMs: 300,
                premiumBandWad: 0.05e18
            })
        );
        vault = new MockPulseVault(address(ausd));
        swaps = new SwapLedgerModel();
        d = new MockStackDriver(ausd, oracle, ch, ob, vault, swaps);

        // The mock maker is the counterparty of every market order: fund it so its losses never floor at 0.
        ausd.mint(address(this), 1_000_000_000e6);
        ausd.approve(address(ch), type(uint256).max);
        ch.depositFor(d.maker(), 1_000_000_000e6);

        targetContract(address(d));
        bytes4[] memory sel = new bytes4[](17);
        sel[0] = d.deposit.selector;
        sel[1] = d.withdraw.selector;
        sel[2] = d.marketOrder.selector;
        sel[3] = d.placeLimit.selector;
        sel[4] = d.cancel.selector;
        sel[5] = d.moveMark.selector;
        sel[6] = d.accrueFunding.selector;
        sel[7] = d.settleFunding.selector;
        sel[8] = d.perpRoundTrip.selector;
        sel[9] = d.vaultDeposit.selector;
        sel[10] = d.vaultRedeem.selector;
        sel[11] = d.vaultGain.selector;
        sel[12] = d.vaultRoundTrip.selector;
        sel[13] = d.swapFill.selector;
        sel[14] = d.swapSettle.selector;
        sel[15] = d.swapMature.selector;
        sel[16] = d.marketOrder.selector; // weight trading 2x
        targetSelector(FuzzSelector({addr: address(d), selectors: sel}));
    }

    // ─── helpers ──────────────────────────────────────────────────────────────

    function _nAccounts() internal view returns (uint256) {
        return d.actorCount() + 1; // actors + mock maker
    }

    // ─── I1 Solvency / conservation ──────────────────────────────────────────
    /// AUSD.balanceOf(CH)·1e12 ≥ Σ(C_i − ON_i − pending_i) + accruedFees, i.e. Σ equity at any mark (Σq = 0 ⇒ Σupnl = −ΣON).
    /// @dev MATH_SPEC §7 I1 omits the pending-funding term. With lazy settlement a short can collect before the
    ///      long pays, so Σ(C − ON) alone can exceed the balance mid-way. Reported to A (spec fix).
    function invariant_I1_solvency() public view {
        int256 sumC;
        int256 sumON;
        int256 sumPending;
        for (uint256 i; i < _nAccounts(); ++i) {
            address a = d.account(i);
            sumC += int256(ch.collateralOf(a));
            sumON += ch.getPosition(a).openNotional;
            sumPending += ch.getAccount(a).pendingFunding;
        }
        int256 assets = int256(ausd.balanceOf(address(ch)) * PulseConstants.AUSD_TO_WAD);
        int256 liabilities = sumC - sumON - sumPending + int256(ch.accruedFees());
        // The mock truncates funding (spec: owed rounds up), so it may be short by ≤ 1 wei per settlement/account.
        int256 dust = STRICT ? int256(0) : int256(d.ghostSettlements() + _nAccounts());
        assertGe(assets + dust, liabilities, "I1: CH under-collateralized");
        // token conservation: CH holds exactly net deposits (no fees/IF flows in the mock)
        assertEq(
            ausd.balanceOf(address(ch)),
            d.ghostDepositedToken() + 1_000_000_000e6 - d.ghostWithdrawnToken(),
            "I1: token flow mismatch"
        );
    }

    // ─── I2 OI balance ───────────────────────────────────────────────────────
    function invariant_I2_openInterest() public view {
        (uint256 longOI, uint256 shortOI) = ch.openInterest();
        uint256 sumLong;
        uint256 sumShort;
        int256 sumQ;
        for (uint256 i; i < _nAccounts(); ++i) {
            address a = d.account(i);
            int256 q = ch.getPosition(a).size;
            sumQ += q;
            if (q > 0) sumLong += uint256(q);
            else sumShort += uint256(-q);
            assertEq(q, d.ghostQ(a), "I2: position != ghost from PositionChanged");
        }
        assertEq(longOI, shortOI, "I2: longOI != shortOI");
        assertEq(longOI, sumLong, "I2: longOI != sum max(q,0)");
        assertEq(shortOI, sumShort, "I2: shortOI != sum max(-q,0)");
        assertEq(sumQ, 0, "I2: sum q != 0");
        assertEq(d.ghostSumQ(), 0, "I2: ghost sum q != 0");
    }

    // ─── I3 Funding conservation ─────────────────────────────────────────────
    /// Σ owed (settled via FundingSettled + still pending) ∈ [0, N] wei (spec); mock truncation ⇒ |Σ| ≤ settlements + N.
    function invariant_I3_fundingConservation() public view {
        int256 pending;
        for (uint256 i; i < _nAccounts(); ++i) {
            pending += ch.getAccount(d.account(i)).pendingFunding;
        }
        int256 sumOwed = d.ghostSettledOwed() + pending;
        int256 n = int256(_nAccounts() + d.ghostSettlements());
        if (STRICT) {
            assertGe(sumOwed, 0, "I3: protocol pays out more funding than it collects");
            assertLe(sumOwed, n, "I3: funding dust above N wei");
        } else {
            assertLe(sumOwed < 0 ? -sumOwed : sumOwed, n, "I3: funding not conserved (mock tolerance)");
        }
    }

    // ─── I4 Funding once per block ───────────────────────────────────────────
    function invariant_I4_fundingOncePerBlock() public view {
        assertLe(d.ghostMaxFundingUpdatesPerBlock(), 1, "I4: FundingUpdated > 1 per block");
        // TODO(WS-02): with the real CH, a second touch in the same block must leave F unchanged.
    }

    // ─── I5 Rate bounds ──────────────────────────────────────────────────────
    function invariant_I5_rateBounds() public view {
        FundingParams memory fp = ch.fundingParams();
        int256 r = ch.fundingState().rate;
        assertLe(r < 0 ? uint256(-r) : uint256(r), fp.rateCap, "I5: |r| > cap");
        assertFalse(d.ghostRateStepViolated(), "I5: |r_b - r_prev| > delta*n");
    }

    // ─── I6 Book integrity ───────────────────────────────────────────────────
    function invariant_I6_bookIntegrity() public view {
        uint32 bid = ob.bestBid();
        uint32 ask = ob.bestAsk();
        if (bid != 0 && ask != type(uint32).max) assertLt(bid, ask, "I6: crossed book");
        // TODO(WS-01): level.totalLots == Σ orders; bitmap bit ⇔ level non-empty (MockOrderBook has no levels).
    }

    // ─── I7 Margin reservation ───────────────────────────────────────────────
    function invariant_I7_marginReservation() public view {
        for (uint256 i; i < d.actorCount(); ++i) {
            address a = d.account(i);
            uint256 onchain = ch.reservedOf(a);
            uint256 ghost = d.ghostReserved(a);
            // Real CH rounds each reservation up (MATH_SPEC §3.2): allow ≤ 1 wei per open order.
            uint256 tol = STRICT ? d.ghostOpenOrderCount(a) : 0;
            assertApproxEqAbs(onchain, ghost, tol, "I7: reserved != sum of open-order reservations");
        }
    }

    // ─── I8 Vault shares ─────────────────────────────────────────────────────
    function invariant_I8_vaultShares() public view {
        assertLe(vault.convertToAssets(vault.totalSupply()), vault.totalAssets(), "I8: shares over-claim assets");
        assertFalse(d.ghostSharePriceDropped(), "I8: share price fell on deposit/withdraw");
    }

    // ─── I9 Funding swaps (reference model until WS-05) ──────────────────────
    function invariant_I9_swaps() public view {
        (int256 sq, int256 sk) = d.swapSums();
        assertEq(sq, 0, "I9: sum q != 0");
        assertEq(sk, 0, "I9: sum K != 0");
        assertEq(d.ghostSwapSumQ(), 0, "I9: ghost sum q != 0");
        assertEq(d.ghostSwapSumK(), 0, "I9: ghost sum K != 0");
        // Σ net (settled + pending) ∈ [−(#settlements + N), 0]: the protocol never pays out more than it takes in.
        int256 total = d.ghostSwapSettledNet() + d.swapSumPending();
        assertLe(total, 0, "I9: swap net accrual created value");
        assertGe(total, -int256(d.ghostSwapSettlements() + d.actorCount()), "I9: swap dust above bound");
        if (d.ghostSwapMaturedSnapshotTaken()) {
            assertEq(total, d.ghostSwapTotalAtMaturity(), "I9: accrual changed after maturity");
        }
        // TODO(WS-05): equity ≥ 0 for all accounts when the rate path respects cap/δ and liquidations run.
    }

    // ─── I10 No free money ───────────────────────────────────────────────────
    function invariant_I10_noFreeMoney() public view {
        assertFalse(d.ghostFreeMoney(), "I10: deposit->withdraw round trip returned more than deposited");
    }

    // ─── I11 Oracle ──────────────────────────────────────────────────────────
    function invariant_I11_oracle() public view {
        FundingParams memory fp = ch.fundingParams();
        (int256 f, int256 g,) = ch.latestObservation();
        assertFalse(d.ghostGDecreased(), "I11: G decreased");
        assertGe(g, d.ghostG0(), "I11: G below start");
        int256 dF = f - d.ghostF0();
        int256 bound_ = int256(fp.rateCap) * (g - d.ghostG0()) / 1e18 + int256(d.ghostSettlements() + 1);
        assertLe(dF < 0 ? -dF : dF, bound_, "I11: |dF| > cap * dG");
        int256 avg = ch.averageFundingRate(0);
        assertLe(avg < 0 ? uint256(-avg) : uint256(avg), fp.rateCap, "I11: average rate outside [-cap, cap]");
        // TODO(WS-02): checkpoint blocks strictly increasing around the ring (needs the real ring buffer).
    }

    /// @notice Run summary (forge test -vv): shows the driver actually trades instead of reverting.
    function invariant_callSummary() public view {
        console2.log("calls", d.calls());
        console2.log("market orders ok / failed", d.tradesOk(), d.tradesFailed());
        console2.log("swap fills", d.swapFills());
    }

    // ─── Deterministic spot checks of the harness itself ─────────────────────

    function test_driverGhostsTrackATrade() public {
        d.deposit(0, 100_000e6);
        d.marketOrder(0, true, 10);
        assertEq(d.ghostSumQ(), 0);
        assertEq(d.ghostQ(d.account(0)), 10e18);
        assertEq(d.ghostQ(d.maker()), -10e18);
        d.accrueFunding(0, 1);
        d.accrueFunding(int256(555_555_556), 1);
        d.settleFunding(0);
        invariant_I1_solvency();
        invariant_I2_openInterest();
        invariant_I3_fundingConservation();
        invariant_I4_fundingOncePerBlock();
        invariant_I5_rateBounds();
        invariant_I11_oracle();
    }

    function test_swapModelLockedSpread() public {
        // MATH_SPEC §6.6 offset: long 1M at 12%, then sell 1M at 15% ⇒ q = 0, K = −30,000 (locked spread)
        address a = d.account(0);
        address b = d.account(1);
        swaps.fill(a, b, 1_000_000e18, 0.12e18);
        swaps.fill(b, a, 1_000_000e18, 0.15e18);
        (int256 q, int256 k,,) = swaps.accounts(a);
        assertEq(q, 0);
        assertEq(k, -30_000e18);
        // 20 days at I = 0.029 with any funding path ⇒ +0.03·ΣIΔt/YEAR ≈ +47.7 AUSD
        swaps.accrue(0, 0.029e18 * int256(20 days));
        assertApproxEqAbs(swaps.pendingNet(a), 47.67e18, 0.01e18);
        assertEq(swaps.pendingNet(a) + swaps.pendingNet(b) <= 0, true);
    }
}
