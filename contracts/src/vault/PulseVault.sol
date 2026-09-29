// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";
import {IPulseVault} from "../interfaces/IPulseVault.sol";
import {IClearingHouse} from "../interfaces/IClearingHouse.sol";
import {IOrderBook} from "../interfaces/IOrderBook.sol";
import {IKuruHedger} from "../interfaces/IKuruHedger.sol";
import {PulseConstants, VaultParams, HedgeState, Position, AccountView} from "../interfaces/PulseTypes.sol";

/// @title PulseVault — "skew absorber" basis vault, ERC-4626 over AUSD (MATH_SPEC §5)
/// @notice Deposits stay idle; a keeper deploys them in slices into spot MON (IKuruHedger) + a short MON-PERP of the
///         same base size, L = leverage. The short never exceeds `shortCapacity()` = skewCapacity·(other longs −
///         other shorts)⁺, and the hedge is entered only when the oracle's 8 h funding pays for the round trip
///         (r̄·entryHorizon > 2c) and exited only when it is expected to cost (r̄·exitHorizon < −c): hysteresis.
///         NAV values both legs at the ORACLE INDEX (§5.4), so trading on Kuru or Pulse cannot move it.
///         Every keeper slice moves ≤ maxSliceAssets through the spot leg, with the spot minOut and the perp limit
///         tick computed from the index ± maxSlippage (never from the keeper).
///         Withdrawals: served from idle; otherwise a bounded pro-rata unwind (one perp buy-back, one spot sell, one
///         CH withdraw). The withdrawer bears the unwind's cost (measured as the NAV change) plus a 5 bps fee that
///         stays with the remaining holders, so neither can dilute them (I8). ERC-4626 previews assume no unwind.
contract PulseVault is IPulseVault, ERC4626, Ownable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using Math for uint256;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant TO_WAD = PulseConstants.AUSD_TO_WAD;
    /// @notice Withdrawal fee (MATH_SPEC §5.3: 5 bps, to the remaining holders). No VaultParams field: constant.
    uint256 public constant WITHDRAW_FEE = 0.0005e18;
    /// @notice Window of the entry/exit funding test: 8 h of 300 ms blocks (MATH_SPEC §5.3).
    uint64 public constant FUNDING_WINDOW_BLOCKS = 96_000;
    /// @dev Unwind for a withdrawal asks for 2% more than missing (slippage + rounding headroom).
    uint256 internal constant UNWIND_HEADROOM = 1.02e18;

    /// @inheritdoc IPulseVault
    address public immutable clearingHouse;
    /// @inheritdoc IPulseVault
    address public immutable orderBook;
    /// @inheritdoc IPulseVault
    address public immutable hedger;
    address internal immutable _wmon;
    uint256 internal immutable _lot;
    uint256 internal immutable _tick;

    VaultParams internal _p;
    mapping(address => bool) public isKeeper;
    /// @notice Registered liquidity providers (our MM bots) whose perp inventory carries the long skew the vault
    ///         replaces; bounded by PulseConstants.MAX_BATCH (MATH_SPEC §5.2 amendment, PHASES decision 11).
    address[] public skewProviders;
    /// @dev Hysteresis state: set when the hedge is entered, cleared when an exit starts.
    bool internal _entered;
    uint64 internal _lastRebalanceBlock;

    struct Nav {
        uint256 idle; // AUSD token units
        uint256 spot; // WMON base WAD
        uint256 index; // WAD
        int256 size; // perp size (≤ 0)
        int256 perpEquity; // at the index: collateral + size·I − ON − pending (quote WAD)
        int256 pending; // unsettled funding owed by the vault (quote WAD)
        uint256 nav; // AUSD token units
    }

    modifier onlyKeeper() {
        if (!isKeeper[msg.sender]) revert OnlyKeeper();
        _;
    }

    constructor(
        IERC20 asset_,
        address clearingHouse_,
        address orderBook_,
        address hedger_,
        VaultParams memory p,
        address owner_
    ) ERC20("Pulse Basis Vault AUSD", "pbAUSD") ERC4626(asset_) Ownable(owner_) {
        if (
            clearingHouse_ == address(0) || orderBook_ == address(0) || hedger_ == address(0)
                || IClearingHouse(clearingHouse_).collateralToken() != address(asset_)
                || IClearingHouse(clearingHouse_).orderBook() != orderBook_
                || IKuruHedger(hedger_).quoteToken() != address(asset_)
        ) revert InvalidParams();
        clearingHouse = clearingHouse_;
        orderBook = orderBook_;
        hedger = hedger_;
        _wmon = IKuruHedger(hedger_).baseToken();
        _lot = IOrderBook(orderBook_).lotSize();
        _tick = IOrderBook(orderBook_).tickSize();
        _storeParams(p);
    }

    // ═══ ERC-4626 ════════════════════════════════════════════════════════════════

    /// @dev Shares have 18 decimals over a 6-dp asset: offset 12 = virtual-share inflation guard (MATH_SPEC §5.4).
    function _decimalsOffset() internal pure override returns (uint8) {
        return 12;
    }

    /// @notice NAV at the oracle index (MATH_SPEC §5.4), AUSD token units, rounds down.
    function totalAssets() public view override(ERC4626, IERC4626) returns (uint256) {
        return _nav().nav;
    }

    function maxDeposit(address) public view override(ERC4626, IERC4626) returns (uint256) {
        uint256 ta = totalAssets();
        return ta >= _p.depositCap ? 0 : _p.depositCap - ta;
    }

    function maxMint(address receiver) public view override(ERC4626, IERC4626) returns (uint256) {
        return convertToShares(maxDeposit(receiver));
    }

    /// @dev assets out after the 5 bps fee (the fee stays in the vault), rounds down.
    function previewRedeem(uint256 shares) public view override(ERC4626, IERC4626) returns (uint256) {
        uint256 assets = super.previewRedeem(shares);
        return assets - assets.mulDiv(WITHDRAW_FEE, WAD, Math.Rounding.Ceil);
    }

    /// @dev shares for `assets` out plus the fee on them, rounds up.
    function previewWithdraw(uint256 assets) public view override(ERC4626, IERC4626) returns (uint256) {
        uint256 gross = assets.mulDiv(WAD, WAD - WITHDRAW_FEE, Math.Rounding.Ceil);
        return super.previewWithdraw(gross);
    }

    function maxWithdraw(address owner_) public view override(ERC4626, IERC4626) returns (uint256) {
        return previewRedeem(balanceOf(owner_));
    }

    function deposit(uint256 assets, address receiver)
        public
        override(ERC4626, IERC4626)
        nonReentrant
        returns (uint256 shares)
    {
        if (assets > maxDeposit(receiver)) revert DepositCapExceeded();
        shares = super.deposit(assets, receiver);
        _snapshot();
    }

    function mint(uint256 shares, address receiver)
        public
        override(ERC4626, IERC4626)
        nonReentrant
        returns (uint256 assets)
    {
        if (shares > maxMint(receiver)) revert DepositCapExceeded();
        assets = super.mint(shares, receiver);
        _snapshot();
    }

    /// @dev Burns previewWithdraw(assets) + the shares worth the unwind's NAV cost at the pre-unwind price.
    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override(ERC4626, IERC4626)
        nonReentrant
        returns (uint256 shares)
    {
        uint256 ta0 = totalAssets();
        uint256 ts0 = totalSupply();
        shares = previewWithdraw(assets);
        uint256 cost = _ensureIdle(assets);
        // MATH_SPEC §5.4: shares burned round up (the withdrawer pays the unwind)
        if (cost != 0) shares += cost.mulDiv(ts0 + 10 ** _decimalsOffset(), ta0 + 1, Math.Rounding.Ceil);
        if (shares > balanceOf(owner_)) revert ERC4626ExceededMaxWithdraw(owner_, assets, maxWithdraw(owner_));
        _withdraw(_msgSender(), receiver, owner_, assets, shares);
        _snapshot();
    }

    /// @dev Pays previewRedeem(shares) minus the unwind's NAV cost (rounds down).
    function redeem(uint256 shares, address receiver, address owner_)
        public
        override(ERC4626, IERC4626)
        nonReentrant
        returns (uint256 assets)
    {
        uint256 maxShares = maxRedeem(owner_);
        if (shares > maxShares) revert ERC4626ExceededMaxRedeem(owner_, shares, maxShares);
        assets = previewRedeem(shares);
        uint256 cost = _ensureIdle(assets);
        assets = assets > cost ? assets - cost : 0;
        _withdraw(_msgSender(), receiver, owner_, assets, shares);
        _snapshot();
    }

    /// @dev Make `assets` idle, unwinding a pro-rata slice of both legs if needed. Returns the NAV lost doing it.
    function _ensureIdle(uint256 assets) internal returns (uint256 cost) {
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (idle >= assets) return 0;
        Nav memory n = _nav();
        // spot + perp equity (token units); 0 if the perp leg is under water (nav < idle) ⇒ unwind everything
        uint256 hedgedValue = n.nav > n.idle ? n.nav - n.idle : 0;
        uint256 missing = (assets - idle).mulDiv(UNWIND_HEADROOM, WAD, Math.Rounding.Ceil);
        uint256 f = hedgedValue == 0 ? WAD : FPM.min(WAD, missing.mulDiv(WAD, hedgedValue, Math.Rounding.Ceil));
        _unwind(n, f, "", true);
        uint256 navAfter = totalAssets();
        cost = n.nav > navAfter ? n.nav - navAfter : 0;
        if (IERC20(asset()).balanceOf(address(this)) < assets - FPM.min(assets, cost)) revert SlippageExceeded();
    }

    // ═══ Keeper ═════════════════════════════════════════════════════════════════

    /// @inheritdoc IPulseVault
    function rebalance() external onlyKeeper nonReentrant returns (RebalanceReason reason) {
        return _rebalance("");
    }

    /// @inheritdoc IPulseVault
    function rebalanceWithRoute(bytes calldata spotRoute) external onlyKeeper nonReentrant returns (RebalanceReason) {
        return _rebalance(spotRoute);
    }

    /// @inheritdoc IPulseVault
    /// @dev Forced exit (keeper): clears the entered state and unwinds one slice; `rebalance` continues it.
    function exitHedge() external onlyKeeper nonReentrant {
        Nav memory n = _nav();
        _entered = false;
        _exitSlice(n, "");
        _afterRebalance(RebalanceReason.ExitHedge, n);
    }

    /// @inheritdoc IPulseVault
    /// @dev Forced entry (keeper): sets the entered state and deploys one slice within the skew capacity.
    function enterHedge() external onlyKeeper nonReentrant {
        Nav memory n = _nav();
        _entered = true;
        emit HedgeEntered(n.nav);
        _deploySlice(n, "");
        _afterRebalance(RebalanceReason.EnterHedge, n);
    }

    function _rebalance(bytes memory route) internal returns (RebalanceReason reason) {
        Nav memory n = _nav();
        reason = _needs(n);
        if (reason == RebalanceReason.None) revert NothingToDo();
        if (reason == RebalanceReason.EnterHedge) {
            _entered = true;
            emit HedgeEntered(n.nav);
            _deploySlice(n, route);
        } else if (reason == RebalanceReason.Deploy) {
            _deploySlice(n, route);
        } else if (reason == RebalanceReason.ExitHedge) {
            _entered = false;
            _exitSlice(n, route);
        } else if (reason == RebalanceReason.MarginLow) {
            _topUpMargin(n, route);
        } else if (reason == RebalanceReason.SkewCap) {
            uint256 cap = shortCapacity();
            uint256 q = FPM.abs(n.size);
            _reduceBoth(n, FPM.min(_ceilLots(q - cap), _sliceBase(n.index)), route);
        } else {
            _fixDrift(n, route);
        }
        _afterRebalance(reason, n);
    }

    function _afterRebalance(RebalanceReason reason, Nav memory before) internal {
        _lastRebalanceBlock = uint64(block.number);
        Nav memory a = _nav();
        emit Rebalanced(reason, int256(a.spot) - int256(before.spot), a.size - before.size, a.nav, sharePrice());
        if (reason == RebalanceReason.ExitHedge && a.size == 0 && a.spot < _lot) emit HedgeExited(a.nav);
        _snapshot();
    }

    // ═══ Rules (MATH_SPEC §5.2–§5.3) ════════════════════════════════════════════

    /// @inheritdoc IPulseVault
    function needsRebalance() external view returns (RebalanceReason) {
        return _needs(_nav());
    }

    /// @dev Priority: exit (in progress or triggered) > MarginLow > SkewCap > DeltaDrift > Deploy; flat ⇒ EnterHedge.
    function _needs(Nav memory n) internal view returns (RebalanceReason) {
        bool positioned = n.size != 0 || n.spot >= _lot;
        if (!_entered) {
            if (positioned) return RebalanceReason.ExitHedge; // an exit in progress keeps unwinding
            (bool ok, int256 r) = _avgRate();
            if (ok && _entryTest(r) && _targetBase(n) >= _lot) return RebalanceReason.EnterHedge;
            return RebalanceReason.None;
        }
        if (shouldExitHedge()) return RebalanceReason.ExitHedge;
        uint256 q = FPM.abs(n.size);
        if (q != 0 && _marginRatio(n) < _p.minMarginRatio) return RebalanceReason.MarginLow;
        if (q > shortCapacity() + _lot) return RebalanceReason.SkewCap;
        if (_drifted(n)) return RebalanceReason.DeltaDrift;
        uint256 h = _targetBase(n);
        if (h >= q + _lot && _deployBudget(n) >= _lot) return RebalanceReason.Deploy;
        return RebalanceReason.None;
    }

    /// @inheritdoc IPulseVault
    /// @dev MATH_SPEC §5.3: exit ⇔ r̄·exitHorizon < −c (c = roundTripFee, the one-way cost), rounds neutral.
    function shouldExitHedge() public view returns (bool) {
        (bool ok, int256 r) = _avgRate();
        return ok && r * int256(_p.exitHorizonSec) < -int256(_p.roundTripFee);
    }

    /// @dev MATH_SPEC §5.3: enter ⇔ r̄·entryHorizon > 2c.
    function _entryTest(int256 r) internal view returns (bool) {
        return r * int256(_p.entryHorizonSec) > 2 * int256(_p.roundTripFee);
    }

    /// @dev r̄ = averageFundingRate(8 h), per second WAD. Not available until the perp has 8 h of checkpoints.
    function _avgRate() internal view returns (bool ok, int256 r) {
        try IClearingHouse(clearingHouse).averageFundingRate(FUNDING_WINDOW_BLOCKS) returns (int256 v) {
            return (true, v);
        } catch {
            return (false, 0);
        }
    }

    /// @inheritdoc IPulseVault
    /// @dev MATH_SPEC §5.2 as amended (PHASES decision 11): skewCapacity · the net long of every account except the
    ///      vault and the registered liquidity providers. Σq = 0 makes that −(vaultSize + Σ providerSize), computed
    ///      in O(#providers ≤ MAX_BATCH). (The literal §5.2 form, longOI − (shortOI − |vaultShort|), equals
    ///      |vaultShort| because longOI == shortOI: it would cap the vault at 0.8 × itself and never let it enter.)
    ///      Rounds down.
    function shortCapacity() public view returns (uint256) {
        IClearingHouse ch = IClearingHouse(clearingHouse);
        int256 carried = ch.getPosition(address(this)).size;
        uint256 n = skewProviders.length;
        for (uint256 i; i < n; ++i) {
            carried += ch.getPosition(skewProviders[i]).size;
        }
        return carried < 0 ? FPM.mulWad(uint256(-carried), _p.skewCapacity) : 0;
    }

    /// @notice Register / remove a liquidity provider for the skew rule (owner). At most MAX_BATCH.
    function setSkewProvider(address provider, bool isProvider) external onlyOwner {
        if (provider == address(0) || provider == address(this)) revert InvalidParams();
        uint256 n = skewProviders.length;
        for (uint256 i; i < n; ++i) {
            if (skewProviders[i] == provider) {
                if (!isProvider) {
                    skewProviders[i] = skewProviders[n - 1];
                    skewProviders.pop();
                }
                return;
            }
        }
        if (!isProvider) return;
        if (n >= PulseConstants.MAX_BATCH) revert InvalidParams();
        skewProviders.push(provider);
    }

    /// @dev MATH_SPEC §5.1: h = min(N/P, shortCapacity) in lots ↓, N = D·L/(L+1) ↓ with D = NAV·(1 − idleBuffer).
    function _targetBase(Nav memory n) internal view returns (uint256) {
        uint256 d = FPM.mulWad(n.nav * TO_WAD, WAD - _p.idleBuffer);
        uint256 notional = FPM.mulDiv(d, _p.leverage, _p.leverage + WAD);
        return _floorLots(FPM.min(FPM.divWad(notional, n.index), shortCapacity()));
    }

    /// @dev Target hedge notional N (quote WAD) for the drift test.
    function _targetNotional(Nav memory n) internal view returns (uint256) {
        return FPM.mulWad(FPM.abs(n.size), n.index);
    }

    /// @dev MATH_SPEC §5.3: |spot + perpSize|·P / N > θ.
    function _drifted(Nav memory n) internal view returns (bool) {
        uint256 notional = _targetNotional(n);
        if (notional == 0) return n.spot >= _lot;
        uint256 net = FPM.abs(int256(n.spot) + n.size);
        return FPM.mulWad(net, n.index) > FPM.mulWad(notional, _p.driftBand);
    }

    /// @dev perp equity (at the index) / perp notional, WAD; max when flat.
    function _marginRatio(Nav memory n) internal pure returns (uint256) {
        uint256 notional = FPM.mulWad(FPM.abs(n.size), n.index);
        if (notional == 0) return type(uint256).max;
        return n.perpEquity <= 0 ? 0 : FPM.divWad(uint256(n.perpEquity), notional);
    }

    // ═══ Actions ═════════════════════════════════════════════════════════════════

    /// @dev One slice toward the target: buy spot `add`, deposit margin add·I/L, short `add` lots at ≥ I·(1 − s).
    function _deploySlice(Nav memory n, bytes memory route) internal {
        uint256 add = FPM.min(_targetBase(n) - FPM.min(_targetBase(n), FPM.abs(n.size)), _deployBudget(n));
        add = _floorLots(add);
        if (add == 0) revert NothingToDo();
        (uint256 quoteIn, uint256 margin) = _deployCost(add, n.index);
        IERC20(asset()).forceApprove(hedger, quoteIn);
        // spot minOut from the index + maxSlippage (never from the keeper): exactly `add` base, rounds down
        IKuruHedger(hedger).buySpot(quoteIn, _baseFor(quoteIn, n.index), route);
        IERC20(asset()).forceApprove(clearingHouse, margin);
        IClearingHouse(clearingHouse).deposit(margin);
        _perpOrder(false, add, n.index, false);
    }

    /// @dev Largest lot-rounded add the idle cash (above the buffer) and the slice cap allow.
    function _deployBudget(Nav memory n) internal view returns (uint256) {
        uint256 buffer = FPM.mulWadUp(n.nav, _p.idleBuffer);
        if (n.idle <= buffer) return 0;
        uint256 cash = n.idle - buffer;
        // cost per base (quote WAD per 1e18 base): I spot + I/L margin
        uint256 perBase = n.index + FPM.divWadUp(n.index, _p.leverage);
        uint256 byCash = FPM.mulDiv(cash * TO_WAD, WAD, perBase);
        return _floorLots(FPM.min(byCash, _sliceBase(n.index)));
    }

    /// @return quoteIn AUSD for the spot leg (add·I) ↑ @return margin AUSD for the perp leg ↑ (MATH_SPEC §5.1, M = h·P/L)
    /// @dev The spot fill at ≤ I·(1 + s) buys ≥ add/(1 + s): the net delta after a slice is within the slippage bound.
    function _deployCost(uint256 add, uint256 index) internal view returns (uint256 quoteIn, uint256 margin) {
        quoteIn = FPM.divUp(FPM.mulWadUp(add, index), TO_WAD);
        margin = FPM.divUp(FPM.divWadUp(FPM.mulWadUp(add, index), _p.leverage), TO_WAD);
    }

    /// @dev Unwind one slice of both legs (exit), then return the collateral once flat.
    function _exitSlice(Nav memory n, bytes memory route) internal {
        uint256 q = FPM.abs(n.size);
        uint256 x = FPM.min(q, _ceilLots(_sliceBase(n.index)));
        _reduceBoth(n, x, route);
        if (q == x) {
            // flat: sell the remaining spot (≤ one slice) and withdraw all collateral
            uint256 spot = IERC20(_wmon).balanceOf(address(this));
            if (spot != 0) _sellSpot(FPM.min(spot, _sliceBase(n.index)), n.index, route);
            AccountView memory a = IClearingHouse(clearingHouse).getAccount(address(this));
            uint256 all = a.collateral / TO_WAD;
            if (all != 0) IClearingHouse(clearingHouse).withdraw(all);
        }
    }

    /// @dev Buy back x of the short (reduce-only, ≤ I·(1 + s)) and sell the same base of spot (≥ I·(1 − s)).
    function _reduceBoth(Nav memory n, uint256 x, bytes memory route) internal {
        if (x == 0) revert NothingToDo();
        _perpOrder(true, x, n.index, true);
        uint256 spot = IERC20(_wmon).balanceOf(address(this));
        if (spot != 0) _sellSpot(FPM.min(spot, x), n.index, route);
    }

    /// @dev MarginLow: top the perp margin up to the target ratio from idle; if there is no idle, reduce both legs by
    ///      a slice first and use the proceeds.
    function _topUpMargin(Nav memory n, bytes memory route) internal {
        uint256 q = FPM.abs(n.size);
        uint256 want = FPM.mulWadUp(FPM.mulWadUp(q, n.index), _p.targetMarginRatio);
        uint256 need = n.perpEquity >= int256(want) ? 0 : FPM.divUp(want - uint256(FPM.max(n.perpEquity, 0)), TO_WAD);
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (idle == 0) {
            _reduceBoth(n, FPM.min(q, _ceilLots(_sliceBase(n.index))), route);
            idle = IERC20(asset()).balanceOf(address(this));
        }
        uint256 amount = FPM.min(FPM.min(need, idle), _p.maxSliceAssets);
        if (amount == 0) revert NothingToDo();
        IERC20(asset()).forceApprove(clearingHouse, amount);
        IClearingHouse(clearingHouse).deposit(amount);
    }

    /// @dev DeltaDrift: sell excess spot, or buy the missing spot (the perp leg keeps its lot granularity).
    function _fixDrift(Nav memory n, bytes memory route) internal {
        int256 net = int256(n.spot) + n.size;
        uint256 slice = _sliceBase(n.index);
        if (net > 0) {
            _sellSpot(FPM.min(uint256(net), slice), n.index, route);
        } else {
            uint256 base = FPM.min(uint256(-net), slice);
            uint256 quoteIn = FPM.divUp(FPM.mulWadUp(base, n.index), TO_WAD);
            IERC20(asset()).forceApprove(hedger, quoteIn);
            IKuruHedger(hedger).buySpot(quoteIn, _baseFor(quoteIn, n.index), route);
        }
    }

    /// @dev Pro-rata unwind of a fraction f of both legs and of the perp equity (withdrawals). Bounded: one perp
    ///      order, one spot sell, one CH withdraw.
    function _unwind(Nav memory n, uint256 f, bytes memory route, bool) internal {
        uint256 q = FPM.abs(n.size);
        uint256 x = FPM.min(q, _ceilLots(FPM.mulWadUp(q, f)));
        if (x != 0) _perpOrder(true, x, n.index, true);
        uint256 spot = IERC20(_wmon).balanceOf(address(this));
        uint256 sell = q == 0 ? spot : FPM.min(spot, FPM.mulWadUp(spot, f));
        if (sell != 0) _sellSpot(sell, n.index, route);
        AccountView memory a = IClearingHouse(clearingHouse).getAccount(address(this));
        uint256 w = (a.size == 0 ? a.collateral : FPM.mulWad(a.collateral, f)) / TO_WAD;
        if (w != 0) {
            // keeps the remaining position margined pro rata; if the CH refuses, the idle check reverts the withdrawal
            try IClearingHouse(clearingHouse).withdraw(w) {} catch {}
        }
    }

    function _sellSpot(uint256 base, uint256 index, bytes memory route) internal {
        IERC20(_wmon).forceApprove(hedger, base);
        // quote minOut from the index − maxSlippage, rounds down
        uint256 minOut = FPM.mulWad(FPM.mulWad(base, index), WAD - _p.maxSlippage) / TO_WAD;
        IKuruHedger(hedger).sellSpot(base, minOut, route);
    }

    /// @dev Market order of exactly `base` (whole lots, all-or-nothing) with the limit at the index ± maxSlippage:
    ///      a buy never pays above I·(1 + s) (tick ↓), a sell never receives below I·(1 − s) (tick ↑).
    function _perpOrder(bool isBid, uint256 base, uint256 index, bool reduceOnly) internal {
        uint64 lots = uint64(base / _lot);
        if (lots == 0) return;
        uint256 limitPx = isBid ? FPM.mulWad(index, WAD + _p.maxSlippage) : FPM.mulWadUp(index, WAD - _p.maxSlippage);
        uint32 tick = uint32(isBid ? limitPx / _tick : FPM.divUp(limitPx, _tick));
        IOrderBook(orderBook).placeMarketOrder(isBid, lots, tick, lots, reduceOnly);
    }

    /// @dev Base bought with `quoteIn` at the worst allowed price I·(1 + s), rounds down.
    function _baseFor(uint256 quoteIn, uint256 index) internal view returns (uint256) {
        return FPM.divWad(quoteIn * TO_WAD, FPM.mulWadUp(index, WAD + _p.maxSlippage));
    }

    function _sliceBase(uint256 index) internal view returns (uint256) {
        return FPM.divWad(_p.maxSliceAssets * TO_WAD, index);
    }

    function _floorLots(uint256 base) internal view returns (uint256) {
        return base / _lot * _lot;
    }

    function _ceilLots(uint256 base) internal view returns (uint256) {
        return FPM.divUp(base, _lot) * _lot;
    }

    // ═══ NAV (MATH_SPEC §5.4) ════════════════════════════════════════════════════

    /// @dev NAV = idle + spot·I + (collateral + size·I − ON − pending), all at the ORACLE INDEX, rounds down.
    function _nav() internal view returns (Nav memory n) {
        IClearingHouse ch = IClearingHouse(clearingHouse);
        n.idle = IERC20(asset()).balanceOf(address(this));
        n.spot = IERC20(_wmon).balanceOf(address(this));
        n.index = ch.indexPrice();
        Position memory pos = ch.getPosition(address(this));
        AccountView memory a = ch.getAccount(address(this));
        n.size = pos.size;
        n.pending = a.pendingFunding;
        n.perpEquity =
            int256(a.collateral) + FPM.sMulWad(pos.size, int256(n.index)) - pos.openNotional - a.pendingFunding;
        int256 navWad = int256(n.idle * TO_WAD) + int256(FPM.mulWad(n.spot, n.index)) + n.perpEquity;
        n.nav = navWad > 0 ? uint256(navWad) / TO_WAD : 0;
    }

    function _snapshot() internal {
        Nav memory n = _nav();
        emit NavSnapshot(n.nav, totalSupply(), sharePrice(), -n.pending);
    }

    // ═══ Views / admin ═══════════════════════════════════════════════════════════

    /// @inheritdoc IPulseVault
    function hedgeState() external view returns (HedgeState memory h) {
        Nav memory n = _nav();
        h.spotBase = n.spot;
        h.perpSize = n.size;
        h.perpEquity = n.perpEquity;
        h.idleAssets = n.idle;
        h.nav = n.nav;
        h.netDelta = int256(n.spot) + n.size;
        h.marginRatio = _marginRatio(n);
        h.hedged = n.size != 0;
        h.lastRebalanceBlock = _lastRebalanceBlock;
    }

    /// @inheritdoc IPulseVault
    /// @dev (totalAssets + 1)·1e30 / (totalSupply + 1e12): the ERC-4626 conversion (virtual offset 12) at full WAD
    ///      precision, so per-block funding shows up (convertToAssets(1e18) only resolves 1 token unit). 1e18 at par,
    ///      rounds down.
    function sharePrice() public view returns (uint256) {
        return FPM.fullMulDiv(totalAssets() + 1, 1e30, totalSupply() + 10 ** _decimalsOffset());
    }

    /// @inheritdoc IPulseVault
    function vaultParams() external view returns (VaultParams memory) {
        return _p;
    }

    /// @notice True between an entry and the start of an exit (hysteresis state).
    function entered() external view returns (bool) {
        return _entered;
    }

    /// @inheritdoc IPulseVault
    function setVaultParams(VaultParams calldata p) external onlyOwner {
        _storeParams(p);
    }

    /// @inheritdoc IPulseVault
    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert InvalidParams();
        isKeeper[keeper] = allowed;
        emit KeeperUpdated(keeper, allowed);
    }

    function _storeParams(VaultParams memory p) internal {
        if (
            p.leverage < 0.5e18 || p.leverage > 5e18 || p.driftBand == 0 || p.driftBand > 0.5e18
                || p.minMarginRatio == 0 || p.minMarginRatio >= p.targetMarginRatio || p.targetMarginRatio > 2e18
                || p.exitHorizonSec < 1 hours || p.exitHorizonSec > 30 days || p.entryHorizonSec < 1 hours
                || p.entryHorizonSec > 30 days || p.roundTripFee > 0.05e18 || p.maxSlippage == 0
                || p.maxSlippage > 0.05e18 || p.idleBuffer > 0.5e18 || p.depositCap == 0 || p.skewCapacity > WAD
                || p.maxSliceAssets == 0
        ) revert InvalidParams();
        _p = p;
        emit VaultParamsUpdated(p);
    }
}
