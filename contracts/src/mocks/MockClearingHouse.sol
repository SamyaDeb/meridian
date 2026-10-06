// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IClearingHouse} from "../interfaces/IClearingHouse.sol";
import {IOracleAdapter} from "../interfaces/IOracleAdapter.sol";
import {
    MeridianConstants,
    RiskParams,
    FundingParams,
    FundingState,
    Position,
    AccountView
} from "../interfaces/MeridianTypes.sol";

/// @notice Simplified ClearingHouse for building the vault / frontend / keepers before WS-02 merges.
///         NOT the spec: no fees, no EMA funding (cumFunding is set by hand), simplified liquidation,
///         no rounding discipline. Position accounting (openNotional, realized pnl) matches MATH_SPEC §3.
contract MockClearingHouse is IClearingHouse {
    using SafeERC20 for IERC20;

    int256 internal constant W = MeridianConstants.IWAD;

    address public immutable collateralToken;
    address public immutable oracle;
    address public immutable insuranceFund;
    address public orderBook;

    RiskParams internal _risk;
    FundingParams internal _funding;
    FundingState internal _fs;
    uint256 public markOverride;
    bool public paused;

    mapping(address => uint256) public collateralOf; // WAD
    mapping(address => uint256) public reservedOf; // WAD
    mapping(address => Position) internal _pos;
    uint256 internal _longOI;
    uint256 internal _shortOI;

    constructor(address token_, address oracle_, address insuranceFund_) {
        collateralToken = token_;
        oracle = oracle_;
        insuranceFund = insuranceFund_;
        _risk = RiskParams({
            imr: 0.1e18,
            mmr: 0.05e18,
            takerFee: 0,
            makerFee: 0,
            liqPenalty: 0,
            keeperShare: 0,
            maxOpenInterest: type(uint128).max,
            maxPositionSize: type(uint128).max
        });
        _funding.blockTimeMs = 300;
    }

    // ─── mock controls ────────────────────────────────────────────────────────
    function mockSetMark(uint256 priceWad) external {
        markOverride = priceWad;
    }

    /// @notice Simulate funding: F moves by `deltaPerUnit` (quote WAD per 1 base). + => longs pay.
    function mockAccrueFunding(int256 deltaPerUnit, int256 rate) external {
        mockAccrue(deltaPerUnit, 0, rate);
    }

    /// @notice Simulate funding with both indices: ΔF (quote WAD / base) and ΔG (index * seconds, WAD).
    ///         For a consistent rate r over dt seconds at index I: ΔG = I*dt, ΔF = r*I*dt / 1e18.
    function mockAccrue(int256 deltaF, int256 deltaG, int256 rate) public {
        _fs.cumFunding += deltaF;
        _fs.cumIndexTime += deltaG;
        _fs.rate = rate;
        _fs.lastUpdateBlock = uint64(block.number);
        emit FundingUpdated(
            uint64(block.number), 0, 0, rate, _fs.cumFunding, _fs.cumIndexTime, indexPrice(), markPrice()
        );
    }

    // ─── collateral ───────────────────────────────────────────────────────────
    function deposit(uint256 amountToken) external {
        _deposit(msg.sender, amountToken);
    }

    function depositFor(address account, uint256 amountToken) external {
        _deposit(account, amountToken);
    }

    function _deposit(address account, uint256 amountToken) internal {
        if (amountToken == 0) revert ZeroAmount();
        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), amountToken);
        uint256 wad = amountToken * MeridianConstants.AUSD_TO_WAD;
        collateralOf[account] += wad;
        emit Deposited(account, amountToken, wad);
    }

    function withdraw(uint256 amountToken) external {
        settleFunding(msg.sender);
        uint256 wad = amountToken * MeridianConstants.AUSD_TO_WAD;
        if (wad > collateralOf[msg.sender]) revert InsufficientMargin();
        collateralOf[msg.sender] -= wad;
        AccountView memory a = getAccount(msg.sender);
        if (a.equity < int256(a.initialMargin)) revert InsufficientMargin();
        IERC20(collateralToken).safeTransfer(msg.sender, amountToken);
        emit Withdrawn(msg.sender, amountToken, wad);
    }

    // ─── funding ──────────────────────────────────────────────────────────────
    function updateFunding() external view returns (int256) {
        return _fs.cumFunding;
    }

    function settleFunding(address account) public {
        Position storage p = _pos[account];
        int256 payment = p.size * (_fs.cumFunding - p.lastCumFunding) / W;
        p.lastCumFunding = _fs.cumFunding;
        if (payment != 0) {
            _addCollateral(account, -payment);
            emit FundingSettled(account, payment, _fs.cumFunding);
        }
    }

    // ─── liquidation (simplified: full transfer at mark, no penalty) ──────────
    function liquidate(address account, uint256) external returns (int256 sizeTransferred) {
        if (!isLiquidatable(account)) revert NotLiquidatable();
        sizeTransferred = _pos[account].size;
        uint256 m = markPrice();
        _applyTrade(account, -sizeTransferred, m, false);
        _applyTrade(msg.sender, sizeTransferred, m, false);
        emit Liquidated(account, msg.sender, sizeTransferred, m, 0, 0, 0, 0);
    }

    // ─── order book hooks ─────────────────────────────────────────────────────
    modifier onlyOB() {
        if (msg.sender != orderBook) revert OnlyOrderBook();
        _;
    }

    function reserveOrderMargin(address trader, bool, uint256 sizeWad, uint256 priceWad) external onlyOB {
        reservedOf[trader] += sizeWad * priceWad / MeridianConstants.WAD * _risk.imr / MeridianConstants.WAD;
        AccountView memory a = getAccount(trader);
        if (a.equity < int256(a.initialMargin)) revert InsufficientMargin();
        emit OrderMarginChanged(trader, reservedOf[trader]);
    }

    function releaseOrderMargin(address trader, bool, uint256 sizeWad, uint256 priceWad) external onlyOB {
        uint256 r = sizeWad * priceWad / MeridianConstants.WAD * _risk.imr / MeridianConstants.WAD;
        reservedOf[trader] = r > reservedOf[trader] ? 0 : reservedOf[trader] - r;
        emit OrderMarginChanged(trader, reservedOf[trader]);
    }

    function settleMakerFill(address maker, bool makerIsBid, uint256 sizeWad, uint256 priceWad)
        external
        onlyOB
        returns (MakerFillResult)
    {
        _applyTrade(maker, makerIsBid ? int256(sizeWad) : -int256(sizeWad), priceWad, true);
        return MakerFillResult.Filled;
    }

    function settleTakerFill(address taker, bool takerIsBid, uint256 sizeWad, uint256 notionalWad, bool reduceOnly)
        external
        onlyOB
    {
        int256 before = _pos[taker].size;
        int256 d = takerIsBid ? int256(sizeWad) : -int256(sizeWad);
        _applyTrade(taker, d, notionalWad * MeridianConstants.WAD / sizeWad, false);
        int256 after_ = _pos[taker].size;
        if (reduceOnly) {
            if (_abs(after_) > _abs(before) || (before != 0 && after_ != 0 && (before > 0) != (after_ > 0))) {
                revert ReduceOnlyViolated();
            }
        } else {
            AccountView memory a = getAccount(taker);
            if (a.equity < int256(a.initialMargin)) revert InsufficientMargin();
        }
    }

    function _applyTrade(address account, int256 d, uint256 price, bool isMaker) internal {
        settleFunding(account);
        Position storage p = _pos[account];
        int256 s = p.size;
        int256 px = int256(price);
        int256 realized;
        if (s == 0 || (s > 0) == (d > 0)) {
            p.openNotional += d * px / W;
            p.size = s + d;
        } else {
            uint256 closeAmt = _abs(d) < _abs(s) ? _abs(d) : _abs(s);
            int256 released = p.openNotional * int256(closeAmt) / int256(_abs(s));
            int256 exitValue = (s > 0 ? int256(1) : int256(-1)) * int256(closeAmt) * px / W;
            realized = exitValue - released;
            p.openNotional -= released;
            int256 dir = d > 0 ? int256(1) : int256(-1);
            p.size = s + dir * int256(closeAmt);
            uint256 rem = _abs(d) - closeAmt;
            if (rem > 0) {
                p.openNotional += dir * int256(rem) * px / W;
                p.size += dir * int256(rem);
            }
            _addCollateral(account, realized);
        }
        _updateOI(s, p.size);
        emit PositionChanged(account, d, p.size, price, realized, 0, isMaker);
    }

    function _updateOI(int256 oldS, int256 newS) internal {
        _longOI = _longOI + _pos0(newS) - _pos0(oldS);
        _shortOI = _shortOI + _pos0(-newS) - _pos0(-oldS);
    }

    function _addCollateral(address account, int256 delta) internal {
        if (delta >= 0) {
            collateralOf[account] += uint256(delta);
        } else {
            uint256 debit = uint256(-delta);
            collateralOf[account] = debit > collateralOf[account] ? 0 : collateralOf[account] - debit;
        }
    }

    // ─── admin ────────────────────────────────────────────────────────────────
    function setOrderBook(address ob) external {
        if (orderBook != address(0)) revert AlreadyInitialized();
        orderBook = ob;
    }

    function setRiskParams(RiskParams calldata params) external {
        _risk = params;
        emit RiskParamsUpdated(params);
    }

    function setFundingParams(FundingParams calldata params) external {
        _funding = params;
        emit FundingParamsUpdated(params);
    }

    function setPaused(bool p) external {
        paused = p;
        emit PausedSet(p);
    }

    function collectFees(address) external pure returns (uint256) {
        return 0;
    }

    // ─── views ────────────────────────────────────────────────────────────────
    function riskParams() external view returns (RiskParams memory) {
        return _risk;
    }

    function fundingParams() external view returns (FundingParams memory) {
        return _funding;
    }

    function fundingState() external view returns (FundingState memory) {
        return _fs;
    }

    function previewFundingState() external view returns (FundingState memory) {
        return _fs;
    }

    // ─── IFundingRateOracle (mock: no history; observe returns the latest state) ─
    function latestObservation() external view returns (int256, int256, uint64) {
        return (_fs.cumFunding, _fs.cumIndexTime, uint64(block.number));
    }

    function observe(uint64) external view returns (int256, int256, uint64) {
        return (_fs.cumFunding, _fs.cumIndexTime, _fs.lastUpdateBlock);
    }

    function averageFundingRate(uint64) public view returns (int256) {
        return _fs.rate;
    }

    function averageFundingApr(uint64 blocksAgo) external view returns (int256) {
        return averageFundingRate(blocksAgo) * int256(MeridianConstants.SECONDS_PER_YEAR);
    }

    function indexPrice() public view returns (uint256 p) {
        (, p,) = IOracleAdapter(oracle).tryGetIndexPrice();
    }

    function markPrice() public view returns (uint256) {
        return markOverride != 0 ? markOverride : indexPrice();
    }

    function getPosition(address account) external view returns (Position memory) {
        return _pos[account];
    }

    function getAccount(address account) public view returns (AccountView memory a) {
        Position memory p = _pos[account];
        uint256 m = markPrice();
        a.collateral = collateralOf[account];
        a.size = p.size;
        a.entryPrice = p.size == 0 ? 0 : uint256(p.openNotional * W / p.size);
        a.unrealizedPnl = p.size * int256(m) / W - p.openNotional;
        a.pendingFunding = p.size * (_fs.cumFunding - p.lastCumFunding) / W;
        a.equity = int256(a.collateral) + a.unrealizedPnl - a.pendingFunding;
        uint256 notional = _abs(p.size) * m / MeridianConstants.WAD;
        a.reservedOrderMargin = reservedOf[account];
        a.initialMargin = notional * _risk.imr / MeridianConstants.WAD + a.reservedOrderMargin;
        a.maintenanceMargin = notional * _risk.mmr / MeridianConstants.WAD;
        a.liquidatable = p.size != 0 && a.equity < int256(a.maintenanceMargin);
    }

    function isLiquidatable(address account) public view returns (bool) {
        return getAccount(account).liquidatable;
    }

    function openInterest() external view returns (uint256, uint256) {
        return (_longOI, _shortOI);
    }

    function accruedFees() external pure returns (uint256) {
        return 0;
    }

    function totalBadDebt() external pure returns (uint256) {
        return 0;
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }

    function _pos0(int256 x) internal pure returns (uint256) {
        return x > 0 ? uint256(x) : 0;
    }
}
