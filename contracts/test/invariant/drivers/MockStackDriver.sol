// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../../src/mocks/MockOracleAdapter.sol";
import {MockClearingHouse} from "../../../src/mocks/MockClearingHouse.sol";
import {MockOrderBook} from "../../../src/mocks/MockOrderBook.sol";
import {MockPulseVault} from "../../../src/mocks/MockPulseVault.sol";
import {IClearingHouse} from "../../../src/interfaces/IClearingHouse.sol";
import {IOrderBook} from "../../../src/interfaces/IOrderBook.sol";
import {PulseConstants, FundingParams} from "../../../src/interfaces/PulseTypes.sol";
import {SwapLedgerModel} from "../models/SwapLedgerModel.sol";

/// @notice Invariant driver over the Day-1 mock stack (WS-08). Module owners' handlers
///         (test/invariant/handlers/*Handler.sol) replace these actions as the real contracts merge.
/// @dev Ghost sums are rebuilt from emitted events (vm.recordLogs), independently of contract views:
///      Σq from PositionChanged, Σowed from FundingSettled, FundingUpdated count per block, and ΣK in the swap model.
///      Liquidation is intentionally not driven: MockClearingHouse.liquidate applies the liquidator's trade
///      twice (reported to WS-00/A); re-enable with the real ClearingHouse.
contract MockStackDriver is CommonBase, StdCheats, StdUtils {
    int256 internal constant W = PulseConstants.IWAD;
    uint256 public constant N_ACTORS = 4;
    uint256 public constant P0 = 2e18; // initial mark (mock price units)
    uint256 public constant BAND_BPS = 450; // mark within ±4.5% of P0: worst adverse move 9% < 10% IM ⇒ no account goes underwater
    uint256 public constant TICK = 1e14;
    uint256 public constant LOT = 1e18;

    MockERC20 public immutable ausd;
    MockOracleAdapter public immutable oracle;
    MockClearingHouse public immutable ch;
    MockOrderBook public immutable ob;
    MockPulseVault public immutable vault;
    SwapLedgerModel public immutable swaps;

    address[N_ACTORS] public actors;
    address public immutable maker; // MockOrderBook's counterparty for market orders

    // ─── ghosts ───────────────────────────────────────────────────────────────
    int256 public ghostSumQ; // Σ PositionChanged.sizeDelta (all accounts)
    mapping(address => int256) public ghostQ;
    int256 public ghostSettledOwed; // Σ FundingSettled.payment (+ = paid by accounts)
    uint256 public ghostSettlements;
    uint256 public ghostDepositedToken;
    uint256 public ghostWithdrawnToken;
    mapping(uint256 => uint256) public ghostFundingUpdatesInBlock;
    uint256 public ghostMaxFundingUpdatesPerBlock;
    int256 public ghostPrevRate;
    uint256 public ghostPrevRateBlock;
    bool public ghostRateStepViolated;
    int256 public ghostF0;
    int256 public ghostG0;
    int256 public ghostLastG;
    bool public ghostGDecreased;
    // I7: open-order reservations per actor (mock formula; real CH rounds each reserve up)
    mapping(address => uint256) public ghostReserved;
    mapping(address => uint64[]) internal _openOrders;
    mapping(address => uint256) public ghostOpenOrderCount;
    // I8 / I10
    bool public ghostSharePriceDropped;
    bool public ghostFreeMoney;
    // I9
    int256 public ghostSwapSumQ;
    int256 public ghostSwapSumK;
    int256 public ghostSwapSettledNet;
    uint256 public ghostSwapSettlements;
    int256 public ghostSwapTotalAtMaturity;
    bool public ghostSwapMaturedSnapshotTaken;

    uint256 public calls;
    uint256 public tradesOk;
    uint256 public tradesFailed;
    uint256 public swapFills;

    constructor(
        MockERC20 ausd_,
        MockOracleAdapter oracle_,
        MockClearingHouse ch_,
        MockOrderBook ob_,
        MockPulseVault vault_,
        SwapLedgerModel swaps_
    ) {
        ausd = ausd_;
        oracle = oracle_;
        ch = ch_;
        ob = ob_;
        vault = vault_;
        swaps = swaps_;
        maker = ob_.mockMaker();
        for (uint256 i; i < N_ACTORS; ++i) {
            actors[i] = address(uint160(0xA000 + i));
        }
        (ghostF0, ghostG0,) = ch_.latestObservation();
        ghostLastG = ghostG0;
    }

    // ─── actions: perp ────────────────────────────────────────────────────────

    function deposit(uint256 actorSeed, uint256 amountToken) external {
        address a = _actor(actorSeed);
        amountToken = bound(amountToken, 1, 1_000_000e6);
        ausd.mint(a, amountToken);
        vm.startPrank(a);
        ausd.approve(address(ch), amountToken);
        vm.recordLogs();
        ch.deposit(amountToken);
        vm.stopPrank();
        _ingest();
        ghostDepositedToken += amountToken;
        calls++;
    }

    function withdraw(uint256 actorSeed, uint256 amountToken) external {
        address a = _actor(actorSeed);
        amountToken = bound(amountToken, 1, ch.collateralOf(a) / PulseConstants.AUSD_TO_WAD + 1);
        vm.prank(a);
        vm.recordLogs();
        try ch.withdraw(amountToken) {
            ghostWithdrawnToken += amountToken;
            _ingest();
        } catch {
            _discard();
        }
        calls++;
    }

    function marketOrder(uint256 actorSeed, bool isBid, uint256 lots) external {
        address a = _actor(actorSeed);
        lots = bound(lots, 1, 1000);
        vm.prank(a);
        vm.recordLogs();
        try ob.placeMarketOrder(isBid, uint64(lots), 0, 0, false) {
            _ingest();
            tradesOk++;
        } catch {
            _discard();
            tradesFailed++;
        }
        calls++;
    }

    function placeLimit(uint256 actorSeed, bool isBid, uint256 tickOffset, uint256 lots) external {
        address a = _actor(actorSeed);
        if (ghostOpenOrderCount[a] >= 8) return; // keep the per-actor order list small
        lots = bound(lots, 1, 500);
        uint32 mid = uint32(ch.markPrice() / TICK);
        uint32 tick = isBid ? mid - uint32(bound(tickOffset, 1, 100)) : mid + uint32(bound(tickOffset, 1, 100));
        vm.prank(a);
        vm.recordLogs();
        try ob.placeLimitOrder(isBid, tick, uint64(lots), 0) returns (uint64 id, uint64) {
            _openOrders[a].push(id);
            ghostOpenOrderCount[a]++;
            ghostReserved[a] += _reserve(lots * LOT, uint256(tick) * TICK);
            _ingest();
        } catch {
            _discard();
        }
        calls++;
    }

    function cancel(uint256 actorSeed, uint256 idx) external {
        address a = _actor(actorSeed);
        uint256 n = _openOrders[a].length;
        if (n == 0) return;
        idx = bound(idx, 0, n - 1);
        uint64 id = _openOrders[a][idx];
        IOrderBook.OrderView memory o = ob.getOrder(id);
        vm.prank(a);
        vm.recordLogs();
        ob.cancelOrder(id);
        _ingest();
        _openOrders[a][idx] = _openOrders[a][n - 1];
        _openOrders[a].pop();
        ghostOpenOrderCount[a]--;
        uint256 r = _reserve(uint256(o.remainingLots) * LOT, uint256(o.tick) * TICK);
        ghostReserved[a] = r > ghostReserved[a] ? 0 : ghostReserved[a] - r;
        calls++;
    }

    function moveMark(uint256 priceSeed) external {
        uint256 lo = P0 * (10_000 - BAND_BPS) / 10_000;
        uint256 hi = P0 * (10_000 + BAND_BPS) / 10_000;
        uint256 p = bound(priceSeed, lo, hi) / TICK * TICK;
        ch.mockSetMark(p);
        ob.mockSetFillPrice(p);
        oracle.setPrice(p);
        ob.mockSetBook(uint32(p / TICK) - 1, uint32(p / TICK) + 1);
        calls++;
    }

    /// @notice One block of funding: |r| ≤ cap and |r − r_prev| ≤ δ·n (MATH_SPEC §1.2); ΔG = I·Δt, ΔF = r·ΔG/1e18.
    function accrueFunding(int256 rateStepSeed, uint256 blocksSeed) external {
        FundingParams memory fp = ch.fundingParams();
        uint256 n = bound(blocksSeed, 1, 20);
        vm.roll(block.number + n);
        vm.warp(block.timestamp + n * fp.blockTimeMs / 1000 + 1);
        int256 maxStep = int256(fp.maxRateChangePerBlock * n);
        int256 r = ghostPrevRate + bound(rateStepSeed, -maxStep, maxStep);
        int256 cap = int256(fp.rateCap);
        if (r > cap) r = cap;
        if (r < -cap) r = -cap;
        int256 dG = int256(oracle.price()) * int256(n * fp.blockTimeMs) / 1000; // MATH_SPEC §1.2, rounds down
        int256 dF = r * dG / W; // MATH_SPEC §1.2 (mock: truncation; real CH: |r|·I·dt via fullMulDiv then sign)
        vm.recordLogs();
        ch.mockAccrue(dF, dG, r);
        _ingest();
        swaps.accrue(dF, dG);
        if (_absI(r - ghostPrevRate) > uint256(maxStep)) ghostRateStepViolated = true;
        ghostPrevRate = r;
        ghostPrevRateBlock = block.number;
        (, int256 g,) = ch.latestObservation();
        if (g < ghostLastG) ghostGDecreased = true;
        ghostLastG = g;
        calls++;
    }

    function settleFunding(uint256 actorSeed) external {
        vm.recordLogs();
        ch.settleFunding(_actorOrMaker(actorSeed));
        _ingest();
        calls++;
    }

    /// @notice I10: a fresh actor's deposit → withdraw round trip with no price move never profits.
    function perpRoundTrip(uint256 amountToken) external {
        amountToken = bound(amountToken, 1, 1_000_000e6);
        address a = address(uint160(0xF000 + calls));
        ausd.mint(a, amountToken);
        vm.startPrank(a);
        ausd.approve(address(ch), amountToken);
        vm.recordLogs();
        ch.deposit(amountToken);
        uint256 back = ch.collateralOf(a) / PulseConstants.AUSD_TO_WAD; // rounds down (user receives less)
        ch.withdraw(back);
        vm.stopPrank();
        _ingest();
        ghostDepositedToken += amountToken;
        ghostWithdrawnToken += back;
        if (back > amountToken) ghostFreeMoney = true;
        calls++;
    }

    // ─── actions: vault ───────────────────────────────────────────────────────

    function vaultDeposit(uint256 actorSeed, uint256 assets) external {
        address a = _actor(actorSeed);
        assets = bound(assets, 1, 1_000_000e6);
        ausd.mint(a, assets);
        uint256 before = vault.convertToAssets(1e18);
        vm.startPrank(a);
        ausd.approve(address(vault), assets);
        vault.deposit(assets, a);
        vm.stopPrank();
        if (vault.convertToAssets(1e18) < before) ghostSharePriceDropped = true;
        calls++;
    }

    function vaultRedeem(uint256 actorSeed, uint256 shares) external {
        address a = _actor(actorSeed);
        uint256 bal = vault.balanceOf(a);
        if (bal == 0) return;
        shares = bound(shares, 1, bal);
        uint256 before = vault.convertToAssets(1e18);
        vm.prank(a);
        vault.redeem(shares, a, a);
        if (vault.convertToAssets(1e18) < before) ghostSharePriceDropped = true;
        calls++;
    }

    function vaultGain(uint256 assets) external {
        vault.mockGain(bound(assets, 0, 10_000e6));
        calls++;
    }

    function vaultRoundTrip(uint256 assets) external {
        assets = bound(assets, 1, 1_000_000e6);
        address a = address(uint160(0xE000 + calls));
        ausd.mint(a, assets);
        vm.startPrank(a);
        ausd.approve(address(vault), assets);
        uint256 shares = vault.deposit(assets, a);
        uint256 back = vault.redeem(shares, a, a);
        vm.stopPrank();
        if (back > assets) ghostFreeMoney = true;
        calls++;
    }

    // ─── actions: funding swaps (reference model until WS-05) ─────────────────

    function swapFill(uint256 buyerSeed, uint256 sellerSeed, uint256 size, int256 aprWad) external {
        if (swaps.matured()) return;
        address b = _actor(buyerSeed);
        address s = _actor(sellerSeed);
        if (b == s) s = _actor(buyerSeed + 1);
        size = bound(size, 1e18, 10_000_000e18);
        aprWad = bound(aprWad, -0.5e18, 2e18); // book price p = 1 + A > 0
        (int256 qb0, int256 kb0,,) = swaps.accounts(b);
        (int256 qs0, int256 ks0,,) = swaps.accounts(s);
        (int256 nb, int256 ns) = swaps.fill(b, s, int256(size), aprWad);
        (int256 qb1, int256 kb1,,) = swaps.accounts(b);
        (int256 qs1, int256 ks1,,) = swaps.accounts(s);
        // ghost Σq / ΣK from the observed per-account changes of this fill
        ghostSwapSumQ += (qb1 - qb0) + (qs1 - qs0);
        ghostSwapSumK += (kb1 - kb0) + (ks1 - ks0);
        ghostSwapSettledNet += nb + ns;
        ghostSwapSettlements += 2;
        swapFills++;
        calls++;
    }

    function swapSettle(uint256 actorSeed) external {
        ghostSwapSettledNet += swaps.settle(_actor(actorSeed));
        ghostSwapSettlements++;
        calls++;
    }

    function swapMature() external {
        if (swaps.matured() || calls < 96) return; // mature late in a run so fills and accrual get exercised first
        swaps.settleMaturity();
        ghostSwapTotalAtMaturity = ghostSwapSettledNet + swapSumPending();
        ghostSwapMaturedSnapshotTaken = true;
        calls++;
    }

    // ─── views for the invariant contract ────────────────────────────────────

    function actorCount() external pure returns (uint256) {
        return N_ACTORS;
    }

    /// @notice Every account that can hold a perp position: actors + the mock maker.
    function account(uint256 i) public view returns (address) {
        return i < N_ACTORS ? actors[i] : maker;
    }

    function swapSumPending() public view returns (int256 s) {
        for (uint256 i; i < N_ACTORS; ++i) {
            s += swaps.pendingNet(actors[i]);
        }
    }

    function swapSums() external view returns (int256 sq, int256 sk) {
        for (uint256 i; i < N_ACTORS; ++i) {
            (int256 q, int256 k,,) = swaps.accounts(actors[i]);
            sq += q;
            sk += k;
        }
    }

    // ─── internals ────────────────────────────────────────────────────────────

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % N_ACTORS];
    }

    function _actorOrMaker(uint256 seed) internal view returns (address) {
        return account(seed % (N_ACTORS + 1));
    }

    /// @dev Mock reservation formula (size·price/1e18·imr/1e18, truncating). MATH_SPEC §3.2 rounds up (real CH).
    function _reserve(uint256 sizeWad, uint256 priceWad) internal view returns (uint256) {
        return sizeWad * priceWad / PulseConstants.WAD * ch.riskParams().imr / PulseConstants.WAD;
    }

    /// @dev vm.getRecordedLogs() also returns logs of calls that reverted inside try/catch: drop them.
    function _discard() internal {
        vm.getRecordedLogs();
    }

    /// @dev Rebuilds ghosts from the logs of the last call (independent of contract views).
    function _ingest() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(ch) || l.topics.length == 0) continue;
            bytes32 t0 = l.topics[0];
            if (t0 == IClearingHouse.PositionChanged.selector) {
                (int256 sizeDelta,,,,,) = abi.decode(l.data, (int256, int256, uint256, int256, int256, bool));
                ghostSumQ += sizeDelta;
                ghostQ[address(uint160(uint256(l.topics[1])))] += sizeDelta;
            } else if (t0 == IClearingHouse.FundingSettled.selector) {
                (int256 payment,) = abi.decode(l.data, (int256, int256));
                ghostSettledOwed += payment;
                ghostSettlements++;
            } else if (t0 == IClearingHouse.FundingUpdated.selector) {
                uint256 b = uint256(l.topics[1]);
                uint256 c = ++ghostFundingUpdatesInBlock[b];
                if (c > ghostMaxFundingUpdatesPerBlock) ghostMaxFundingUpdatesPerBlock = c;
            }
        }
    }

    function _absI(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }
}
