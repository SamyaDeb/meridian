// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";
import {IClearingHouse} from "../interfaces/IClearingHouse.sol";
import {IMarginEngine} from "../interfaces/IMarginEngine.sol";
import {IFundingRateOracle} from "../interfaces/IFundingRateOracle.sol";
import {IOracleAdapter} from "../interfaces/IOracleAdapter.sol";
import {IOrderBook} from "../interfaces/IOrderBook.sol";
import {IInsuranceFund} from "../interfaces/IInsuranceFund.sol";
import {
    PulseConstants,
    RiskParams,
    FundingParams,
    FundingState,
    Position,
    AccountView
} from "../interfaces/PulseTypes.sol";
import {FundingLib} from "../libs/FundingLib.sol";
import {MarkPriceLib} from "../libs/MarkPriceLib.sol";
import {MarginLib} from "../libs/MarginLib.sol";

/// @title ClearingHouse — isolated-margin perp accounting, per-block funding and the funding-rate oracle
/// @notice One instance per market. Funding is O(1): the first transaction touching the market in a block
///         advances F (funding per base) and G (index·time per base), caches the block's mark price and, once
///         per 200-block bucket, writes a checkpoint into a 1440-slot ring. Accounts settle lazily.
///         No loops except FundingLib's pow-by-squaring and the ≤ 11-step checkpoint binary search.
contract ClearingHouse is IClearingHouse, Ownable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant TO_WAD = PulseConstants.AUSD_TO_WAD;
    uint256 internal constant CKPT_BLOCKS = PulseConstants.CHECKPOINT_BLOCKS;
    /// @dev = PulseConstants.CHECKPOINT_SLOTS (a literal: array lengths need one; equality asserted in tests)
    uint256 internal constant CKPT_SLOTS = 1440;

    // ─── Hard bounds on admin parameters ───────────────────────────────────────
    uint256 internal constant MAX_IMR = 0.5e18;
    uint256 internal constant MAX_TAKER_FEE = 0.01e18;
    uint256 internal constant MAX_CAP_SIZE = 1e30;
    uint256 internal constant MAX_ALPHA = 0.5e18;
    uint256 internal constant MAX_PREMIUM_BAND = 0.5e18;
    /// @dev 1%/h per second, WAD (rounded up).
    uint256 internal constant MAX_RATE_CAP = 2_777_777_777_778;
    uint256 internal constant MIN_BLOCK_TIME_MS = 100;
    uint256 internal constant MAX_BLOCK_TIME_MS = 2000;
    /// @dev Largest index accepted (else the oracle counts as stale): prices are stored as uint96 and the mark can be
    ///      up to I·(1 + markBand), so half the uint96 range keeps every stored price in range (≈ 4e10 AUSD/unit).
    uint256 internal constant MAX_INDEX = type(uint96).max / 2;

    // ─── Storage (Ownable._owner is slot 0; slots 1..13 share MIP-8 page 0) ────
    struct FundingSlotA {
        int128 cumFunding; // F
        uint128 cumIndexTime; // G
    }

    struct FundingSlotB {
        int64 emaPremium;
        int64 rate;
        uint64 lastUpdateBlock;
        uint16 checkpointIdx;
        bool oracleStale; // result of the oracle read at lastUpdateBlock
    }

    /// @dev One slot read by every touch: prices are bounded by `_tryIndex` (index ≤ MAX_INDEX, mark ≤ 1.05·index) and the
    ///      book's tick size rides along so the first touch doesn't pay a separate cold read for it.
    struct PriceSlot {
        uint96 lastIndex; // last good index
        uint96 mark; // mark cached at lastUpdateBlock (last good mark while stale)
        uint64 tickSize; // OrderBook tick size (WAD), set once by setOrderBook
    }

    // FundingParams packed into ONE slot (read on every first touch): bits [0,59) alpha, [59,118) premiumBand,
    // [118,160) rateCap, [160,202) maxRateChangePerBlock, [202,244) |interestRate|, [244] interestRate < 0,
    // [245,256) blockTimeMs. `_storeFunding`'s bounds guarantee the fit: alpha, band ≤ 0.5e18 < 2^59;
    // rateCap ≤ MAX_RATE_CAP < 2^42, δ ≤ rateCap, |i| ≤ rateCap; blockTimeMs ≤ 2000 < 2^11.
    uint256 internal constant FP_BITS_59 = (1 << 59) - 1;
    uint256 internal constant FP_BITS_42 = (1 << 42) - 1;

    struct RiskPacked {
        uint64 imr;
        uint64 mmr;
        uint64 takerFee;
        int64 makerFee;
        uint64 liqPenalty;
        uint64 keeperShare;
        uint128 maxOpenInterest;
        uint128 maxPositionSize;
    }

    struct Account {
        int256 collateral; // WAD; negative only for uncovered bad debt
        int128 size;
        int128 openNotional;
        int128 lastCumFunding;
        uint128 reserved;
    }

    struct Checkpoint {
        int256 cumFunding;
        uint64 blockNumber;
        uint192 cumIndexTime;
    }

    /// @dev In-memory result of a funding touch (or its preview).
    struct Touch {
        int256 cumFunding;
        int256 cumIndexTime;
        int256 emaPremium;
        int256 rate;
        int256 premium;
        uint256 index;
        uint256 mark;
        uint64 lastUpdateBlock;
        uint64 tickSize;
        uint16 checkpointIdx;
        bool stale;
        bool changed;
        bool checkpoint;
        /// @dev OI cap reference for `_checkFill`: longOI before the current order (taker), max (maker: skip).
        uint256 oiRef;
    }

    struct Fill {
        int256 dq; // signed size
        uint256 notional; // |dq|·price
        int256 fee; // + paid, − rebate
        uint256 price; // for the event (taker: average)
        bool isMaker;
    }

    struct Liq {
        uint256 notional;
        int256 realizedV;
        int256 realizedK;
        uint256 penalty;
        uint256 keeper;
        uint256 badDebt;
    }

    FundingSlotA internal _fa;
    FundingSlotB internal _fb;
    PriceSlot internal _px;
    uint256 internal _fp;
    RiskPacked internal _rp;
    /// @inheritdoc IMarginEngine
    address public orderBook;
    bool public paused;
    /// @dev Copy of `_rp.imr` in the slot every hook already reads for `onlyOrderBook` (saves a cold SLOAD on the
    ///      MM's place/cancel path). Written together with `_rp` in `_storeRisk`.
    uint64 internal _imr;
    uint128 internal _longOI;
    uint128 internal _shortOI;
    /// @dev WAD; signed because maker rebates settle before the taker fee inside one order.
    int256 internal _fees;
    /// @inheritdoc IClearingHouse
    uint256 public totalBadDebt;
    mapping(address => Account) internal _accounts;
    Checkpoint[CKPT_SLOTS] internal _ring;
    /// @dev longOI + 1 before the first maker fill of the order being matched (0 = unset). Makers settle before
    ///      the taker (INTERFACES §2), so the OI cap is checked once on the order's net result at the taker fill.
    uint256 transient _oiBeforeOrder;

    /// @inheritdoc IClearingHouse
    address public immutable collateralToken;
    /// @inheritdoc IClearingHouse
    address public immutable oracle;
    /// @inheritdoc IClearingHouse
    address public immutable insuranceFund;

    modifier onlyOrderBook() {
        if (msg.sender != orderBook) revert OnlyOrderBook();
        _;
    }

    constructor(
        address collateralToken_,
        address oracle_,
        address insuranceFund_,
        RiskParams memory risk,
        FundingParams memory funding,
        address owner_
    ) Ownable(owner_) {
        if (collateralToken_ == address(0) || oracle_ == address(0) || insuranceFund_ == address(0)) {
            revert InvalidParams();
        }
        collateralToken = collateralToken_;
        oracle = oracle_;
        insuranceFund = insuranceFund_;
        _storeRisk(risk);
        _storeFunding(funding);
        (bool ok, uint256 index) = _tryIndex();
        if (ok) _px = PriceSlot(uint96(index), uint96(index), 0);
        _fb = FundingSlotB(0, 0, uint64(block.number), 0, !ok);
        _ring[0] = Checkpoint(0, uint64(block.number), 0);
        emit FundingCheckpoint(0, uint64(block.number), 0, 0);
    }

    // ═══ Collateral ═════════════════════════════════════════════════════════════

    /// @inheritdoc IClearingHouse
    function deposit(uint256 amountToken) external nonReentrant {
        _deposit(msg.sender, amountToken);
    }

    /// @inheritdoc IClearingHouse
    function depositFor(address account, uint256 amountToken) external nonReentrant {
        if (account == address(0)) revert InvalidParams();
        _deposit(account, amountToken);
    }

    function _deposit(address account, uint256 amountToken) internal {
        if (amountToken == 0) revert ZeroAmount();
        _touchFunding();
        // AUSD→WAD is exact (CLAUDE.md §2)
        uint256 wad = amountToken * TO_WAD;
        _accounts[account].collateral += int256(wad);
        emit Deposited(account, amountToken, wad);
        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), amountToken);
    }

    /// @inheritdoc IClearingHouse
    /// @dev Only collateral can leave (never unrealized profit); equity after must cover IM (incl. reservations).
    function withdraw(uint256 amountToken) external nonReentrant {
        if (amountToken == 0) revert ZeroAmount();
        Touch memory t = _touchFunding();
        Account memory a = _accounts[msg.sender];
        _settle(msg.sender, a, t.cumFunding);
        uint256 wad = amountToken * TO_WAD;
        a.collateral -= int256(wad);
        if (a.collateral < 0) revert InsufficientMargin();
        if (a.size != 0 && t.stale) revert OracleStale();
        if (_equity(a, t.mark) < int256(_im(a, t.mark))) revert InsufficientMargin();
        _accounts[msg.sender] = a;
        emit Withdrawn(msg.sender, amountToken, wad);
        IERC20(collateralToken).safeTransfer(msg.sender, amountToken);
    }

    // ═══ Funding ════════════════════════════════════════════════════════════════

    /// @inheritdoc IClearingHouse
    function updateFunding() external nonReentrant returns (int256 cumFunding) {
        if (_fb.lastUpdateBlock == block.number) return _fa.cumFunding; // already touched: 2 SLOADs
        return _touchFunding().cumFunding;
    }

    /// @inheritdoc IClearingHouse
    function settleFunding(address account) external nonReentrant {
        Touch memory t = _touchFunding();
        Account memory a = _accounts[account];
        if (_settle(account, a, t.cumFunding)) _accounts[account] = a;
    }

    /// @dev First call per block writes F, G, EMA, rate, mark (+ a checkpoint on a new bucket); later calls read.
    function _touchFunding() internal returns (Touch memory t) {
        t = _preview();
        if (!t.changed) return t;
        if (t.checkpoint) {
            t.checkpointIdx = uint16((uint256(t.checkpointIdx) + 1) % CKPT_SLOTS);
            _ring[t.checkpointIdx] = Checkpoint(t.cumFunding, uint64(block.number), uint256(t.cumIndexTime).toUint192());
            emit FundingCheckpoint(t.checkpointIdx, uint64(block.number), t.cumFunding, t.cumIndexTime);
        }
        _fa = FundingSlotA(t.cumFunding.toInt128(), uint256(t.cumIndexTime).toUint128());
        _fb = FundingSlotB(
            int256(t.emaPremium).toInt64(), t.rate.toInt64(), uint64(block.number), t.checkpointIdx, t.stale
        );
        if (!t.stale) _px = PriceSlot(t.index.toUint96(), t.mark.toUint96(), t.tickSize);
        emit FundingUpdated(
            uint64(block.number), t.premium, t.emaPremium, t.rate, t.cumFunding, t.cumIndexTime, t.index, t.mark
        );
    }

    /// @dev The touch without writes: MATH_SPEC §1.2 (funding), §1.6 (stale oracle), §2 (mark), §1.8 (bucket).
    function _preview() internal view returns (Touch memory t) {
        FundingSlotA memory a = _fa;
        FundingSlotB memory b = _fb;
        PriceSlot memory px = _px;
        t.cumFunding = a.cumFunding;
        t.cumIndexTime = int256(uint256(a.cumIndexTime));
        t.emaPremium = b.emaPremium;
        t.rate = b.rate;
        t.index = px.lastIndex;
        t.mark = px.mark;
        t.tickSize = px.tickSize;
        t.lastUpdateBlock = b.lastUpdateBlock;
        t.checkpointIdx = b.checkpointIdx;
        t.stale = b.oracleStale;
        if (b.lastUpdateBlock == block.number) return t;

        t.changed = true;
        t.lastUpdateBlock = uint64(block.number);
        t.checkpoint = block.number / CKPT_BLOCKS != b.lastUpdateBlock / CKPT_BLOCKS;
        (bool ok, uint256 index) = _tryIndex();
        t.stale = !ok;
        // MATH_SPEC §1.6: stale ⇒ no premium sample, no accrual (F and G frozen), mark stays the last good one
        if (!ok) return t;

        (uint256 bid, uint256 ask, uint256 lastPx, uint256 lastBlk) = _book(t.tickSize);
        FundingState memory s = FundingState(t.cumFunding, t.cumIndexTime, t.emaPremium, t.rate, b.lastUpdateBlock);
        (FundingState memory ns, int256 prem) = FundingLib.update(
            s, _fundingParams(), index, MarkPriceLib.fairBookPrice(index, bid, ask), block.number - b.lastUpdateBlock
        );
        t.cumFunding = ns.cumFunding;
        t.cumIndexTime = ns.cumIndexTime;
        t.emaPremium = ns.emaPremium;
        t.rate = ns.rate;
        t.premium = prem;
        t.index = index;
        t.mark = MarkPriceLib.markPrice(index, ns.emaPremium, bid, ask, lastPx, lastBlk, block.number);
    }

    function _tryIndex() internal view returns (bool ok, uint256 index) {
        try IOracleAdapter(oracle).tryGetIndexPrice() returns (bool ok_, uint256 p, uint256) {
            if (ok_ && p != 0 && p <= MAX_INDEX) return (true, p);
        } catch {}
        return (false, 0);
    }

    /// @return bid best bid price (0 = none) @return ask best ask price (0 = none) @return lastPx @return lastBlk
    function _book(uint256 ts) internal view returns (uint256 bid, uint256 ask, uint256 lastPx, uint256 lastBlk) {
        address ob = orderBook;
        if (ob == address(0)) return (0, 0, 0, 0);
        bid = uint256(IOrderBook(ob).bestBid()) * ts;
        uint32 askTick = IOrderBook(ob).bestAsk();
        ask = askTick == type(uint32).max ? 0 : uint256(askTick) * ts;
        (lastPx, lastBlk) = IOrderBook(ob).lastTrade();
    }

    /// @dev Settle pending funding into collateral (MATH_SPEC §1.4, owed rounds up). Returns true if `a` changed.
    function _settle(address who, Account memory a, int256 f) internal returns (bool) {
        if (a.lastCumFunding == f) return false;
        int256 owed = FundingLib.owed(a.size, f, a.lastCumFunding);
        a.lastCumFunding = f.toInt128();
        if (owed != 0) {
            a.collateral -= owed;
            emit FundingSettled(who, owed, f);
        }
        return true;
    }

    // ═══ OrderBook hooks (IMarginEngine) ═══════════════════════════════════════

    /// @inheritdoc IMarginEngine
    function reserveOrderMargin(address trader, bool, uint256 sizeWad, uint256 priceWad)
        external
        onlyOrderBook
        nonReentrant
    {
        if (paused) revert Paused();
        Touch memory t = _touchFunding();
        if (t.stale) revert OracleStale();
        Account memory a = _accounts[trader];
        _settle(trader, a, t.cumFunding);
        // MATH_SPEC §3.2: reserve = size·price·imr, rounds up
        uint256 imr = _imr;
        a.reserved = (uint256(a.reserved) + MarginLib.orderMargin(sizeWad, priceWad, imr)).toUint128();
        if (_equity(a, t.mark) < int256(MarginLib.initialMargin(a.size, t.mark, imr, a.reserved))) {
            revert InsufficientMargin();
        }
        _accounts[trader] = a;
        emit OrderMarginChanged(trader, a.reserved);
    }

    /// @inheritdoc IMarginEngine
    /// @dev No funding touch: releasing a reservation reads neither F nor the mark, and funding is lazy (the next
    ///      touch accrues over the whole gap, MATH_SPEC §1.2, so skipping one here changes no account's funding).
    function releaseOrderMargin(address trader, bool, uint256 sizeWad, uint256 priceWad)
        external
        onlyOrderBook
        nonReentrant
    {
        Account storage a = _accounts[trader];
        uint128 r = _released(a.reserved, sizeWad, priceWad);
        a.reserved = r;
        emit OrderMarginChanged(trader, r);
    }

    /// @inheritdoc IMarginEngine
    /// @dev Returns false (no position change) on any margin / cap / stale / pause failure; the book evicts.
    function settleMakerFill(address maker, bool makerIsBid, uint256 sizeWad, uint256 priceWad)
        external
        onlyOrderBook
        nonReentrant
        returns (bool)
    {
        return _makerFill(maker, makerIsBid ? int256(sizeWad) : -int256(sizeWad), priceWad);
    }

    function _makerFill(address maker, int256 dq, uint256 priceWad) internal returns (bool) {
        Touch memory t = _touchFunding();
        Account memory a = _accounts[maker];
        _settle(maker, a, t.cumFunding);
        uint256 notional = MarginLib.notionalOf(FPM.abs(dq), priceWad);
        Account memory b = _copy(a);
        b.reserved = _released(a.reserved, FPM.abs(dq), priceWad);
        uint256 oi0 = _longOI;
        t.oiRef = type(uint256).max; // OI cap: checked on the net result at the taker fill
        if (_execute(maker, a, b, Fill(dq, notional, _makerFee(notional), priceWad, true), t) != bytes4(0)) {
            _accounts[maker] = a; // keep the funding settlement only
            return false;
        }
        if (_oiBeforeOrder == 0) _oiBeforeOrder = oi0 + 1;
        return true;
    }

    /// @dev MATH_SPEC §3.1: maker fee rounds up, a rebate (negative fee) rounds down in magnitude.
    function _makerFee(uint256 notional) internal view returns (int256) {
        int256 mf = _rp.makerFee;
        return mf >= 0 ? int256(FPM.mulWadUp(notional, uint256(mf))) : -int256(FPM.mulWad(notional, uint256(-mf)));
    }

    /// @inheritdoc IMarginEngine
    function settleTakerFill(address taker, bool takerIsBid, uint256 sizeWad, uint256 notionalWad, bool reduceOnly)
        external
        onlyOrderBook
        nonReentrant
    {
        if (sizeWad == 0) revert ZeroAmount();
        _takerFill(taker, takerIsBid ? int256(sizeWad) : -int256(sizeWad), notionalWad, reduceOnly);
    }

    function _takerFill(address taker, int256 dq, uint256 notionalWad, bool reduceOnly) internal {
        Touch memory t = _touchFunding();
        Account memory a = _accounts[taker];
        _settle(taker, a, t.cumFunding);
        if (reduceOnly && _increases(a.size, a.size + dq)) revert ReduceOnlyViolated();
        uint256 before = _oiBeforeOrder;
        _oiBeforeOrder = 0;
        t.oiRef = before != 0 ? before - 1 : _longOI;
        // MATH_SPEC §3.1: taker fee = notional·takerFee, rounds up
        Fill memory f = Fill(
            dq,
            notionalWad,
            int256(FPM.mulWadUp(notionalWad, _rp.takerFee)),
            FPM.fullMulDiv(notionalWad, WAD, FPM.abs(dq)),
            false
        );
        bytes4 err = _execute(taker, a, _copy(a), f, t);
        if (err != bytes4(0)) _revertWith(err);
    }

    /// @dev Apply + check + commit + emit. Returns the failing check's error selector (nothing written) or 0.
    function _execute(address who, Account memory a, Account memory b, Fill memory f, Touch memory t)
        internal
        returns (bytes4 err)
    {
        int256 realized;
        (realized, err) = _applyFill(a, b, f.dq, f.notional, f.fee, t);
        if (err != bytes4(0)) return err;
        _commitFill(who, a.size, b, f.fee);
        emit PositionChanged(who, f.dq, b.size, f.price, realized, f.fee, f.isMaker);
    }

    /// @dev Applies a fill to `b` (a copy of the settled account `a`) and runs every check. Error selector or 0.
    function _applyFill(Account memory a, Account memory b, int256 dq, uint256 notional, int256 fee, Touch memory t)
        internal
        view
        returns (int256 realized, bytes4 err)
    {
        realized = _fillPosition(a, b, dq, notional);
        b.collateral = a.collateral + realized - fee;
        err = _checkFill(a.size, b, t);
    }

    function _fillPosition(Account memory a, Account memory b, int256 dq, uint256 notional)
        internal
        pure
        returns (int256 realized)
    {
        (int256 size, int256 on, int256 r) = MarginLib.applyFill(a.size, a.openNotional, dq, notional);
        b.size = size.toInt128();
        b.openNotional = on.toInt128();
        return r;
    }

    /// @dev Risk-increasing (opens, grows |q| or flips): not paused, oracle fresh, position cap, OI cap, equity ≥ IM.
    ///      Pure reduction: equity ≥ 0 after (a voluntary trade may never create bad debt).
    function _checkFill(int256 oldSize, Account memory b, Touch memory t) internal view returns (bytes4) {
        if (!_increases(oldSize, b.size)) {
            return _equity(b, t.mark) < 0 ? InsufficientMargin.selector : bytes4(0);
        }
        if (paused) return Paused.selector;
        if (t.stale) return OracleStale.selector;
        RiskPacked memory r = _rp;
        if (FPM.abs(b.size) > r.maxPositionSize) return PositionCapExceeded.selector;
        // OI cap on the order's net result: refuse only if OI ends above the cap AND above where the order started
        // (so trades that don't raise OI still work after an admin lowers the cap). longOI == shortOI (I2).
        (uint256 lo, uint256 so) = _oiAfter(oldSize, b.size);
        uint256 oi = FPM.max(lo, so);
        if (oi > r.maxOpenInterest && oi > t.oiRef) return OpenInterestCapExceeded.selector;
        if (_equity(b, t.mark) < int256(MarginLib.initialMargin(b.size, t.mark, r.imr, b.reserved))) {
            return InsufficientMargin.selector;
        }
        return bytes4(0);
    }

    function _commitFill(address who, int256 oldSize, Account memory b, int256 fee) internal {
        _setOI(oldSize, b.size);
        _fees += fee;
        _accounts[who] = b;
    }

    function _revertWith(bytes4 err) internal pure {
        assembly ("memory-safe") {
            mstore(0, err)
            revert(0, 4)
        }
    }

    // ═══ Liquidation ═════════════════════════════════════════════════════════════

    /// @inheritdoc IClearingHouse
    /// @dev MATH_SPEC §3.3. Works while paused or with a stale oracle (at the last good mark).
    ///      Bad debt is resolved when the liquidatee's position is fully closed.
    function liquidate(address account, uint256 maxSizeWad) external nonReentrant returns (int256 moved) {
        if (account == msg.sender) revert InvalidParams();
        if (maxSizeWad == 0) revert ZeroAmount();
        Touch memory t = _touchFunding();
        Account memory v = _accounts[account];
        Account memory k = _accounts[msg.sender];
        _settle(account, v, t.cumFunding);
        _settle(msg.sender, k, t.cumFunding);
        RiskPacked memory r = _rp;
        if (v.size == 0 || _equity(v, t.mark) >= int256(MarginLib.maintenanceMargin(v.size, t.mark, r.mmr))) {
            revert NotLiquidatable();
        }
        uint256 x = FPM.min(maxSizeWad, FPM.abs(v.size));
        moved = v.size > 0 ? int256(x) : -int256(x);
        Liq memory l;
        l.notional = MarginLib.notionalOf(x, t.mark);
        int256 vOld = v.size;
        int256 kOld = k.size;
        // Position x moves to the liquidator at M; the liquidatee realizes its pnl at M.
        l.realizedV = _fillPosition(v, v, -moved, l.notional);
        v.collateral += l.realizedV;
        l.realizedK = _fillPosition(k, k, moved, l.notional);
        k.collateral += l.realizedK;
        // MATH_SPEC §3.3: penalty = min(notional·liqPenalty ↑, max(equity after close, 0)); keeper share ↓
        int256 eqAfter = _equity(v, t.mark);
        l.penalty = FPM.min(FPM.mulWadUp(l.notional, r.liqPenalty), eqAfter > 0 ? uint256(eqAfter) : 0);
        l.keeper = FPM.mulWad(l.penalty, r.keeperShare);
        v.collateral -= int256(l.penalty);
        k.collateral += int256(l.keeper);
        // The liquidator must hold the position within caps and with equity ≥ IM.
        if (_increases(kOld, k.size) && FPM.abs(k.size) > r.maxPositionSize) revert PositionCapExceeded();
        if (_equity(k, t.mark) < int256(MarginLib.initialMargin(k.size, t.mark, r.imr, k.reserved))) {
            revert InsufficientMargin();
        }
        _setOI(vOld, v.size);
        _setOI(kOld, k.size);
        if (v.size == 0 && v.collateral < 0) l.badDebt = uint256(-v.collateral);
        _accounts[account] = v;
        _accounts[msg.sender] = k;
        emit PositionChanged(account, -moved, v.size, t.mark, l.realizedV, 0, false);
        emit PositionChanged(msg.sender, moved, k.size, t.mark, l.realizedK, 0, false);
        _payInsurance(l.penalty - l.keeper);
        if (l.badDebt != 0) _coverBadDebt(account, l.badDebt);
        emit Liquidated(account, msg.sender, moved, t.mark, l.penalty, l.keeper, l.penalty - l.keeper, l.badDebt);
    }

    /// @dev Sends the IF share (WAD→AUSD ↓); the sub-token remainder stays with the protocol as fees.
    function _payInsurance(uint256 wad) internal {
        uint256 amountToken = wad / TO_WAD;
        _fees += int256(wad - amountToken * TO_WAD);
        if (amountToken != 0) IERC20(collateralToken).safeTransfer(insuranceFund, amountToken);
    }

    /// @dev Bad-debt waterfall (MATH_SPEC §3.3, PHASES 36): (1) pull ⌈badDebt⌉ AUSD from the IF, measured by
    ///      balance delta (any sub-token excess goes to fees); (2) what the IF can't cover comes out of accrued
    ///      protocol fees; (3) only the rest stays as negative collateral and is added to totalBadDebt (ADL is
    ///      roadmap). Fees are junior to users, so `collectFees` never pays the protocol out of user collateral.
    ///      `BadDebtSocialized(requested, coveredByInsurance, uncovered)` fires whenever the IF falls short, with
    ///      requested = badDebt (WAD) and coveredByInsurance = the IF part only; the fee part is
    ///      requested − coveredByInsurance − uncovered.
    function _coverBadDebt(address account, uint256 badDebt) internal {
        uint256 requested = FPM.divUp(badDebt, TO_WAD);
        IERC20 token = IERC20(collateralToken);
        uint256 before = token.balanceOf(address(this));
        IInsuranceFund(insuranceFund).coverBadDebt(requested);
        uint256 coveredWad = (token.balanceOf(address(this)) - before) * TO_WAD;
        if (coveredWad >= badDebt) {
            _accounts[account].collateral = 0;
            _fees += int256(coveredWad - badDebt);
            return;
        }
        // MATH_SPEC §3.3, rounds neutral: fromFees = min(badDebt − coveredIF, max(fees, 0)); fees −= fromFees
        uint256 uncovered = badDebt - coveredWad;
        int256 fees = _fees;
        uint256 fromFees = FPM.min(uncovered, fees > 0 ? uint256(fees) : 0);
        _fees = fees - int256(fromFees);
        uncovered -= fromFees;
        _accounts[account].collateral = -int256(uncovered);
        totalBadDebt += uncovered;
        emit BadDebtSocialized(badDebt, coveredWad, uncovered);
    }

    function _setOI(int256 oldSize, int256 newSize) internal {
        (uint256 lo, uint256 so) = _oiAfter(oldSize, newSize);
        (_longOI, _shortOI) = (uint128(lo), uint128(so));
    }

    // ═══ Admin ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IClearingHouse
    function setOrderBook(address orderBook_) external onlyOwner nonReentrant {
        if (orderBook != address(0)) revert AlreadyInitialized();
        if (orderBook_ == address(0)) revert InvalidParams();
        uint256 ts = IOrderBook(orderBook_).tickSize();
        if (ts == 0 || ts > type(uint64).max) revert InvalidParams();
        orderBook = orderBook_;
        _px.tickSize = uint64(ts);
    }

    /// @inheritdoc IClearingHouse
    function setRiskParams(RiskParams calldata params) external onlyOwner {
        _storeRisk(params);
    }

    /// @inheritdoc IClearingHouse
    /// @dev Accrues under the old parameters up to this block first.
    function setFundingParams(FundingParams calldata params) external onlyOwner nonReentrant {
        _touchFunding();
        _storeFunding(params);
    }

    /// @inheritdoc IClearingHouse
    /// @dev Paused = no new risk (reservations, risk-increasing fills). Reductions, cancels, deposits,
    ///      withdrawals, funding and liquidations continue.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @inheritdoc IClearingHouse
    function collectFees(address to) external onlyOwner nonReentrant returns (uint256 amountToken) {
        if (to == address(0)) revert InvalidParams();
        int256 fees = _fees;
        // WAD→AUSD rounds down; the remainder stays accrued
        amountToken = fees > 0 ? uint256(fees) / TO_WAD : 0;
        _fees = fees - int256(amountToken * TO_WAD);
        emit FeesCollected(to, amountToken);
        if (amountToken != 0) IERC20(collateralToken).safeTransfer(to, amountToken);
    }

    function _storeRisk(RiskParams memory p) internal {
        if (
            p.mmr == 0 || p.mmr >= p.imr || p.imr > MAX_IMR || p.takerFee > MAX_TAKER_FEE
                || p.makerFee > int256(p.takerFee) || p.makerFee < -int256(p.takerFee) || p.liqPenalty > p.mmr
                || p.keeperShare > WAD || p.maxPositionSize == 0 || p.maxPositionSize > p.maxOpenInterest
                || p.maxOpenInterest > MAX_CAP_SIZE
        ) revert InvalidParams();
        _rp = RiskPacked(
            uint64(p.imr),
            uint64(p.mmr),
            uint64(p.takerFee),
            int64(p.makerFee),
            uint64(p.liqPenalty),
            uint64(p.keeperShare),
            uint128(p.maxOpenInterest),
            uint128(p.maxPositionSize)
        );
        _imr = uint64(p.imr);
        emit RiskParamsUpdated(p);
    }

    function _storeFunding(FundingParams memory p) internal {
        if (
            p.alpha == 0 || p.alpha > MAX_ALPHA || p.rateCap == 0 || p.rateCap > MAX_RATE_CAP
                || p.interestRate > int256(p.rateCap) || p.interestRate < -int256(p.rateCap)
                || p.maxRateChangePerBlock == 0 || p.maxRateChangePerBlock > p.rateCap
                || p.blockTimeMs < MIN_BLOCK_TIME_MS || p.blockTimeMs > MAX_BLOCK_TIME_MS
                || p.premiumBandWad > MAX_PREMIUM_BAND
        ) revert InvalidParams();
        uint256 absI = FPM.abs(p.interestRate);
        _fp = p.alpha | (p.premiumBandWad << 59) | (p.rateCap << 118) | (p.maxRateChangePerBlock << 160) | (absI << 202)
            | (uint256(p.interestRate < 0 ? 1 : 0) << 244) | (p.blockTimeMs << 245);
        emit FundingParamsUpdated(p);
    }

    // ═══ Views ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IClearingHouse
    function riskParams() external view returns (RiskParams memory) {
        RiskPacked memory r = _rp;
        return RiskParams(
            r.imr, r.mmr, r.takerFee, r.makerFee, r.liqPenalty, r.keeperShare, r.maxOpenInterest, r.maxPositionSize
        );
    }

    /// @inheritdoc IClearingHouse
    function fundingParams() external view returns (FundingParams memory) {
        return _fundingParams();
    }

    function _fundingParams() internal view returns (FundingParams memory) {
        uint256 w = _fp;
        int256 i = int256((w >> 202) & FP_BITS_42);
        return FundingParams(
            w & FP_BITS_59,
            (w >> 244) & 1 == 1 ? -i : i,
            (w >> 118) & FP_BITS_42,
            (w >> 160) & FP_BITS_42,
            w >> 245,
            (w >> 59) & FP_BITS_59
        );
    }

    /// @inheritdoc IClearingHouse
    function fundingState() external view returns (FundingState memory) {
        FundingSlotA memory a = _fa;
        FundingSlotB memory b = _fb;
        return FundingState(a.cumFunding, int256(uint256(a.cumIndexTime)), b.emaPremium, b.rate, b.lastUpdateBlock);
    }

    /// @inheritdoc IClearingHouse
    function previewFundingState() external view returns (FundingState memory) {
        Touch memory t = _preview();
        return FundingState(t.cumFunding, t.cumIndexTime, t.emaPremium, t.rate, t.lastUpdateBlock);
    }

    /// @inheritdoc IClearingHouse
    /// @dev The mark as of the first touch in this block (last good mark while the oracle is stale).
    function markPrice() external view returns (uint256) {
        return _preview().mark;
    }

    /// @inheritdoc IClearingHouse
    /// @dev Live oracle index, or the last good index if the oracle is stale.
    function indexPrice() external view returns (uint256) {
        (bool ok, uint256 index) = _tryIndex();
        return ok ? index : _px.lastIndex;
    }

    /// @inheritdoc IClearingHouse
    function getPosition(address account) external view returns (Position memory) {
        Account memory a = _accounts[account];
        return Position(a.size, a.openNotional, a.lastCumFunding);
    }

    /// @notice Signed collateral (WAD). Negative only while uncovered bad debt sits on the account (MATH_SPEC §7 I1).
    function collateralOf(address account) external view returns (int256) {
        return _accounts[account].collateral;
    }

    /// @inheritdoc IClearingHouse
    function getAccount(address account) external view returns (AccountView memory v) {
        Touch memory t = _preview();
        Account memory a = _accounts[account];
        RiskPacked memory r = _rp;
        v.collateral = a.collateral > 0 ? uint256(a.collateral) : 0;
        v.size = a.size;
        v.entryPrice = MarginLib.entryPrice(a.size, a.openNotional);
        v.unrealizedPnl = MarginLib.unrealizedPnl(a.size, a.openNotional, t.mark);
        v.pendingFunding = FundingLib.owed(a.size, t.cumFunding, a.lastCumFunding);
        v.equity = a.collateral + v.unrealizedPnl - v.pendingFunding;
        v.reservedOrderMargin = a.reserved;
        v.initialMargin = MarginLib.initialMargin(a.size, t.mark, r.imr, a.reserved);
        v.maintenanceMargin = MarginLib.maintenanceMargin(a.size, t.mark, r.mmr);
        v.liquidationPrice = MarginLib.liquidationPrice(a.size, a.openNotional, a.collateral - v.pendingFunding, r.mmr);
        v.liquidatable = a.size != 0 && v.equity < int256(v.maintenanceMargin);
    }

    /// @inheritdoc IClearingHouse
    function isLiquidatable(address account) public view returns (bool) {
        Touch memory t = _preview();
        Account memory a = _accounts[account];
        if (a.size == 0) return false;
        int256 eq = a.collateral + MarginLib.unrealizedPnl(a.size, a.openNotional, t.mark)
            - FundingLib.owed(a.size, t.cumFunding, a.lastCumFunding);
        return eq < int256(MarginLib.maintenanceMargin(a.size, t.mark, _rp.mmr));
    }

    /// @inheritdoc IClearingHouse
    function openInterest() external view returns (uint256 longOI, uint256 shortOI) {
        return (_longOI, _shortOI);
    }

    /// @inheritdoc IClearingHouse
    function accruedFees() external view returns (uint256) {
        int256 f = _fees;
        return f > 0 ? uint256(f) : 0;
    }

    // ─── IFundingRateOracle ───────────────────────────────────────────────────────

    /// @inheritdoc IFundingRateOracle
    function latestObservation() external view returns (int256 cumFunding, int256 cumIndexTime, uint64 blockNumber) {
        Touch memory t = _preview();
        return (t.cumFunding, t.cumIndexTime, uint64(block.number));
    }

    /// @inheritdoc IFundingRateOracle
    /// @dev MATH_SPEC §1.8: O(1) bucket arithmetic when every bucket has a checkpoint, else a binary search
    ///      over the ring (≤ 11 iterations for 1440 slots).
    function observe(uint64 blocksAgo) public view returns (int256, int256, uint64) {
        if (blocksAgo > block.number) revert ObservationTooOld();
        uint256 target = block.number - blocksAgo;
        uint256 idx = _fb.checkpointIdx;
        Checkpoint memory c = _ring[idx];
        if (c.blockNumber <= target) return (c.cumFunding, int256(uint256(c.cumIndexTime)), c.blockNumber);

        uint256 back = c.blockNumber / CKPT_BLOCKS - target / CKPT_BLOCKS;
        if (back != 0 && back < CKPT_SLOTS) {
            Checkpoint memory g = _ring[(idx + CKPT_SLOTS - back) % CKPT_SLOTS];
            if (g.blockNumber != 0 && g.blockNumber <= target) {
                uint64 nextBlock = _ring[(idx + CKPT_SLOTS - back + 1) % CKPT_SLOTS].blockNumber;
                if (nextBlock > target) return (g.cumFunding, int256(uint256(g.cumIndexTime)), g.blockNumber);
            }
        }

        bool wrapped = _ring[(idx + 1) % CKPT_SLOTS].blockNumber != 0;
        uint256 oldest = wrapped ? (idx + 1) % CKPT_SLOTS : 0;
        uint256 count = wrapped ? CKPT_SLOTS : idx + 1;
        if (_ring[oldest].blockNumber > target) revert ObservationTooOld();
        // invariant: ring[lo].block ≤ target < ring[hi].block (hi = newest, checked above)
        uint256 lo;
        uint256 hi = count - 1;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) >> 1;
            if (_ring[(oldest + mid) % CKPT_SLOTS].blockNumber <= target) lo = mid;
            else hi = mid;
        }
        c = _ring[(oldest + lo) % CKPT_SLOTS];
        return (c.cumFunding, int256(uint256(c.cumIndexTime)), c.blockNumber);
    }

    /// @inheritdoc IFundingRateOracle
    /// @dev MATH_SPEC §1.8: ΔF·1e18/ΔG, rounds neutral (toward 0). Current rate if no index-time elapsed.
    function averageFundingRate(uint64 blocksAgo) public view returns (int256) {
        Touch memory t = _preview();
        (int256 f0, int256 g0,) = observe(blocksAgo);
        int256 dG = t.cumIndexTime - g0;
        if (dG == 0) return t.rate;
        return FPM.sDivWad(t.cumFunding - f0, dG);
    }

    /// @inheritdoc IFundingRateOracle
    function averageFundingApr(uint64 blocksAgo) external view returns (int256) {
        return averageFundingRate(blocksAgo) * int256(PulseConstants.SECONDS_PER_YEAR);
    }

    /// @notice Raw checkpoint (for the oracle invariant handler / indexer backfill).
    function checkpointAt(uint256 slot) external view returns (int256, int256, uint64) {
        Checkpoint memory c = _ring[slot];
        return (c.cumFunding, int256(uint256(c.cumIndexTime)), c.blockNumber);
    }

    // ═══ Internal helpers ══════════════════════════════════════════════════════

    function _equity(Account memory a, uint256 mark) internal pure returns (int256) {
        return a.collateral + MarginLib.unrealizedPnl(a.size, a.openNotional, mark);
    }

    function _im(Account memory a, uint256 mark) internal view returns (uint256) {
        return MarginLib.initialMargin(a.size, mark, _rp.imr, a.reserved);
    }

    function _released(uint128 reserved, uint256 sizeWad, uint256 priceWad) internal view returns (uint128) {
        uint256 r = MarginLib.orderMargin(sizeWad, priceWad, _imr);
        return r >= reserved ? 0 : reserved - uint128(r);
    }

    function _copy(Account memory a) internal pure returns (Account memory) {
        return Account(a.collateral, a.size, a.openNotional, a.lastCumFunding, a.reserved);
    }

    /// @dev Risk-increasing: opens, grows |q| or flips side.
    function _increases(int256 oldSize, int256 newSize) internal pure returns (bool) {
        if (newSize == 0) return false;
        if (oldSize == 0 || (oldSize > 0) != (newSize > 0)) return true;
        return FPM.abs(newSize) > FPM.abs(oldSize);
    }

    function _oiAfter(int256 oldSize, int256 newSize) internal view returns (uint256 lo, uint256 so) {
        lo = uint256(_longOI) + FPM.max(newSize, 0).toUint256() - FPM.max(oldSize, 0).toUint256();
        so = uint256(_shortOI) + FPM.max(-newSize, 0).toUint256() - FPM.max(-oldSize, 0).toUint256();
    }
}
