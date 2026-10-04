// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";
import {IFundingSwapMarket} from "../interfaces/IFundingSwapMarket.sol";
import {IMarginEngine} from "../interfaces/IMarginEngine.sol";
import {IClearingHouse} from "../interfaces/IClearingHouse.sol";
import {IFundingRateOracle} from "../interfaces/IFundingRateOracle.sol";
import {IOrderBook} from "../interfaces/IOrderBook.sol";
import {IInsuranceFund} from "../interfaces/IInsuranceFund.sol";
import {PulseConstants, SwapParams, SwapPosition, SwapAccountView} from "../interfaces/PulseTypes.sol";
import {SwapMathLib} from "../libs/SwapMathLib.sol";
import {SwapMarginLib} from "../libs/SwapMarginLib.sol";

/// @title FundingSwapMarket — fixed-for-floating MON-PERP funding swap, one maturity (MATH_SPEC §6)
/// @notice Long = receive floating perp funding, pay a fixed APR. Trades on its own OrderBook where price = 1 + APR.
///         Accrual is O(1) and lazy: every entry point reads the perp's (F, G) once (`latestObservation`) and
///         settles the touched accounts: net = ⌊(q·ΔF·YEAR − K·ΔG)/(1e18·YEAR)⌋ (one division, ↓).
///         Fill rule: settle, then q += Δq and K += kDelta with kDelta computed ONCE per maker fill; the taker
///         receives −Σ kDelta of the order's maker fills (transient accumulator), so Σq = 0 and ΣK = 0 exactly.
///         Maturity: the first touch at or after `maturity` (or `settleMaturity()`) snapshots F and G; accrual
///         stops there, only reducing trades remain, collateral is withdrawable. No loops.
contract FundingSwapMarket is IFundingSwapMarket, Ownable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 internal constant WAD = 1e18;
    int256 internal constant IWAD = 1e18;
    uint256 internal constant YEAR = PulseConstants.SECONDS_PER_YEAR;
    uint256 internal constant TO_WAD = PulseConstants.AUSD_TO_WAD;
    /// @dev markApr is clamped to realizedApr(8 h) ± 50 APR points (MATH_SPEC §6.3).
    int256 public constant MARK_BAND_APR = 0.5e18;
    /// @dev 8 h of 300 ms blocks: the realized-APR window of the mark (MATH_SPEC §6.3).
    uint64 public constant REALIZED_WINDOW_BLOCKS = 96_000;
    /// @dev A swap trade older than 100 blocks (30 s) is not a mark input (MATH_SPEC §6.3).
    uint256 public constant LAST_TRADE_MAX_AGE = 100;
    /// @dev B-01: the mark may move at most 0.5 APR points per block from its per-block anchor (MATH_SPEC §6.3).
    int256 public constant MARK_MAX_STEP_PER_BLOCK = 0.005e18;
    /// @dev B-01: blocks of elapsed time credited to the bound, so one refresh moves the mark ≤ 10 APR points
    ///      (≈ 0.8% of notional at τ = 30 d, below the ≈ 2.6% IM–MM gap).
    uint256 public constant MARK_MAX_ELAPSED_BLOCKS = 20;

    // ─── Hard bounds on admin parameters ───────────────────────────────────────
    uint256 internal constant MIN_LIQ_HORIZON = 1 hours;
    uint256 internal constant MAX_LIQ_HORIZON = 7 days;
    uint256 internal constant MAX_IM_MULTIPLIER = 10e18;
    uint256 internal constant MAX_TAKER_FEE_APR = 0.1e18;
    uint256 internal constant MAX_CAP_SIZE = 1e30;

    struct Account {
        int256 collateral; // WAD; negative only for uncovered bad debt
        int128 size; // q
        int128 k; // K = Σ Δq·A/1e18 (fixed-APR notional)
        int128 lastF; // perp F at the last settlement
        uint128 lastG; // perp G at the last settlement
        uint128 resSize; // Σ size of resting orders
        uint128 resAbsK; // Σ ⌈size·|A|/1e18⌉ of resting orders
    }

    /// @dev One read of the perp per entry point. Deliberately not cached across calls: inside one transaction the
    ///      perp's index or indices can move between our calls (an oracle push or a perp touch in a bundle).
    struct Obs {
        int256 f;
        int256 g;
        uint256 index;
        uint256 tau; // seconds to maturity (0 once matured)
        int256 markApr;
        uint256 capApr; // perp rateCap as APR
    }

    struct Liq {
        int256 moved;
        int256 kShare;
        int256 value;
        uint256 penalty;
        uint256 keeper;
        uint256 badDebt;
    }

    /// @inheritdoc IFundingSwapMarket
    address public immutable perpClearingHouse;
    /// @inheritdoc IFundingSwapMarket
    address public immutable collateralToken;
    /// @inheritdoc IFundingSwapMarket
    address public immutable insuranceFund;
    /// @inheritdoc IFundingSwapMarket
    uint256 public immutable maturity;

    /// @inheritdoc IMarginEngine
    address public orderBook;
    bool public paused;
    bool internal _snapped;
    uint128 internal _longOI;
    uint128 internal _shortOI;
    uint256 internal _tickSize;
    /// @dev WAD; signed because maker rebates settle before the taker fee inside one order.
    int256 internal _fees;
    /// @notice Cumulative uncovered bad debt ("ever socialized"; not reduced when a later deposit repays it).
    uint256 public totalBadDebt;
    int256 internal _fAtMaturity;
    int256 internal _gAtMaturity;
    /// @dev B-01: the mark of the last block that touched this market, and that block (one slot).
    int128 internal _markAnchor;
    uint64 internal _markAnchorBlock;
    SwapParams internal _p;
    mapping(address => Account) internal _accounts;

    /// @dev Σ kDelta of the current order's successful maker fills; the taker takes −Σ (ΣK = 0 exactly).
    int256 transient _kAcc;
    /// @dev longOI + 1 before the order's first maker fill (0 = unset): OI cap checked on the net at the taker.
    uint256 transient _oiBeforeOrder;

    modifier onlyOrderBook() {
        if (msg.sender != orderBook) revert OnlyOrderBook();
        _;
    }

    constructor(
        address perpClearingHouse_,
        address collateralToken_,
        address insuranceFund_,
        uint64 maturity_,
        SwapParams memory params,
        address owner_
    ) Ownable(owner_) {
        if (
            perpClearingHouse_ == address(0) || collateralToken_ == address(0) || insuranceFund_ == address(0)
                || maturity_ <= block.timestamp
        ) revert InvalidParams();
        perpClearingHouse = perpClearingHouse_;
        collateralToken = collateralToken_;
        insuranceFund = insuranceFund_;
        maturity = maturity_;
        _storeParams(params);
    }

    // ═══ Collateral ═════════════════════════════════════════════════════════════

    /// @inheritdoc IFundingSwapMarket
    function deposit(uint256 amountToken) external nonReentrant {
        _deposit(msg.sender, amountToken);
    }

    /// @inheritdoc IFundingSwapMarket
    function depositFor(address account, uint256 amountToken) external nonReentrant {
        if (account == address(0)) revert InvalidParams();
        _deposit(account, amountToken);
    }

    function _deposit(address account, uint256 amountToken) internal {
        if (amountToken == 0) revert ZeroAmount();
        // AUSD→WAD is exact (CLAUDE.md §2)
        uint256 wad = amountToken * TO_WAD;
        _accounts[account].collateral += int256(wad);
        emit Deposited(account, amountToken, wad);
        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), amountToken);
    }

    /// @inheritdoc IFundingSwapMarket
    /// @dev Only collateral leaves (never unrealized value); equity after must cover IM incl. resting orders.
    function withdraw(uint256 amountToken) external nonReentrant {
        if (amountToken == 0) revert ZeroAmount();
        Obs memory o = _touch();
        Account memory a = _accounts[msg.sender];
        _settle(msg.sender, a, o);
        uint256 wad = amountToken * TO_WAD;
        a.collateral -= int256(wad);
        if (a.collateral < 0 || _equity(a, o) < int256(_im(a, o))) revert InsufficientMargin();
        _accounts[msg.sender] = a;
        emit Withdrawn(msg.sender, amountToken, wad);
        IERC20(collateralToken).safeTransfer(msg.sender, amountToken);
    }

    // ═══ Accrual / lifecycle ════════════════════════════════════════════════════

    /// @inheritdoc IFundingSwapMarket
    function settle(address account) external nonReentrant {
        Obs memory o = _touch();
        Account memory a = _accounts[account];
        if (_settle(account, a, o)) _accounts[account] = a;
    }

    /// @inheritdoc IFundingSwapMarket
    function settleMaturity() external nonReentrant {
        if (block.timestamp < maturity) revert NotMatured();
        _touch();
    }

    /// @dev The perp read for this entry point: snapshots F and G at the first touch at/after maturity.
    function _touch() internal returns (Obs memory o) {
        if (!_snapped && block.timestamp >= maturity) {
            (int256 f, int256 g,) = IFundingRateOracle(perpClearingHouse).latestObservation();
            (_fAtMaturity, _gAtMaturity, _snapped) = (f, g, true);
            emit MaturitySettled(f, g, uint64(block.number));
        }
        // B-01: the first touch of a block fixes the bounded mark for the whole block (no same-block movement).
        if (_markAnchorBlock != block.number) {
            (_markAnchor, _markAnchorBlock) = (_boundedMark().toInt128(), uint64(block.number));
        }
        return _observe();
    }

    /// @dev View form of `_touch` (views and previews): the snapshot values once matured.
    function _observe() internal view returns (Obs memory o) {
        IClearingHouse ch = IClearingHouse(perpClearingHouse);
        // Once matured but not yet snapshotted, the live read is exactly what the next touch will snapshot.
        if (_snapped) (o.f, o.g) = (_fAtMaturity, _gAtMaturity);
        else (o.f, o.g,) = IFundingRateOracle(perpClearingHouse).latestObservation();
        o.tau = _tau();
        o.index = ch.indexPrice();
        o.capApr = ch.fundingParams().rateCap * YEAR;
        o.markApr = _markApr();
    }

    function _tau() internal view returns (uint256) {
        return block.timestamp >= maturity ? 0 : maturity - block.timestamp;
    }

    /// @dev Settle accrued net into collateral (MATH_SPEC §6.2). Returns true if `a` changed.
    function _settle(address who, Account memory a, Obs memory o) internal returns (bool) {
        int256 dF = o.f - a.lastF;
        int256 dG = o.g - int256(uint256(a.lastG));
        if (dF == 0 && dG == 0) return false;
        a.lastF = o.f.toInt128();
        a.lastG = uint256(o.g).toUint128();
        if (a.size == 0 && a.k == 0) return true;
        // MATH_SPEC §6.2 (amended), rounds down: one floor division, against the account for either sign
        int256 net = SwapMathLib.net(a.size, a.k, dF, dG);
        a.collateral += net;
        // Legs for the event only (floating truncates toward 0; fixed = floating − net)
        int256 floating = int256(a.size) * dF / IWAD;
        emit SwapAccrualSettled(who, floating, floating - net, net);
        return true;
    }

    // ═══ OrderBook hooks (IMarginEngine) ═══════════════════════════════════════

    /// @inheritdoc IMarginEngine
    /// @dev The reservation is deterministic in the order's params (Σsize, Σ⌈size·|A|⌉) so the release mirrors
    ///      it; its margin is evaluated at check time as a conservative position (every term taken in abs).
    function reserveOrderMargin(address trader, bool, uint256 sizeWad, uint256 priceWad)
        external
        onlyOrderBook
        nonReentrant
    {
        if (paused) revert Paused();
        if (block.timestamp >= maturity) revert Matured();
        Obs memory o = _touch();
        Account memory a = _accounts[trader];
        _settle(trader, a, o);
        a.resSize = (uint256(a.resSize) + sizeWad).toUint128();
        a.resAbsK = (uint256(a.resAbsK) + _absKOf(sizeWad, priceWad)).toUint128();
        if (_equity(a, o) < int256(_im(a, o))) revert InsufficientMargin();
        _accounts[trader] = a;
    }

    /// @inheritdoc IMarginEngine
    /// @dev No perp read: releasing a reservation changes no accrual. Saturates at 0 (per-fill ceil can
    ///      over-release by ≤ 1 wei per fill, same as the perp, PHASES decision 6).
    function releaseOrderMargin(address trader, bool, uint256 sizeWad, uint256 priceWad)
        external
        onlyOrderBook
        nonReentrant
    {
        Account storage a = _accounts[trader];
        (a.resSize, a.resAbsK) = _released(a.resSize, a.resAbsK, sizeWad, priceWad);
    }

    /// @inheritdoc IMarginEngine
    /// @dev Returns false (no position change, the book evicts) on any margin / cap / pause / maturity failure.
    function settleMakerFill(address maker, bool makerIsBid, uint256 sizeWad, uint256 priceWad)
        external
        onlyOrderBook
        nonReentrant
        returns (bool)
    {
        Obs memory o = _touch();
        Account memory a = _accounts[maker];
        _settle(maker, a, o);
        int256 dq = makerIsBid ? int256(sizeWad) : -int256(sizeWad);
        int256 apr = int256(priceWad) - IWAD;
        // MATH_SPEC §6.2 (amended), rounds neutral: computed ONCE per fill, the taker gets exactly −Σ of these
        int256 kd = SwapMathLib.kDelta(dq, apr);
        Account memory b = _copy(a);
        (b.resSize, b.resAbsK) = _released(a.resSize, a.resAbsK, sizeWad, priceWad);
        int256 fee = _fee(sizeWad, o, _p.makerFeeApr);
        uint256 oi0 = _longOI;
        if (!_apply(a, b, dq, kd, fee, o, type(uint256).max)) {
            _accounts[maker] = a; // keep the accrual settlement only
            return false;
        }
        _commit(maker, a.size, b, fee);
        _kAcc += kd;
        if (_oiBeforeOrder == 0) _oiBeforeOrder = oi0 + 1;
        emit SwapPositionChanged(maker, dq, b.size, apr, 0, fee, true);
        return true;
    }

    /// @inheritdoc IMarginEngine
    function settleTakerFill(address taker, bool takerIsBid, uint256 sizeWad, uint256 notionalWad, bool reduceOnly)
        external
        onlyOrderBook
        nonReentrant
    {
        if (sizeWad == 0) revert ZeroAmount();
        int256 dq = takerIsBid ? int256(sizeWad) : -int256(sizeWad);
        (int256 newSize, int256 fee) = _takerFill(taker, dq, sizeWad, reduceOnly);
        // average fill APR for the event: (notional − size)/size, rounds neutral
        emit SwapPositionChanged(
            taker, dq, newSize, (int256(notionalWad) - int256(sizeWad)) * IWAD / int256(sizeWad), 0, fee, false
        );
    }

    function _takerFill(address taker, int256 dq, uint256 sizeWad, bool reduceOnly)
        internal
        returns (int256 newSize, int256 fee)
    {
        Obs memory o = _touch();
        Account memory a = _accounts[taker];
        _settle(taker, a, o);
        if (reduceOnly && _increases(a.size, a.size + dq)) revert ReduceOnlyViolated();
        int256 kd = -_kAcc; // exactly −Σ of this order's maker kDeltas ⇒ ΣK = 0
        _kAcc = 0;
        uint256 before = _oiBeforeOrder;
        _oiBeforeOrder = 0;
        fee = _fee(sizeWad, o, int256(_p.takerFeeApr));
        Account memory b = _copy(a);
        bytes4 err = _check(a, b, dq, kd, fee, o, before != 0 ? before - 1 : _longOI);
        if (err != bytes4(0)) _revertWith(err);
        _commit(taker, a.size, b, fee);
        newSize = b.size;
    }

    /// @dev Applies the fill to `b` and runs the checks. False (nothing written) on failure.
    function _apply(Account memory a, Account memory b, int256 dq, int256 kd, int256 fee, Obs memory o, uint256 oiRef)
        internal
        view
        returns (bool)
    {
        return _check(a, b, dq, kd, fee, o, oiRef) == bytes4(0);
    }

    /// @dev Risk-increasing (|q| grows or flips): not matured, not paused, position cap, OI cap on the order's net
    ///      result, equity ≥ IM. Pure reduction: equity ≥ 0 after (a voluntary trade may never create bad debt) and,
    ///      B-02, the maintenance slack (equity − MM, the `isLiquidatable` measure) is not created negative or made
    ///      worse: an off-market close that grows |K| can't leave the account liquidatable at the IF's risk.
    function _check(Account memory a, Account memory b, int256 dq, int256 kd, int256 fee, Obs memory o, uint256 oiRef)
        internal
        view
        returns (bytes4)
    {
        (int256 q, int256 k) = SwapMathLib.applyFill(a.size, a.k, dq, kd);
        b.size = q.toInt128();
        b.k = k.toInt128();
        b.collateral = a.collateral - fee;
        if (!_increases(a.size, q)) {
            int256 eqAfter = _equity(b, o);
            if (eqAfter < 0) return InsufficientMargin.selector;
            // MATH_SPEC §6.4 (B-02), MM rounds up as in `_mm`, so the slack rounds down (against the account)
            int256 slackAfter = eqAfter - int256(_mm(q, k, o));
            if (slackAfter >= 0) return bytes4(0);
            int256 slackBefore = _equity(a, o) - int256(_mm(a.size, a.k, o));
            return slackAfter >= slackBefore ? bytes4(0) : InsufficientMargin.selector;
        }
        if (_snapped || block.timestamp >= maturity) return Matured.selector;
        if (paused) return Paused.selector;
        SwapParams memory p = _p;
        if (FPM.abs(q) > p.maxPositionSize) return PositionCapExceeded.selector;
        (uint256 lo, uint256 so) = _oiAfter(a.size, q);
        uint256 oi = FPM.max(lo, so);
        if (oi > p.maxOpenInterest && oi > oiRef) return OpenInterestCapExceeded.selector;
        if (_equity(b, o) < int256(_im(b, o))) return InsufficientMargin.selector;
        return bytes4(0);
    }

    function _commit(address who, int256 oldSize, Account memory b, int256 fee) internal {
        (uint256 lo, uint256 so) = _oiAfter(oldSize, b.size);
        (_longOI, _shortOI) = (uint128(lo), uint128(so));
        _fees += fee;
        _accounts[who] = b;
    }

    // ═══ Liquidation ═════════════════════════════════════════════════════════════

    /// @inheritdoc IFundingSwapMarket
    /// @dev MATH_SPEC §6.4. The liquidator takes x and K·x/|q| (all of K for a q = 0 locked stream), pays the
    ///      liquidatee the slice's value V_x at markApr (equal and opposite), then penalty = liqPenalty·MM_x ↑
    ///      capped by the liquidatee's equity: keeperShare ↓ to the liquidator, the rest to the IF. Bad debt of a
    ///      fully closed account goes to the IF; uncovered stays as negative collateral.
    function liquidate(address account, uint256 maxSizeWad) external nonReentrant returns (int256 sizeTransferred) {
        if (account == msg.sender) revert InvalidParams();
        if (maxSizeWad == 0) revert ZeroAmount();
        Obs memory o = _touch();
        Account memory v = _accounts[account];
        Account memory k = _accounts[msg.sender];
        _settle(account, v, o);
        _settle(msg.sender, k, o);
        uint256 mm = _mm(v.size, v.k, o);
        if (mm == 0 || _equity(v, o) >= int256(mm)) revert NotLiquidatable();
        Liq memory l;
        if (v.size != 0) {
            uint256 x = FPM.min(maxSizeWad, FPM.abs(v.size));
            l.moved = v.size > 0 ? int256(x) : -int256(x);
            l.kShare = SwapMathLib.liquidationShare(v.size, v.k, int256(x));
        } else {
            l.kShare = v.k;
        }
        // MATH_SPEC §6.3/§6.4: V_x of the slice at markApr, rounds down; equal and opposite transfer
        l.value = SwapMathLib.value(l.moved, l.kShare, o.markApr, o.index, o.tau);
        int256 vOld = v.size;
        int256 kOld = k.size;
        v.size = (int256(v.size) - l.moved).toInt128();
        v.k = (int256(v.k) - l.kShare).toInt128();
        v.collateral += l.value;
        k.size = (int256(k.size) + l.moved).toInt128();
        k.k = (int256(k.k) + l.kShare).toInt128();
        k.collateral -= l.value;
        // MATH_SPEC §6.4: penalty = liqPenalty·MM_x ↑, capped by the equity left; keeper share ↓
        int256 eqAfter = _equity(v, o);
        l.penalty = FPM.min(FPM.mulWadUp(_mm(l.moved, l.kShare, o), _p.liqPenalty), eqAfter > 0 ? uint256(eqAfter) : 0);
        l.keeper = FPM.mulWad(l.penalty, _p.keeperShare);
        v.collateral -= int256(l.penalty);
        k.collateral += int256(l.keeper);
        if (_increases(kOld, k.size) && FPM.abs(k.size) > _p.maxPositionSize) revert PositionCapExceeded();
        if (_equity(k, o) < int256(_im(k, o))) revert InsufficientMargin();
        (uint256 lo, uint256 so) = _oiAfter(vOld, v.size);
        (_longOI, _shortOI) = (uint128(lo), uint128(so));
        (lo, so) = _oiAfter(kOld, k.size);
        (_longOI, _shortOI) = (uint128(lo), uint128(so));
        if (v.size == 0 && v.k == 0 && v.collateral < 0) l.badDebt = uint256(-v.collateral);
        _accounts[account] = v;
        _accounts[msg.sender] = k;
        emit SwapPositionChanged(account, -l.moved, v.size, o.markApr, 0, 0, false);
        emit SwapPositionChanged(msg.sender, l.moved, k.size, o.markApr, 0, 0, false);
        _payInsurance(l.penalty - l.keeper);
        if (l.badDebt != 0) _coverBadDebt(account, l.badDebt);
        emit SwapLiquidated(
            account, msg.sender, l.moved, o.markApr, l.penalty, l.keeper, l.penalty - l.keeper, l.badDebt
        );
        return l.moved;
    }

    /// @dev Sends the IF share (WAD→AUSD ↓); the sub-token remainder stays as fees.
    function _payInsurance(uint256 wad) internal {
        uint256 amountToken = wad / TO_WAD;
        _fees += int256(wad - amountToken * TO_WAD);
        if (amountToken != 0) IERC20(collateralToken).safeTransfer(insuranceFund, amountToken);
    }

    /// @dev Same as the perp: pull ⌈badDebt⌉ from the IF, measured by balance delta; uncovered stays negative.
    function _coverBadDebt(address account, uint256 badDebt) internal {
        uint256 requested = FPM.divUp(badDebt, TO_WAD);
        IERC20 token = IERC20(collateralToken);
        uint256 before = token.balanceOf(address(this));
        IInsuranceFund(insuranceFund).coverBadDebt(requested);
        uint256 coveredWad = (token.balanceOf(address(this)) - before) * TO_WAD;
        if (coveredWad >= badDebt) {
            _accounts[account].collateral = 0;
            _fees += int256(coveredWad - badDebt);
        } else {
            uint256 uncovered = badDebt - coveredWad;
            _accounts[account].collateral = -int256(uncovered);
            totalBadDebt += uncovered;
        }
    }

    // ═══ Admin ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IFundingSwapMarket
    function setOrderBook(address orderBook_) external onlyOwner {
        if (orderBook != address(0)) revert AlreadyInitialized();
        if (orderBook_ == address(0)) revert InvalidParams();
        orderBook = orderBook_;
        _tickSize = IOrderBook(orderBook_).tickSize();
    }

    /// @inheritdoc IFundingSwapMarket
    function setSwapParams(SwapParams calldata params) external onlyOwner {
        _storeParams(params);
    }

    /// @inheritdoc IFundingSwapMarket
    /// @dev Paused = no new risk (reservations, increasing fills). Reductions, cancels, deposits, withdrawals,
    ///      accrual and liquidations continue.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
    }

    /// @inheritdoc IFundingSwapMarket
    function collectFees(address to) external onlyOwner nonReentrant returns (uint256 amountToken) {
        if (to == address(0)) revert InvalidParams();
        int256 fees = _fees;
        // WAD→AUSD rounds down; the remainder stays accrued
        amountToken = fees > 0 ? uint256(fees) / TO_WAD : 0;
        _fees = fees - int256(amountToken * TO_WAD);
        if (amountToken != 0) IERC20(collateralToken).safeTransfer(to, amountToken);
    }

    function _storeParams(SwapParams memory p) internal {
        if (
            p.aprMoveBuffer > WAD || p.liqHorizonSec < MIN_LIQ_HORIZON || p.liqHorizonSec > MAX_LIQ_HORIZON
                || p.imMultiplier < WAD || p.imMultiplier > MAX_IM_MULTIPLIER || p.takerFeeApr > MAX_TAKER_FEE_APR
                || p.makerFeeApr > int256(p.takerFeeApr) || p.makerFeeApr < -int256(p.takerFeeApr) || p.liqPenalty > WAD
                || p.keeperShare > WAD || p.maxPositionSize == 0 || p.maxPositionSize > p.maxOpenInterest
                || p.maxOpenInterest > MAX_CAP_SIZE
        ) revert InvalidParams();
        _p = p;
        emit SwapParamsUpdated(p);
    }

    // ═══ Views ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IFundingSwapMarket
    function isMatured() public view returns (bool) {
        return block.timestamp >= maturity;
    }

    /// @inheritdoc IFundingSwapMarket
    function swapParams() external view returns (SwapParams memory) {
        return _p;
    }

    /// @inheritdoc IFundingSwapMarket
    /// @dev MATH_SPEC §6.3: median(book mid APR, last trade APR if ≤ 100 blocks old, realizedApr(8 h)), each
    ///      missing input replaced by the realized APR, then clamped to realized ± 50 APR points.
    function markApr() external view returns (int256) {
        return _markApr();
    }

    /// @dev B-01: the mark every margin, liquidation and view decision uses. The first touch of a block stores it
    ///      (`_markAnchor`) and it stays fixed for that block, so book or trade moves made after it in the same
    ///      transaction or block change nothing. Across blocks it follows the live mark by at most
    ///      MARK_MAX_STEP_PER_BLOCK per elapsed block (capped at MARK_MAX_ELAPSED_BLOCKS), so even a manipulation
    ///      that lands before the first touch moves it ≤ 10 APR points per refresh and the MM can re-quote.
    ///      MATH_SPEC §6.3 (per-block bound added to the band), rounds neutral.
    function _markApr() internal view returns (int256) {
        if (_markAnchorBlock == block.number) return _markAnchor;
        return _boundedMark();
    }

    function _boundedMark() internal view returns (int256) {
        int256 live = _liveMarkApr();
        uint256 ab = _markAnchorBlock;
        if (ab == 0) return live; // first ever touch: nothing to bound against
        uint256 elapsed = FPM.min(block.number - ab, MARK_MAX_ELAPSED_BLOCKS);
        // MATH_SPEC §6.3, rounds neutral
        int256 band = int256(elapsed) * MARK_MAX_STEP_PER_BLOCK;
        int256 anchor = _markAnchor;
        return FPM.clamp(live, anchor - band, anchor + band);
    }

    function _liveMarkApr() internal view returns (int256) {
        int256 a = _realized8h();
        int256 b = a;
        int256 c = a;
        address ob = orderBook;
        if (ob != address(0)) {
            uint256 ts = _tickSize;
            uint32 bid = IOrderBook(ob).bestBid();
            uint32 ask = IOrderBook(ob).bestAsk();
            if (bid != 0 && ask != type(uint32).max && bid < ask) {
                // MATH_SPEC §6.3, rounds down (same as the book's mid)
                b = int256((uint256(bid) + uint256(ask)) * ts / 2) - IWAD;
            }
            (uint256 px, uint64 blk) = IOrderBook(ob).lastTrade();
            // B-01: a trade printed in this very block is not an input (it can be a same-block self-trade)
            if (px != 0 && blk < block.number && block.number - blk <= LAST_TRADE_MAX_AGE) c = int256(px) - IWAD;
        }
        int256 m = _median(a, b, c);
        return FPM.clamp(m, a - MARK_BAND_APR, a + MARK_BAND_APR);
    }

    /// @dev realizedApr over 8 h; before the perp's oracle holds 8 h of history, its current rate as an APR.
    function _realized8h() internal view returns (int256) {
        try IFundingRateOracle(perpClearingHouse).averageFundingApr(REALIZED_WINDOW_BLOCKS) returns (int256 apr) {
            return apr;
        } catch {
            return IClearingHouse(perpClearingHouse).fundingState().rate * int256(YEAR);
        }
    }

    /// @inheritdoc IFundingSwapMarket
    function realizedApr(uint64 blocksAgo) external view returns (int256) {
        return IFundingRateOracle(perpClearingHouse).averageFundingApr(blocksAgo);
    }

    /// @inheritdoc IFundingSwapMarket
    function timeToMaturity() external view returns (uint256) {
        return _tau();
    }

    /// @inheritdoc IFundingSwapMarket
    function getPosition(address account) external view returns (SwapPosition memory) {
        Account memory a = _accounts[account];
        return SwapPosition(a.size, a.k, a.lastF, int256(uint256(a.lastG)));
    }

    /// @notice Signed collateral (WAD); negative only while uncovered bad debt sits on the account.
    function collateralOf(address account) external view returns (int256) {
        return _accounts[account].collateral;
    }

    /// @inheritdoc IFundingSwapMarket
    function getAccount(address account) external view returns (SwapAccountView memory v) {
        Obs memory o = _observe();
        Account memory a = _accounts[account];
        int256 c0 = a.collateral;
        _previewSettle(a, o);
        v.collateral = c0 > 0 ? uint256(c0) : 0;
        v.size = a.size;
        v.avgFixedApr = a.size == 0 ? int256(0) : int256(a.k) * IWAD / a.size;
        v.accruedNet = a.collateral - c0;
        v.unrealizedPnl = SwapMathLib.value(a.size, a.k, o.markApr, o.index, o.tau);
        v.equity = a.collateral + v.unrealizedPnl;
        v.maintenanceMargin = _mm(a.size, a.k, o);
        v.initialMargin = _im(a, o);
        v.reservedOrderMargin = SwapMarginLib.initialMargin(_ordersMm(a, o), _p.imMultiplier);
        v.liquidatable = v.maintenanceMargin != 0 && v.equity < int256(v.maintenanceMargin);
    }

    /// @inheritdoc IFundingSwapMarket
    function isLiquidatable(address account) external view returns (bool) {
        Obs memory o = _observe();
        Account memory a = _accounts[account];
        _previewSettle(a, o);
        uint256 mm = _mm(a.size, a.k, o);
        return mm != 0 && _equity(a, o) < int256(mm);
    }

    /// @inheritdoc IFundingSwapMarket
    function openInterest() external view returns (uint256 longOI, uint256 shortOI) {
        return (_longOI, _shortOI);
    }

    /// @notice Protocol fees accrued (WAD), net of maker rebates.
    function accruedFees() external view returns (uint256) {
        int256 f = _fees;
        return f > 0 ? uint256(f) : 0;
    }

    /// @notice F and G at maturity (0, 0 until snapshotted).
    function maturitySnapshot() external view returns (bool snapped, int256 cumFunding, int256 cumIndexTime) {
        return (_snapped, _fAtMaturity, _gAtMaturity);
    }

    // ═══ Internal helpers ══════════════════════════════════════════════════════

    function _previewSettle(Account memory a, Obs memory o) internal pure {
        if (a.size == 0 && a.k == 0) return;
        a.collateral += SwapMathLib.net(a.size, a.k, o.f - a.lastF, o.g - int256(uint256(a.lastG)));
    }

    /// @dev MATH_SPEC §6.3: equity = collateral (settled) + V.
    function _equity(Account memory a, Obs memory o) internal pure returns (int256) {
        return a.collateral + SwapMathLib.value(a.size, a.k, o.markApr, o.index, o.tau);
    }

    /// @dev MATH_SPEC §6.4, rounds up. Worst-case horizon = min(liqHorizon, τ): nothing accrues after maturity.
    ///      q = 0 (locked spread): the price-shock term only, and 0 if the stream is not negative (V ≥ 0).
    function _mm(int256 q, int256 k, Obs memory o) internal view returns (uint256) {
        if (o.tau == 0) return 0;
        if (q == 0) {
            if (k <= 0) return 0; // K ≤ 0 ⇒ V = −K·I·τ/YEAR ≥ 0: never liquidated
            return SwapMarginLib.priceShockMargin(0, k, 0, o.index, o.tau);
        }
        return SwapMarginLib.maintenanceMargin(
            q, k, o.markApr, o.index, o.capApr, FPM.min(_p.liqHorizonSec, o.tau), _p.aprMoveBuffer, o.tau
        );
    }

    /// @dev Resting orders as a conservative position: |q| = Σsize, |K| = Σ|size·A|, price shock on
    ///      Σsize·|markApr| + Σ|K| (all terms in abs, so it bounds any fill of them).
    function _ordersMm(Account memory a, Obs memory o) internal view returns (uint256) {
        if (a.resSize == 0 || o.tau == 0) return 0;
        int256 markAbs = o.markApr < 0 ? -o.markApr : o.markApr;
        return SwapMarginLib.maintenanceMargin(
            int256(uint256(a.resSize)),
            -int256(uint256(a.resAbsK)),
            markAbs,
            o.index,
            o.capApr,
            FPM.min(_p.liqHorizonSec, o.tau),
            _p.aprMoveBuffer,
            o.tau
        );
    }

    /// @dev IM = (MM(position) + MM(orders))·imMultiplier ↑.
    function _im(Account memory a, Obs memory o) internal view returns (uint256) {
        return SwapMarginLib.initialMargin(_mm(a.size, a.k, o) + _ordersMm(a, o), _p.imMultiplier);
    }

    /// @dev MATH_SPEC §6.5: fee = |Δq|·I·feeApr·τ/YEAR; a fee rounds up, a rebate (negative) rounds down.
    function _fee(uint256 sizeWad, Obs memory o, int256 feeApr) internal pure returns (int256) {
        if (feeApr >= 0) {
            return int256(FPM.mulDivUp(FPM.mulWadUp(FPM.mulWadUp(sizeWad, o.index), uint256(feeApr)), o.tau, YEAR));
        }
        return -int256(FPM.mulDiv(FPM.mulWad(FPM.mulWad(sizeWad, o.index), uint256(-feeApr)), o.tau, YEAR));
    }

    /// @dev ⌈size·|A|/1e18⌉ for an order at price p = 1 + A.
    function _absKOf(uint256 sizeWad, uint256 priceWad) internal pure returns (uint256) {
        uint256 absApr = priceWad >= WAD ? priceWad - WAD : WAD - priceWad;
        return FPM.mulWadUp(sizeWad, absApr);
    }

    function _released(uint128 resSize, uint128 resAbsK, uint256 sizeWad, uint256 priceWad)
        internal
        pure
        returns (uint128, uint128)
    {
        uint256 dk = _absKOf(sizeWad, priceWad);
        return (sizeWad >= resSize ? 0 : resSize - uint128(sizeWad), dk >= resAbsK ? 0 : resAbsK - uint128(dk));
    }

    function _copy(Account memory a) internal pure returns (Account memory) {
        return Account(a.collateral, a.size, a.k, a.lastF, a.lastG, a.resSize, a.resAbsK);
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

    function _median(int256 a, int256 b, int256 c) internal pure returns (int256) {
        return FPM.max(FPM.min(a, b), FPM.min(FPM.max(a, b), c));
    }

    function _revertWith(bytes4 err) internal pure {
        assembly ("memory-safe") {
            mstore(0, err)
            revert(0, 4)
        }
    }
}
