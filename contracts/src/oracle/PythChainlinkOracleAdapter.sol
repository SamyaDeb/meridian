// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IOracleAdapter} from "../interfaces/IOracleAdapter.sol";
import {IPythMinimal} from "../interfaces/external/IPythMinimal.sol";
import {AggregatorV3Interface} from "../interfaces/external/AggregatorV3Interface.sol";

/// @title PythChainlinkOracleAdapter — index price for one market
/// @notice Pyth (pull, pushed by the keeper/MM bot) is the primary source. A Chainlink push feed, when fresh,
///         guards the primary against deviation. A stale or unavailable Chainlink feed leaves Pyth alone in charge.
/// @dev Stateless except for owner-set params. Monad mainnet wiring (ARCHITECTURE R11, R12): Pyth
///      0x2880aB155794e7179c9eE2e38200202908C17B43, MON/USD id 0x3149…6cd1 (expo −8), Chainlink MON/USD
///      0xBcD78f76005B7515837af6b50c7C52BCf73822fb (8 dp). Pass `secondary = address(0)` to run without a guard.
contract PythChainlinkOracleAdapter is IOracleAdapter, Ownable, ReentrancyGuardTransient {
    enum Status {
        Ok,
        Stale,
        Invalid,
        Deviation
    }

    uint256 internal constant WAD = 1e18;
    /// @dev Pyth confidence must satisfy conf · CONF_DIVISOR ≤ price (≤ 1%).
    uint256 internal constant CONF_DIVISOR = 100;
    int32 internal constant MIN_EXPO = -18;

    uint256 public constant MIN_STALENESS = 1;
    uint256 public constant MAX_STALENESS = 1 hours;
    uint256 public constant MAX_DEVIATION = 0.1e18;
    uint256 public constant MIN_SECONDARY_STALENESS = 1 minutes;
    uint256 public constant MAX_SECONDARY_STALENESS = 2 days;

    IPythMinimal public immutable pyth;
    bytes32 public immutable priceId;
    /// @notice Chainlink guard feed; address(0) disables the guard.
    AggregatorV3Interface public immutable secondary;
    /// @notice Multiplier from the feed's decimals to WAD (1e10 for 8 dp).
    uint256 public immutable secondaryScale;
    /// @notice Age beyond which the secondary is ignored (ARCHITECTURE R11: 1 h).
    uint256 public immutable secondaryMaxStaleness;

    uint256 public maxStaleness;
    uint256 public maxDeviation;
    string public description;

    constructor(
        address owner_,
        IPythMinimal pyth_,
        bytes32 priceId_,
        AggregatorV3Interface secondary_,
        uint256 maxStaleness_,
        uint256 maxDeviation_,
        uint256 secondaryMaxStaleness_,
        string memory description_
    ) Ownable(owner_) {
        if (address(pyth_) == address(0)) revert InvalidOracleParams();
        if (secondaryMaxStaleness_ < MIN_SECONDARY_STALENESS || secondaryMaxStaleness_ > MAX_SECONDARY_STALENESS) {
            revert InvalidOracleParams();
        }
        uint256 scale = 1;
        if (address(secondary_) != address(0)) {
            uint8 dec = secondary_.decimals();
            if (dec > 18) revert InvalidOracleParams();
            scale = 10 ** (18 - uint256(dec));
        }
        pyth = pyth_;
        priceId = priceId_;
        secondary = secondary_;
        secondaryScale = scale;
        secondaryMaxStaleness = secondaryMaxStaleness_;
        description = description_;
        _setOracleParams(maxStaleness_, maxDeviation_);
    }

    // ───────────────────────────── views ─────────────────────────────

    /// @inheritdoc IOracleAdapter
    function getIndexPrice() external view returns (uint256 priceWad, uint256 updatedAt) {
        Status st;
        (st, priceWad, updatedAt,) = _read();
        if (st == Status.Stale) revert StalePrice();
        if (st == Status.Invalid) revert InvalidPrice();
        if (st == Status.Deviation) revert PriceDeviation();
    }

    /// @inheritdoc IOracleAdapter
    function tryGetIndexPrice() external view returns (bool ok, uint256 priceWad, uint256 updatedAt) {
        Status st;
        (st, priceWad, updatedAt,) = _read();
        ok = st == Status.Ok;
    }

    /// @inheritdoc IOracleAdapter
    function updateFee(bytes[] calldata updateData) external view returns (uint256 feeWei) {
        return pyth.getUpdateFee(updateData);
    }

    // ───────────────────────────── mutations ─────────────────────────────

    /// @inheritdoc IOracleAdapter
    /// @dev Emits PriceUpdated when the resulting price is usable, DeviationGuardTripped when the guard rejects it.
    ///      Never reverts on a bad resulting price, so keepers can always push.
    function updatePrice(bytes[] calldata updateData) external payable nonReentrant {
        uint256 fee = pyth.getUpdateFee(updateData);
        if (msg.value < fee) revert InsufficientUpdateFee();
        pyth.updatePriceFeeds{value: fee}(updateData);

        (Status st, uint256 p, uint256 t, uint256 s) = _read();
        if (st == Status.Ok) emit PriceUpdated(p, t, Source.Primary);
        else if (st == Status.Deviation) emit DeviationGuardTripped(p, s);

        uint256 refund = msg.value - fee;
        if (refund != 0) SafeTransferLib.safeTransferETH(msg.sender, refund);
    }

    /// @notice Set primary staleness (10 s with a Hermes key, 60 s on the sponsored feed) and the guard deviation.
    /// @param maxStalenessSec in [1, 3600] seconds
    /// @param maxDeviationWad in (0, 0.1e18]
    function setOracleParams(uint256 maxStalenessSec, uint256 maxDeviationWad) external onlyOwner {
        _setOracleParams(maxStalenessSec, maxDeviationWad);
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _setOracleParams(uint256 maxStalenessSec, uint256 maxDeviationWad) internal {
        if (maxStalenessSec < MIN_STALENESS || maxStalenessSec > MAX_STALENESS) revert InvalidOracleParams();
        if (maxDeviationWad == 0 || maxDeviationWad > MAX_DEVIATION) revert InvalidOracleParams();
        maxStaleness = maxStalenessSec;
        maxDeviation = maxDeviationWad;
        emit OracleParamsUpdated(maxStalenessSec, maxDeviationWad);
    }

    /// @dev Never reverts on feed failures (both reads are wrapped in try/catch).
    /// @return st status, p primary WAD, t primary publishTime, s secondary WAD (0 if unused)
    function _read() internal view returns (Status st, uint256 p, uint256 t, uint256 s) {
        IPythMinimal.Price memory px;
        try pyth.getPriceUnsafe(priceId) returns (IPythMinimal.Price memory r) {
            px = r;
        } catch {
            return (Status.Stale, 0, 0, 0);
        }
        t = px.publishTime;
        // Future publishTime (Pyth clock ahead of the block) counts as fresh. Subtraction form cannot overflow.
        if (block.timestamp > t && block.timestamp - t > maxStaleness) return (Status.Stale, 0, t, 0);
        if (px.price <= 0 || px.expo < MIN_EXPO || px.expo > 0) return (Status.Invalid, 0, t, 0);
        uint256 raw = uint256(int256(px.price));
        if (uint256(px.conf) * CONF_DIVISOR > raw) return (Status.Invalid, 0, t, 0);
        // MATH_SPEC §0: expo ∈ [−18, 0] ⇒ exact integer scaling, rounds neutral. Max 9.2e18·1e18 < 2^256.
        p = raw * 10 ** uint256(int256(18 + px.expo));

        s = _secondaryPrice();
        // Exact deviation test |p − s| / s > maxDeviation ⇔ |p − s|·1e18 > maxDeviation·s (no division, no rounding).
        // s ≥ 2p is always a deviation (maxDeviation ≤ 10%); otherwise diff < 2p ≤ 1.9e37 keeps both products in range.
        if (s != 0) {
            if (s / 2 >= p) return (Status.Deviation, p, t, s);
            uint256 diff = p > s ? p - s : s - p;
            if (diff * WAD > maxDeviation * s) return (Status.Deviation, p, t, s);
        }
        st = Status.Ok;
    }

    /// @dev Fresh, positive secondary price in WAD, or 0 when the guard is disabled, stale, non-positive or reverting.
    function _secondaryPrice() internal view returns (uint256) {
        if (address(secondary) == address(0)) return 0;
        try secondary.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0) return 0;
            if (block.timestamp > updatedAt && block.timestamp - updatedAt > secondaryMaxStaleness) return 0;
            // Saturate instead of overflowing: an absurd answer must trip the guard, not revert the view.
            if (uint256(answer) > type(uint256).max / secondaryScale) return type(uint256).max;
            return uint256(answer) * secondaryScale;
        } catch {
            return 0;
        }
    }
}
