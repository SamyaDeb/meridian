// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IOracleAdapter} from "../interfaces/IOracleAdapter.sol";

/// @title TestnetKeeperOracle — TESTNET ONLY, keeper-fed index price
/// @notice Fallback for Monad testnet (10143) while no Pyth Hermes key is available (PHASES decision 10: the testnet
///         Pyth MON/USD feed is not pushed). An allow-listed feeder (the keeper) pushes `(priceWad, publishTime)` read
///         from a keyless public source (mainnet Pyth MON/USD via `getPriceUnsafe`, fallback Hyperliquid `allMids`;
///         see keepers/RUNBOOK.md). Staleness semantics match PythChainlinkOracleAdapter: older than `maxStaleness`
///         ⇒ `StalePrice` / `ok = false`; a publish time in the future counts as fresh. There is no secondary guard;
///         `maxDeviation` is reported for interface parity and not enforced.
/// @dev The constructor only accepts Monad testnet (10143) and local anvil (31337), so this contract can never be
///      deployed on mainnet (143) or any other chain.
contract TestnetKeeperOracle is IOracleAdapter, Ownable, ReentrancyGuardTransient {
    uint256 public constant TESTNET_CHAIN_ID = 10_143;
    uint256 public constant ANVIL_CHAIN_ID = 31_337;
    uint256 public constant MIN_STALENESS = 1;
    uint256 public constant MAX_STALENESS = 1 hours;
    uint256 public constant MAX_DEVIATION = 0.1e18;
    /// @notice Human-readable label shown by explorers / the app.
    string public constant name = unicode"TESTNET ONLY – keeper-fed";

    uint256 public maxStaleness;
    uint256 public maxDeviation;
    string public description;
    mapping(address => bool) public isFeeder;

    uint128 internal _price;
    uint128 internal _publishTime;

    event FeederSet(address indexed feeder, bool allowed);

    constructor(address owner_, uint256 maxStaleness_, uint256 maxDeviation_, string memory market_) Ownable(owner_) {
        if (block.chainid != TESTNET_CHAIN_ID && block.chainid != ANVIL_CHAIN_ID) revert InvalidOracleParams();
        description = string.concat(name, " ", market_);
        _setOracleParams(maxStaleness_, maxDeviation_);
    }

    modifier onlyFeeder() {
        if (!isFeeder[msg.sender]) revert OwnableUnauthorizedAccount(msg.sender);
        _;
    }

    // ───────────────────────────── views ─────────────────────────────

    /// @inheritdoc IOracleAdapter
    function getIndexPrice() external view returns (uint256 priceWad, uint256 updatedAt) {
        bool fresh;
        (fresh, priceWad, updatedAt) = _read();
        if (priceWad == 0) revert InvalidPrice();
        if (!fresh) revert StalePrice();
    }

    /// @inheritdoc IOracleAdapter
    function tryGetIndexPrice() external view returns (bool ok, uint256 priceWad, uint256 updatedAt) {
        bool fresh;
        (fresh, priceWad, updatedAt) = _read();
        ok = fresh && priceWad != 0;
    }

    /// @inheritdoc IOracleAdapter
    /// @dev No fee: the feeder pays gas only.
    function updateFee(bytes[] calldata) external pure returns (uint256) {
        return 0;
    }

    /// @notice Last pushed price (WAD) and its publish time, regardless of staleness.
    function latest() external view returns (uint256 priceWad, uint256 publishTime) {
        return (_price, _publishTime);
    }

    // ───────────────────────────── mutations ─────────────────────────────

    /// @notice Feeder push. `publishTime` must not go backwards (an old observation never overwrites a newer one).
    /// @param priceWad quote per base, WAD, in (0, uint128.max]
    /// @param publishTime unix seconds of the source observation
    function pushPrice(uint256 priceWad, uint256 publishTime) external onlyFeeder {
        _push(priceWad, publishTime);
    }

    /// @inheritdoc IOracleAdapter
    /// @dev Same as `pushPrice` with `updateData[updateData.length − 1] = abi.encode(priceWad, publishTime)`, so a
    ///      keeper written against the Pyth adapter works unchanged. Any msg.value is refunded (fee is 0).
    function updatePrice(bytes[] calldata updateData) external payable onlyFeeder nonReentrant {
        if (updateData.length == 0) revert InvalidPrice();
        (uint256 priceWad, uint256 publishTime) = abi.decode(updateData[updateData.length - 1], (uint256, uint256));
        _push(priceWad, publishTime);
        if (msg.value != 0) SafeTransferLib.safeTransferETH(msg.sender, msg.value);
    }

    /// @notice Allow or revoke a feeder (the keeper hot key).
    function setFeeder(address feeder, bool allowed) external onlyOwner {
        if (feeder == address(0)) revert InvalidOracleParams();
        isFeeder[feeder] = allowed;
        emit FeederSet(feeder, allowed);
    }

    /// @notice Same bounds as the Pyth adapter (CR-005): maxStaleness ∈ [1, 3600] s, maxDeviation ∈ (0, 10%].
    function setOracleParams(uint256 maxStalenessSec, uint256 maxDeviationWad) external onlyOwner {
        _setOracleParams(maxStalenessSec, maxDeviationWad);
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _push(uint256 priceWad, uint256 publishTime) internal {
        if (priceWad == 0 || priceWad > type(uint128).max || publishTime > type(uint128).max) revert InvalidPrice();
        if (publishTime < _publishTime) revert StalePrice();
        _price = uint128(priceWad);
        _publishTime = uint128(publishTime);
        emit PriceUpdated(priceWad, publishTime, Source.Primary);
    }

    function _setOracleParams(uint256 maxStalenessSec, uint256 maxDeviationWad) internal {
        if (maxStalenessSec < MIN_STALENESS || maxStalenessSec > MAX_STALENESS) revert InvalidOracleParams();
        if (maxDeviationWad == 0 || maxDeviationWad > MAX_DEVIATION) revert InvalidOracleParams();
        maxStaleness = maxStalenessSec;
        maxDeviation = maxDeviationWad;
        emit OracleParamsUpdated(maxStalenessSec, maxDeviationWad);
    }

    /// @return fresh within maxStaleness (a future publish time is fresh) @return p price @return t publish time
    function _read() internal view returns (bool fresh, uint256 p, uint256 t) {
        p = _price;
        t = _publishTime;
        fresh = t != 0 && (t >= block.timestamp || block.timestamp - t <= maxStaleness);
    }
}
