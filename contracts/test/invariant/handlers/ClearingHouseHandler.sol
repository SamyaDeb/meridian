// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";
import {ClearingHouse} from "../../../src/clearing/ClearingHouse.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../../src/mocks/MockOracleAdapter.sol";
import {MockOrderBook} from "../../../src/mocks/MockOrderBook.sol";
import {IClearingHouse} from "../../../src/interfaces/IClearingHouse.sol";
import {IMarginEngine} from "../../../src/interfaces/IMarginEngine.sol";
import {FundingState, AccountView} from "../../../src/interfaces/MeridianTypes.sol";

/// @title ClearingHouseHandler — WS-02 handler for invariants I1–I5 and I11 (MATH_SPEC §7)
/// @notice Drives one ClearingHouse through deposits, withdrawals, fills (maker then taker, both via the
///         IMarginEngine hooks pranked as the book, all-or-nothing), liquidations, funding pokes, block rolls,
///         index moves, book quotes and oracle outages. Keeps the ghost state the invariants need; the
///         `check*` views return the invariant values so WS-08's suites can assert on them.
/// @dev Index prices stay multiples of 1e14 (a Pyth price ×1e10 always is a multiple of 10), which makes each
///      step's G increment exact and the I11 bound |ΔF| ≤ cap·ΔG/1e18 hold without tolerance.
contract ClearingHouseHandler is Test {
    ClearingHouse public immutable ch;
    MockOrderBook public immutable ob;
    MockOracleAdapter public immutable oracle;
    MockERC20 public immutable ausd;
    address[] public actors;

    // ─── ghosts ───────────────────────────────────────────────────────────────
    /// I3: funding settled so far (sum of `owed`, WAD) and number of settlements.
    int256 public ghostSettledOwed;
    uint256 public ghostSettlements;
    /// I4: a second touch in the same block changed F or emitted a second FundingUpdated.
    bool public ghostTouchedTwice;
    /// I5: a stored rate outside the cap or moving more than δ·n since the previous stored rate.
    bool public ghostRateViolation;
    /// I11: G decreased between two observed states.
    bool public ghostGDecreased;
    int256 internal _lastRate;
    uint64 internal _lastBlock;
    int256 internal _lastG;
    mapping(bytes32 => uint256) public calls;

    constructor(ClearingHouse ch_, MockOrderBook ob_, MockOracleAdapter oracle_, MockERC20 ausd_, address[] memory a) {
        ch = ch_;
        ob = ob_;
        oracle = oracle_;
        ausd = ausd_;
        actors = a;
        FundingState memory s = ch.fundingState();
        (_lastRate, _lastBlock, _lastG) = (s.rate, s.lastUpdateBlock, s.cumIndexTime);
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// Record the funding each account is about to settle (the next touch happens in this block at the
    /// previewed F, so the view equals the settled amount exactly).
    function _pending(address a) internal view returns (int256) {
        return ch.getAccount(a).pendingFunding;
    }

    function _recordSettle(int256 owed) internal {
        ghostSettledOwed += owed;
        ++ghostSettlements;
    }

    /// I5 and I11 (G monotone) after every action.
    function _observeFunding() internal {
        FundingState memory s = ch.fundingState();
        if (s.lastUpdateBlock != _lastBlock) {
            uint256 n = s.lastUpdateBlock - _lastBlock;
            uint256 cap = ch.fundingParams().rateCap;
            uint256 delta = ch.fundingParams().maxRateChangePerBlock;
            if (FPM.abs(s.rate) > cap || FPM.abs(s.rate - _lastRate) > delta * n) ghostRateViolation = true;
            (_lastRate, _lastBlock) = (s.rate, s.lastUpdateBlock);
        }
        if (s.cumIndexTime < _lastG) ghostGDecreased = true;
        _lastG = s.cumIndexTime;
    }

    // ═══ actions ═════════════════════════════════════════════════════════════════

    function deposit(uint256 actorSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        amount = bound(amount, 1, 50_000e6);
        ausd.mint(a, amount);
        vm.startPrank(a); // deposits do not settle funding
        ausd.approve(address(ch), amount);
        ch.deposit(amount);
        vm.stopPrank();
        ++calls["deposit"];
        _observeFunding();
    }

    function withdraw(uint256 actorSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        amount = bound(amount, 1, 50_000e6);
        int256 p = _pending(a);
        vm.prank(a);
        try ch.withdraw(amount) {
            _recordSettle(p);
            ++calls["withdraw"];
        } catch {}
        _observeFunding();
    }

    /// Maker fill then taker fill in one all-or-nothing call (the real book's order).
    function trade(uint256 takerSeed, uint256 makerSeed, bool takerIsBid, uint256 lots, int256 offsetBps) external {
        address taker = _actor(takerSeed);
        address maker = _actor(makerSeed);
        if (taker == maker) return;
        uint256 index = ch.indexPrice();
        if (index == 0) return;
        // Size up to ~4.9x of the smaller free equity of the two sides, so fills mostly succeed and
        // accounts can get close enough to maintenance for price moves to make them liquidatable.
        int256 free = FPM.min(_free(taker), _free(maker));
        uint256 maxLots = free > 0 ? uint256(free) * 49 / 10 / index : 0;
        uint256 size = bound(lots, 1, FPM.max(maxLots, 1)) * 1e18;
        // fill within ±2% of index, on a 1e-4 tick
        uint256 price = uint256(int256(index) * (10_000 + bound(offsetBps, -200, 200)) / 10_000) / 1e14 * 1e14;
        (int256 pt, int256 pm) = (_pending(taker), _pending(maker));
        try this.doTrade(taker, maker, takerIsBid, size, price) {
            _recordSettle(pm);
            _recordSettle(pt);
            ob.mockSetLastTrade(price, uint64(block.number));
            ++calls["trade"];
        } catch {}
        _observeFunding();
    }

    function _free(address a) internal view returns (int256) {
        AccountView memory v = ch.getAccount(a);
        return v.equity - int256(v.initialMargin);
    }

    function doTrade(address taker, address maker, bool takerIsBid, uint256 size, uint256 price) external {
        require(msg.sender == address(this));
        vm.prank(address(ob));
        require(
            ch.settleMakerFill(maker, !takerIsBid, size, price) == IMarginEngine.MakerFillResult.Filled, "maker refused"
        );
        vm.prank(address(ob));
        ch.settleTakerFill(taker, takerIsBid, size, FPM.mulWad(size, price), false);
    }

    /// Liquidates the first liquidatable actor from `targetSeed` on (bounded scan over the fixed actor set),
    /// by the actor with the most free margin.
    function liquidate(uint256 targetSeed, uint256 size) external {
        uint256 n = actors.length;
        targetSeed %= n;
        address t = actors[targetSeed];
        address k;
        int256 best = type(int256).min;
        for (uint256 i; i < n; ++i) {
            address a = actors[(targetSeed + i) % n];
            if (ch.isLiquidatable(a) && !ch.isLiquidatable(t)) t = a;
        }
        for (uint256 i; i < n; ++i) {
            if (actors[i] == t) continue;
            int256 f = _free(actors[i]);
            if (f > best) (best, k) = (f, actors[i]);
        }
        (int256 pt, int256 pk) = (_pending(t), _pending(k));
        vm.prank(k);
        try ch.liquidate(t, bound(size, 1, 1e24)) {
            _recordSettle(pt);
            _recordSettle(pk);
            ++calls["liquidate"];
        } catch {}
        _observeFunding();
    }

    function settle(uint256 actorSeed) external {
        address a = _actor(actorSeed);
        int256 p = _pending(a);
        ch.settleFunding(a);
        _recordSettle(p);
        ++calls["settle"];
        _observeFunding();
    }

    /// I4: two pokes in one block ⇒ F unchanged and at most one FundingUpdated.
    function pokeTwice() external {
        vm.recordLogs();
        int256 f1 = ch.updateFunding();
        int256 f2 = ch.updateFunding();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IClearingHouse.FundingUpdated.selector) ++n;
        }
        if (f1 != f2 || n > 1) ghostTouchedTwice = true;
        ++calls["poke"];
        _observeFunding();
    }

    function roll(uint256 blocks) external {
        vm.roll(block.number + bound(blocks, 1, 600));
        ++calls["roll"];
    }

    function movePrice(int256 bps) external {
        uint256 p = oracle.price();
        uint256 np = uint256(int256(p) * (10_000 + bound(bps, -800, 800)) / 10_000) / 1e14 * 1e14;
        oracle.setPrice(FPM.clamp(np, 0.5e18, 8e18));
        ++calls["price"];
    }

    function quote(int256 midBps, uint256 halfSpreadTicks) external {
        uint256 tick = oracle.price() / 1e14;
        uint256 mid = uint256(int256(tick) * (10_000 + bound(midBps, -300, 300)) / 10_000);
        uint256 hs = bound(halfSpreadTicks, 1, 500);
        ob.mockSetBook(uint32(mid - hs), uint32(mid + hs));
        ++calls["quote"];
    }

    function setStale(bool stale) external {
        oracle.setStale(stale);
        ++calls["stale"];
    }

    // ═══ invariant values ════════════════════════════════════════════════════════

    /// I1: token balance (WAD) − (Σ(C − pendingFunding) − ΣON + fees). Must be ≥ 0 (non-negative dust).
    /// @dev Pending funding is included so the check holds mid-run: a receiver who settled first has its C
    ///      credited while the payer's debit is still pending. With every account settled this is exactly
    ///      MATH_SPEC §7 I1 (ΣC − ΣON + fees).
    function checkSolvencySlack() external view returns (int256) {
        int256 liabilities = int256(ch.accruedFees());
        for (uint256 i; i < actors.length; ++i) {
            AccountView memory v = ch.getAccount(actors[i]);
            liabilities += ch.collateralOf(actors[i]) - v.pendingFunding - ch.getPosition(actors[i]).openNotional;
        }
        return int256(ausd.balanceOf(address(ch)) * 1e12) - liabilities;
    }

    /// I2: (longOI, shortOI, Σ max(q,0), Σ max(−q,0)).
    function checkOI() external view returns (uint256 lo, uint256 so, uint256 sumLong, uint256 sumShort) {
        (lo, so) = ch.openInterest();
        for (uint256 i; i < actors.length; ++i) {
            int256 q = ch.getPosition(actors[i]).size;
            if (q > 0) sumLong += uint256(q);
            else sumShort += uint256(-q);
        }
    }

    /// I3: (Σ settled owed + Σ pending, number of settlement terms incl. the pending ones).
    function checkFundingConservation() external view returns (int256 total, uint256 terms) {
        total = ghostSettledOwed;
        for (uint256 i; i < actors.length; ++i) {
            total += ch.getAccount(actors[i]).pendingFunding;
        }
        terms = ghostSettlements + actors.length;
    }

    /// I11: checkpoint blocks strictly increase from the oldest, G never decreases between them, and
    ///      |ΔF| ≤ cap·ΔG/1e18 between consecutive checkpoints. Returns false on the first violation.
    function checkCheckpoints() external view returns (bool ok) {
        uint256 slots = 1440;
        uint256 cap = ch.fundingParams().rateCap;
        (,, uint64 nextBlk) = ch.checkpointAt(0);
        // find the newest slot: the last written one before a lower (or empty) block number
        uint256 newest;
        for (uint256 i = 1; i < slots; ++i) {
            (,, uint64 b) = ch.checkpointAt(i);
            if (b == 0 || b < nextBlk) break;
            newest = i;
            nextBlk = b;
        }
        uint256 start = (newest + 1) % slots;
        (,, uint64 sb) = ch.checkpointAt(start);
        if (sb == 0) start = 0;
        (int256 pf, int256 pg, uint64 pb) = ch.checkpointAt(start);
        for (uint256 k = 1; k < slots; ++k) {
            uint256 i = (start + k) % slots;
            (int256 f, int256 g, uint64 b) = ch.checkpointAt(i);
            if (b == 0 || i == (newest + 1) % slots) break;
            if (b <= pb || g < pg) return false;
            if (FPM.abs(f - pf) > FPM.fullMulDiv(cap, uint256(g - pg), 1e18)) return false;
            (pf, pg, pb) = (f, g, b);
        }
        return true;
    }
}
