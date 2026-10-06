// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";
import {ClearingHouse} from "../../../src/clearing/ClearingHouse.sol";
import {OrderBook} from "../../../src/orderbook/OrderBook.sol";
import {InsuranceFund} from "../../../src/clearing/InsuranceFund.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../../src/mocks/MockOracleAdapter.sol";
import {IClearingHouse} from "../../../src/interfaces/IClearingHouse.sol";
import {IOrderBook} from "../../../src/interfaces/IOrderBook.sol";
import {FundingState, AccountView} from "../../../src/interfaces/MeridianTypes.sol";

/// @title RealStackHandler — WS-08 handler over the REAL OrderBook ⇄ ClearingHouse (PHASES G2, C1 §2)
/// @notice Every action goes through the public entry points (the book calls the CH hooks itself), so the hook
///         order, evictions, reservations and funding settlements are the production ones. Ghost logic mirrors
///         A's ClearingHouseHandler (I1–I5, I11) and OrderBookHandler (I6, I7), which are typed to the mocks.
/// @dev Settlement ghosts are generic: amounts come from `FundingSettled` events of successful actions (a zero
///      owed emits nothing and adds nothing), and every actor whose `lastCumFunding` changed counts one settlement
///      term (dust bound). A pre-action `getAccount` preview is NOT the settled amount: the block's first touch can
///      happen inside the action after the book changed (e.g. cancel removes the order, then releaseOrderMargin
///      touches funding), so the premium sample, hence F, can differ from the preview. Index prices stay multiples of the
///      tick (1e12), so each G increment I·300/1000 is exact and I11's |ΔF| ≤ cap·ΔG/1e18 needs no tolerance.
contract RealStackHandler is Test {
    uint256 internal constant N = 6;
    uint256 internal constant MAX_OPEN_PER_ACTOR = 8;
    uint32 internal constant HALF_WINDOW = 16; // orders within ±16 ticks of the index tick

    ClearingHouse public immutable ch;
    OrderBook public immutable ob;
    MockOracleAdapter public immutable oracle;
    MockERC20 public immutable ausd;
    address[N] public actors;
    uint64[] internal _live;

    // I3
    int256 public ghostSettledOwed;
    uint256 public ghostSettlements;
    // I4: a FundingUpdated in a block that already had one, or F changed by a second touch
    bool public ghostTouchedTwice;
    uint64 internal _lastFundingEventBlock;
    // I5 / I11
    bool public ghostRateViolation;
    bool public ghostGDecreased;
    int256 internal _lastRate;
    uint64 internal _lastBlock;
    int256 internal _lastG;
    // a resting order's owner could not cancel it
    bool public ghostCancelFailed;
    // I7 tolerance (decision 6): ≤ 1 wei per maker fill
    mapping(address => uint256) public ghostMakerFills;

    mapping(bytes32 => uint256) public calls; // attempts
    mapping(bytes32 => uint256) public okCalls; // the protocol call succeeded
    uint256 public ghostLiquidatableSeen; // coverage: a liquidatable target existed when liquidate ran
    mapping(bytes4 => uint256) public liqFailures;
    bytes4 public lastLiqFailure;

    // PHASES 36 bad-debt waterfall (IF → fees → uncovered): coverage + ghost
    InsuranceFund public fund; // set once by the suite; the handler is an authorized market so it can drain it
    uint256 public ghostBadDebtShortfalls; // BadDebtSocialized events (the IF fell short)
    uint256 public ghostFeesAbsorbed; // ... where accrued fees covered a part
    uint256 public ghostUncoveredWithFees; // a liquidation left uncovered debt while fees were > 0 before it
    bool public ghostWaterfallViolation; // uncovered debt was added while positive fees remained

    // CR-007 coverage: maker fills the CH refused while paused / stale (order kept) vs evicted
    uint256 public ghostSkips;
    uint256 public ghostEvictions;
    address public owner; // CH owner, for the pause toggle (set once by the suite)

    bool internal _ok; // the current action's protocol call succeeded
    int256[N] internal _lastCumBefore;

    constructor(ClearingHouse ch_, OrderBook ob_, MockOracleAdapter oracle_, MockERC20 ausd_) {
        ch = ch_;
        ob = ob_;
        oracle = oracle_;
        ausd = ausd_;
        for (uint256 i; i < N; ++i) {
            actors[i] = address(uint160(0xA000 + i));
        }
        FundingState memory s = ch.fundingState();
        (_lastRate, _lastBlock, _lastG) = (s.rate, s.lastUpdateBlock, s.cumIndexTime);
    }

    // ─── bookkeeping around every action ─────────────────────────────────────────
    modifier tracked(bytes32 name) {
        for (uint256 i; i < N; ++i) {
            _lastCumBefore[i] = ch.getPosition(actors[i]).lastCumFunding;
        }
        vm.recordLogs();
        _ok = false;
        _;
        // vm.recordLogs also returns logs of calls that reverted (their state was rolled back), so events are
        // only counted when the action's single protocol call succeeded.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; _ok && i < logs.length; ++i) {
            bytes32 t0 = logs[i].topics[0];
            if (logs[i].emitter == address(ch) && t0 == IClearingHouse.FundingUpdated.selector) {
                uint64 b = uint64(uint256(logs[i].topics[1]));
                if (b == _lastFundingEventBlock) ghostTouchedTwice = true;
                _lastFundingEventBlock = b;
            } else if (logs[i].emitter == address(ch) && t0 == IClearingHouse.FundingSettled.selector) {
                (int256 payment,) = abi.decode(logs[i].data, (int256, int256));
                ghostSettledOwed += payment;
            } else if (logs[i].emitter == address(ch) && t0 == IClearingHouse.BadDebtSocialized.selector) {
                (uint256 req, uint256 byIF, uint256 unc) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                ++ghostBadDebtShortfalls;
                if (req - byIF - unc != 0) ++ghostFeesAbsorbed;
            } else if (logs[i].emitter == address(ob) && t0 == IOrderBook.Trade.selector) {
                ++ghostMakerFills[address(uint160(uint256(logs[i].topics[2])))];
            } else if (logs[i].emitter == address(ob) && t0 == IOrderBook.MakerFillSkipped.selector) {
                ++ghostSkips;
            } else if (logs[i].emitter == address(ob) && t0 == IOrderBook.OrderEvicted.selector) {
                ++ghostEvictions;
            }
        }
        for (uint256 i; i < N; ++i) {
            if (ch.getPosition(actors[i]).lastCumFunding != _lastCumBefore[i]) ++ghostSettlements;
        }
        _observeFunding();
        _prune();
        ++calls[name];
        if (_ok) ++okCalls[name];
    }

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

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % N];
    }

    function _indexTick() internal view returns (uint32) {
        return uint32(ch.indexPrice() / ob.tickSize());
    }

    // ═══ actions ═════════════════════════════════════════════════════════════════
    function deposit(uint256 actorSeed, uint256 amount) external tracked("deposit") {
        address a = _actor(actorSeed);
        amount = bound(amount, 1, 100e6); // small: positions near the 25k MON cap (~725 AUSD) run at up to ~5x
        ausd.mint(a, amount);
        vm.startPrank(a);
        ausd.approve(address(ch), amount);
        ch.deposit(amount);
        vm.stopPrank();
        _ok = true;
    }

    function withdraw(uint256 actorSeed, uint256 amount) external tracked("withdraw") {
        address a = _actor(actorSeed);
        vm.prank(a);
        try ch.withdraw(bound(amount, 1, 5000e6)) {
            _ok = true;
        } catch {}
    }

    function placeLimit(uint256 actorSeed, bool isBid, uint256 tickSeed, uint256 lotsSeed, uint256 flagSeed)
        external
        tracked("limit")
    {
        address a = _actor(actorSeed);
        if (ob.openOrderCount(a) >= MAX_OPEN_PER_ACTOR) return;
        uint32 tick = _indexTick() - HALF_WINDOW + uint32(tickSeed % (2 * HALF_WINDOW + 1));
        uint8 flags = [uint8(0), 0, 0, 1, 2, 4][flagSeed % 6];
        vm.prank(a);
        try ob.placeLimitOrder(isBid, tick, uint64(bound(lotsSeed, 1, 40)), flags) returns (uint64 id, uint64) {
            if (id != 0) _live.push(id);
            _ok = true;
        } catch {}
    }

    function placeMarket(uint256 actorSeed, bool isBid, uint256 lotsSeed, bool reduceOnly) external tracked("market") {
        address a = _actor(actorSeed);
        uint32 it = _indexTick();
        uint32 limit = isBid ? it + 2 * HALF_WINDOW : it - 2 * HALF_WINDOW;
        vm.prank(a);
        // up to the 250-lot position cap: the IM check then leaves accounts at up to ~5x, so moves can liquidate
        try ob.placeMarketOrder(isBid, uint64(bound(lotsSeed, 1, 250)), limit, 0, reduceOnly) {
            _ok = true;
        } catch {}
    }

    function cancel(uint256 idxSeed) external tracked("cancel") {
        if (_live.length == 0) return;
        uint64 id = _live[idxSeed % _live.length];
        vm.prank(ob.getOrder(id).maker);
        // must never revert for a resting order (paused, stale or not)
        try ob.cancelOrder(id) {
            _ok = true;
        } catch {
            ghostCancelFailed = true;
        }
    }

    function replace(uint256 idxSeed, uint256 tickSeed, uint256 lotsSeed) external tracked("replace") {
        if (_live.length == 0) return;
        uint64 id = _live[idxSeed % _live.length];
        uint32 tick = _indexTick() - HALF_WINDOW + uint32(tickSeed % (2 * HALF_WINDOW + 1));
        vm.prank(ob.getOrder(id).maker);
        try ob.replaceOrder(id, tick, uint64(bound(lotsSeed, 1, 40)), 0) returns (uint64 nid, uint64) {
            if (nid != 0) _live.push(nid);
            _ok = true;
        } catch {}
    }

    /// Liquidates the first liquidatable actor from `targetSeed` on, by the actor with the most free margin.
    function liquidate(uint256 targetSeed, uint256 size) external tracked("liquidate") {
        targetSeed %= N;
        address t;
        for (uint256 i; i < N; ++i) {
            address a = actors[(targetSeed + i) % N];
            if (ch.isLiquidatable(a)) {
                t = a;
                break;
            }
        }
        if (t == address(0)) return;
        ++ghostLiquidatableSeen;
        address k;
        int256 best = type(int256).min;
        for (uint256 i; i < N; ++i) {
            if (actors[i] == t) continue;
            AccountView memory v = ch.getAccount(actors[i]);
            int256 f = v.equity - int256(v.initialMargin);
            if (f > best) (best, k) = (f, actors[i]);
        }
        uint256 fees0 = ch.accruedFees();
        uint256 bad0 = ch.totalBadDebt();
        vm.prank(k);
        try ch.liquidate(t, bound(size, 1e18, 1e24)) {
            _ok = true;
            if (ch.totalBadDebt() != bad0) {
                if (ch.accruedFees() != 0) ghostWaterfallViolation = true;
                if (fees0 != 0) ++ghostUncoveredWithFees;
            }
        } catch (bytes memory err) {
            ++liqFailures[bytes4(err)];
            lastLiqFailure = bytes4(err);
        }
    }

    function settle(uint256 actorSeed) external tracked("settle") {
        ch.settleFunding(_actor(actorSeed));
        _ok = true;
    }

    function pokeTwice() external tracked("poke") {
        int256 f1 = ch.updateFunding();
        int256 f2 = ch.updateFunding();
        if (f1 != f2) ghostTouchedTwice = true;
        _ok = true;
    }

    function roll(uint256 blocks) external {
        blocks = bound(blocks, 1, 600);
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + (blocks * 3 + 9) / 10);
        ++calls["roll"];
    }

    function movePrice(int256 bps) external {
        uint256 tickSize = ob.tickSize();
        uint256 p = oracle.price();
        uint256 np = uint256(int256(p) * (10_000 + bound(bps, -800, 800)) / 10_000) / tickSize * tickSize;
        oracle.setPrice(FPM.clamp(np, 0.01e18, 0.08e18));
        ++calls["price"];
    }

    /// ±15% index jump (the CP1 crash), then a new block whose first touch re-caches the mark.
    function crash(bool down) external {
        uint256 tickSize = ob.tickSize();
        uint256 p = oracle.price();
        uint256 np = (down ? p * 85 / 100 : p * 115 / 100) / tickSize * tickSize;
        oracle.setPrice(FPM.clamp(np, 0.01e18, 0.08e18));
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1);
        ch.updateFunding();
        ++calls["crash"];
    }

    function setInsuranceFund(InsuranceFund fund_) external {
        fund = fund_;
    }

    /// Half the time it is called, empty the IF (the handler is an authorized market), so later bad debt runs
    /// through fees and then becomes uncovered (PHASES 36).
    function drainInsurance(uint256 coin) external {
        ++calls["drainIF"];
        if (coin % 2 != 0 || address(fund) == address(0)) return;
        uint256 bal = fund.balance();
        if (bal != 0) fund.coverBadDebt(bal);
    }

    function setStale(uint256 seed) external {
        oracle.setStale(seed % 4 == 0); // stale a quarter of the time it is called
        ++calls["stale"];
    }

    function setOwner(address owner_) external {
        owner = owner_;
    }

    /// CR-007: pause a quarter of the time it is called (increasing maker fills Skip, cancels always work).
    function setPaused(uint256 seed) external {
        if (owner == address(0)) return;
        vm.prank(owner);
        ch.setPaused(seed % 4 == 0);
        ++calls["paused"];
    }

    function _prune() internal {
        uint256 i;
        while (i < _live.length) {
            if (ob.getOrder(_live[i]).remainingLots == 0) {
                _live[i] = _live[_live.length - 1];
                _live.pop();
            } else {
                ++i;
            }
        }
    }

    // ═══ invariant values ════════════════════════════════════════════════════════
    /// I1 (amended, decision 7): balance·1e12 − (ΣC − ΣON − Σpending + fees) ≥ 0.
    function checkSolvencySlack() external view returns (int256) {
        int256 liabilities = int256(ch.accruedFees());
        for (uint256 i; i < N; ++i) {
            liabilities += ch.collateralOf(actors[i]) - ch.getAccount(actors[i]).pendingFunding
            - ch.getPosition(actors[i]).openNotional;
        }
        return int256(ausd.balanceOf(address(ch)) * 1e12) - liabilities;
    }

    /// I2: (longOI, shortOI, Σ max(q,0), Σ max(−q,0), Σq).
    function checkOI() external view returns (uint256 lo, uint256 so, uint256 sumLong, uint256 sumShort, int256 sumQ) {
        (lo, so) = ch.openInterest();
        for (uint256 i; i < N; ++i) {
            int256 q = ch.getPosition(actors[i]).size;
            sumQ += q;
            if (q > 0) sumLong += uint256(q);
            else sumShort += uint256(-q);
        }
    }

    /// I3: (Σ settled owed + Σ pending, number of settlement terms incl. the pending ones).
    function checkFundingConservation() external view returns (int256 total, uint256 terms) {
        total = ghostSettledOwed;
        for (uint256 i; i < N; ++i) {
            total += ch.getAccount(actors[i]).pendingFunding;
        }
        terms = ghostSettlements + N;
    }

    /// I11: checkpoint blocks strictly increase from the oldest, G never decreases, |ΔF| ≤ cap·ΔG/1e18.
    function checkCheckpoints() external view returns (bool) {
        uint256 slots = 1440;
        uint256 cap = ch.fundingParams().rateCap;
        (,, uint64 nextBlk) = ch.checkpointAt(0);
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

    /// I6: bestBid < bestAsk; per level totals/counts = Σ resting orders; getDepth (walks the bitmaps) lists
    ///     exactly the non-empty levels, best first; openOrderCount = resting orders per actor.
    function checkI6() external view {
        uint32 bb = ob.bestBid();
        uint32 ba = ob.bestAsk();
        if (bb != 0 && ba != type(uint32).max) require(bb < ba, "I6: crossed");
        uint256 n = _live.length;
        uint32[] memory ticks = new uint32[](n);
        bool[] memory bid = new bool[](n);
        uint256[N] memory perActor;
        uint256 levels;
        for (uint256 i; i < n; ++i) {
            IOrderBook.OrderView memory o = ob.getOrder(_live[i]);
            require(o.remainingLots != 0, "I6: pruned order still listed");
            ++perActor[uint160(o.maker) - 0xA000];
            bool seen;
            for (uint256 j; j < levels; ++j) {
                if (ticks[j] == o.tick) {
                    require(bid[j] == o.isBid, "I6: both sides on one level");
                    seen = true;
                }
            }
            if (!seen) (ticks[levels], bid[levels], levels) = (o.tick, o.isBid, levels + 1);
        }
        for (uint256 a; a < N; ++a) {
            require(ob.openOrderCount(actors[a]) == perActor[a], "I6: openOrderCount");
        }
        uint256 nBid;
        uint256 nAsk;
        for (uint256 j; j < levels; ++j) {
            uint64 sum;
            uint32 cnt;
            for (uint256 i; i < n; ++i) {
                IOrderBook.OrderView memory o = ob.getOrder(_live[i]);
                if (o.tick == ticks[j]) (sum, cnt) = (sum + o.remainingLots, cnt + 1);
            }
            (uint64 lots, uint32 c) = ob.getLevel(ticks[j]);
            require(lots == sum && c == cnt, "I6: level totals");
            if (bid[j]) ++nBid;
            else ++nAsk;
        }
        _checkDepth(true, ticks, bid, levels, nBid);
        _checkDepth(false, ticks, bid, levels, nAsk);
    }

    /// getDepth must return exactly the `count` non-empty levels of the side, best first (≤ 32 per call).
    function _checkDepth(bool isBid, uint32[] memory ticks, bool[] memory bid, uint256 levels, uint256 count)
        internal
        view
    {
        (uint32[] memory dt,) = ob.getDepth(isBid, 32);
        require(dt.length == FPM.min(count, 32), "I6: bitmap level count");
        for (uint256 k; k < dt.length; ++k) {
            // dt[k] must be one of our levels on this side, and strictly worse than dt[k-1]
            bool found;
            for (uint256 j; j < levels; ++j) {
                if (ticks[j] == dt[k] && bid[j] == isBid) found = true;
            }
            require(found, "I6: bitmap bit on an empty level");
            if (k > 0) require(isBid ? dt[k] < dt[k - 1] : dt[k] > dt[k - 1], "I6: depth order");
        }
        if (count != 0) require(dt[0] == (isBid ? ob.bestBid() : ob.bestAsk()), "I6: best != first level");
    }

    /// I7: CH reservation per actor = Σ orderMargin(resting orders), within ≤ 1 wei per maker fill (decision 6).
    function checkI7() external view {
        uint256 imr = ch.riskParams().imr;
        uint256[N] memory expected;
        for (uint256 i; i < _live.length; ++i) {
            IOrderBook.OrderView memory o = ob.getOrder(_live[i]);
            uint256 size = uint256(o.remainingLots) * ob.lotSize();
            uint256 price = uint256(o.tick) * ob.tickSize();
            expected[uint160(o.maker) - 0xA000] += FPM.mulWadUp(FPM.mulWadUp(size, price), imr);
        }
        for (uint256 a; a < N; ++a) {
            uint256 r = ch.getAccount(actors[a]).reservedOrderMargin;
            uint256 tol = ghostMakerFills[actors[a]];
            require(r <= expected[a] + tol && r + tol >= expected[a], "I7: reservation");
        }
    }

    function liveCount() external view returns (uint256) {
        return _live.length;
    }
}
