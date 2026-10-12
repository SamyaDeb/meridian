// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";
import {IPerplFundingSource} from "../interfaces/IPerplFundingSource.sol";
import {IFundingRateOracle} from "../interfaces/IFundingRateOracle.sol";
import {IPerplExchange} from "../interfaces/external/IPerplExchange.sol";
import {FundingParams, FundingState, MeridianConstants} from "../interfaces/MeridianTypes.sol";

/// @title PerplFundingSource — one Perpl perpetual's funding as a FundingSwapMarket source (CR-017, MATH_SPEC §6.8)
/// @notice Snapshot at poke: `poke()` reads Perpl's (fundingSumPNS, fundingEventBlock) and, only when the event block
///         advanced, writes one observation {F, G, feb} plus the current rate, cap and price. F and G step in the same
///         poke (Perpl pays funding in one lump per interval; a fixed leg accruing every block would let a trader
///         enter just before the lump and collect a whole interval of floating for almost no fixed cost). Views answer
///         from storage only. Non-upgradeable, no owner, no loops except a binary search bounded by RING_SIZE.
contract PerplFundingSource is IPerplFundingSource, ReentrancyGuardTransient {
    using SafeCast for uint256;
    using SafeCast for int256;

    /// @notice Checkpoints kept: one per Perpl funding event (2,580 s) ⇒ 256 ≈ 7.6 days (≥ the 8 h swap mark window).
    uint256 public constant RING_SIZE = 256;
    /// @notice A poke reverts when Perpl's oracle price is older than this (seconds). Perpl's own refPriceMaxAgeSec is
    ///         60 s on testnet MON; 120 s tolerates one missed oracle update.
    uint256 public constant MAX_PRICE_AGE = 120;
    /// @notice Headroom on the reported rate cap for the gap between Perpl's funding price and its oracle (bps).
    uint256 public constant CAP_PRICE_BUFFER_BPS = 500;
    /// @dev pct100k → fraction ×1e18: ×1e13.
    int256 internal constant PCT100K_TO_WAD = 1e13;
    uint256 internal constant BPS = 10_000;

    struct Checkpoint {
        int256 cumFunding; // F, quote WAD per 1 base
        uint64 blockNumber; // Perpl funding event block (feb)
        uint192 cumIndexTime; // G, quote WAD · s per 1 base
    }

    /// @inheritdoc IPerplFundingSource
    address public immutable exchange;
    /// @inheritdoc IPerplFundingSource
    uint256 public immutable perpId;
    /// @inheritdoc IPerplFundingSource
    uint256 public immutable fundingIntervalBlocks;
    /// @inheritdoc IPerplFundingSource
    uint256 public immutable fundingIntervalSec;
    /// @inheritdoc IPerplFundingSource
    uint256 public immutable sumScale;
    /// @notice Price (PNS) → WAD: ×10^(18 − priceDecimals).
    uint256 public immutable priceScale;
    uint256 internal immutable _priceDecimals;
    uint256 internal immutable _scalingExp;

    // hot slot: price, last poke block, ring index
    uint128 internal _indexPrice;
    uint64 internal _lastPokeBlock;
    uint32 internal _idx;
    // rate and cap, per-second WAD
    int128 internal _rate;
    uint128 internal _rateCap;
    Checkpoint[RING_SIZE] internal _ring;

    /// @param exchange_ Perpl Exchange proxy (`deployments/perpl.json`)
    /// @param perpId_ Perpl perpetual id (testnet MON = 64)
    /// @param fundingIntervalSec_ Perpl funding interval in seconds (2,580, `deployments/perpl.json`)
    /// @dev Reads the scale factors and the interval in blocks once, then writes the first observation (G = 0), so a
    ///      swap market never reads an empty source. Reverts if Perpl's price is stale.
    constructor(address exchange_, uint256 perpId_, uint256 fundingIntervalSec_) {
        if (exchange_ == address(0) || fundingIntervalSec_ == 0) revert InvalidParams();
        IPerplExchange x = IPerplExchange(exchange_);
        IPerplExchange.PerpetualInfoV2 memory info = x.getPerpetualInfoV2(perpId_);
        uint256 blocks = x.getFundingInterval();
        if (blocks == 0 || info.priceDecimals + info.fundingSumScalingExp > 18) revert InvalidParams();
        exchange = exchange_;
        perpId = perpId_;
        fundingIntervalBlocks = blocks;
        fundingIntervalSec = fundingIntervalSec_;
        _priceDecimals = info.priceDecimals;
        _scalingExp = info.fundingSumScalingExp;
        uint256 fScale = 10 ** (18 - info.priceDecimals - info.fundingSumScalingExp);
        uint256 pScale = 10 ** (18 - info.priceDecimals);
        (sumScale, priceScale) = (fScale, pScale);
        (int48 sum, uint256 feb) = x.getFundingSumAtBlock(perpId_, block.number);
        if (feb == 0) revert InvalidParams();
        int256 f = _toF(sum, fScale);
        _ring[0] = Checkpoint(f, feb.toUint64(), 0);
        uint256 price = _store(info, fundingIntervalSec_, pScale);
        emit Poked(f, 0, uint64(feb), price, _rate);
    }

    // ═══ Poke ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IPerplFundingSource
    function poke() external nonReentrant returns (bool) {
        IPerplExchange x = IPerplExchange(exchange);
        (int48 sum, uint256 feb) = x.getFundingSumAtBlock(perpId, block.number);
        uint256 idx = _idx;
        Checkpoint memory last = _ring[idx];
        if (feb <= last.blockNumber) return false;
        IPerplExchange.PerpetualInfoV2 memory info = x.getPerpetualInfoV2(perpId);
        if (info.priceDecimals != _priceDecimals || info.fundingSumScalingExp != _scalingExp) {
            revert PerplScaleChanged();
        }
        uint256 price = _store(info, fundingIntervalSec, priceScale);
        int256 f = _toF(sum, sumScale);
        // MATH_SPEC §6.8, rounds neutral (0, like the ClearingHouse's G): ΔG = I · Δfeb · intervalSec / intervalBlocks
        uint256 g = uint256(last.cumIndexTime)
            + FPM.fullMulDiv(price, (feb - last.blockNumber) * fundingIntervalSec, fundingIntervalBlocks);
        idx = (idx + 1) % RING_SIZE;
        _ring[idx] = Checkpoint(f, feb.toUint64(), g.toUint192());
        _idx = uint32(idx);
        emit Poked(f, g, uint64(feb), price, _rate);
        return true;
    }

    /// @dev Stores price, rate and cap from Perpl's market info; reverts (nothing written) on a stale or zero price.
    function _store(IPerplExchange.PerpetualInfoV2 memory info, uint256 intervalSec, uint256 pScale)
        internal
        returns (uint256 price)
    {
        if (
            info.oraclePNS == 0
                || (block.timestamp > info.oracleTimestampSec
                    && block.timestamp - info.oracleTimestampSec > MAX_PRICE_AGE)
        ) revert StalePerplPrice(info.oracleTimestampSec);
        // Perpl PNS → WAD, exact
        price = info.oraclePNS * pScale;
        _indexPrice = price.toUint128();
        // MATH_SPEC §6.8, rounds neutral (0): rate per interval ×1e5 → per-second WAD
        _rate = (int256(info.fundingRatePct100k) * PCT100K_TO_WAD / int256(intervalSec)).toInt128();
        // MATH_SPEC §6.8, rounds up (a margin bound): clamp per interval ×1e5 → per-second WAD, plus the price buffer
        _rateCap = FPM.mulDivUp(
                info.absFundingClampPctPer100K * uint256(PCT100K_TO_WAD), BPS + CAP_PRICE_BUFFER_BPS, BPS * intervalSec
            ).toUint128();
        _lastPokeBlock = uint64(block.number);
    }

    /// @dev MATH_SPEC §6.8, exact: F_wad = fundingSumPNS · 10^(18 − priceDecimals − scalingExp).
    function _toF(int48 sum, uint256 scale) internal pure returns (int256) {
        return int256(sum) * int256(scale);
    }

    // ═══ IFundingRateOracle ═════════════════════════════════════════════════════

    /// @inheritdoc IFundingRateOracle
    /// @dev The last snapshot, never extrapolated; `blockNumber` = its Perpl funding event block.
    function latestObservation() external view returns (int256 cumFunding, int256 cumIndexTime, uint64 blockNumber) {
        Checkpoint memory c = _ring[_idx];
        return (c.cumFunding, int256(uint256(c.cumIndexTime)), c.blockNumber);
    }

    /// @inheritdoc IFundingRateOracle
    /// @dev Newest checkpoint with feb ≤ block.number − blocksAgo; binary search ≤ log2(RING_SIZE) = 8 iterations.
    function observe(uint64 blocksAgo) public view returns (int256, int256, uint64) {
        if (blocksAgo > block.number) revert ObservationTooOld();
        uint256 target = block.number - blocksAgo;
        uint256 idx = _idx;
        Checkpoint memory c = _ring[idx];
        if (c.blockNumber <= target) return (c.cumFunding, int256(uint256(c.cumIndexTime)), c.blockNumber);
        bool wrapped = _ring[(idx + 1) % RING_SIZE].blockNumber != 0;
        uint256 oldest = wrapped ? (idx + 1) % RING_SIZE : 0;
        uint256 count = wrapped ? RING_SIZE : idx + 1;
        if (_ring[oldest].blockNumber > target) revert ObservationTooOld();
        // invariant: ring[lo].block ≤ target < ring[hi].block (hi = newest, checked above)
        uint256 lo;
        uint256 hi = count - 1;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) >> 1;
            if (_ring[(oldest + mid) % RING_SIZE].blockNumber <= target) lo = mid;
            else hi = mid;
        }
        c = _ring[(oldest + lo) % RING_SIZE];
        return (c.cumFunding, int256(uint256(c.cumIndexTime)), c.blockNumber);
    }

    /// @inheritdoc IFundingRateOracle
    /// @dev MATH_SPEC §1.8 / §6.8: ΔF·1e18/ΔG between the checkpoint `blocksAgo` back and the newest one, rounds
    ///      neutral; the current rate if no index-time elapsed. Clamped to ±rateCap, which binds only if Perpl's
    ///      funding price differs from its oracle by more than the buffer or its admin overwrote a funding sum.
    function averageFundingRate(uint64 blocksAgo) public view returns (int256) {
        Checkpoint memory c = _ring[_idx];
        (int256 f0, int256 g0,) = observe(blocksAgo);
        int256 dG = int256(uint256(c.cumIndexTime)) - g0;
        if (dG == 0) return _rate;
        int256 cap = int256(uint256(_rateCap));
        return FPM.clamp(FPM.sDivWad(c.cumFunding - f0, dG), -cap, cap);
    }

    /// @inheritdoc IFundingRateOracle
    function averageFundingApr(uint64 blocksAgo) external view returns (int256) {
        return averageFundingRate(blocksAgo) * int256(MeridianConstants.SECONDS_PER_YEAR);
    }

    // ═══ ClearingHouse-shaped views ═════════════════════════════════════════════

    /// @inheritdoc IPerplFundingSource
    function indexPrice() external view returns (uint256) {
        return _indexPrice;
    }

    /// @inheritdoc IPerplFundingSource
    function fundingParams() external view returns (FundingParams memory p) {
        p.rateCap = _rateCap;
        // nominal block time implied by Perpl's interval, rounds neutral (informational only)
        p.blockTimeMs = fundingIntervalSec * 1000 / fundingIntervalBlocks;
    }

    /// @inheritdoc IPerplFundingSource
    function fundingState() external view returns (FundingState memory s) {
        Checkpoint memory c = _ring[_idx];
        s.cumFunding = c.cumFunding;
        s.cumIndexTime = int256(uint256(c.cumIndexTime));
        s.rate = _rate;
        s.lastUpdateBlock = c.blockNumber;
    }

    // ═══ Introspection ══════════════════════════════════════════════════════════

    /// @inheritdoc IPerplFundingSource
    function lastPokeBlock() external view returns (uint64) {
        return _lastPokeBlock;
    }

    /// @inheritdoc IPerplFundingSource
    function checkpointAt(uint256 slot) external view returns (int256, int256, uint64) {
        Checkpoint memory c = _ring[slot];
        return (c.cumFunding, int256(uint256(c.cumIndexTime)), c.blockNumber);
    }

    /// @inheritdoc IPerplFundingSource
    function checkpointIndex() external view returns (uint256) {
        return _idx;
    }
}
