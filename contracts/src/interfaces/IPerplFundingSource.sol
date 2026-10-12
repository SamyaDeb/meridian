// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFundingRateOracle} from "./IFundingRateOracle.sol";
import {FundingParams, FundingState} from "./MeridianTypes.sol";

/// @title IPerplFundingSource — Perpl's per-interval funding as a Meridian funding source (CR-017, interfaces-v1.9)
/// @notice A `FundingSwapMarket` reads its floating leg through seven views on the address it was deployed with
///         (`latestObservation`, `observe`, `averageFundingRate`, `averageFundingApr`, `indexPrice`,
///         `fundingParams().rateCap`, `fundingState().rate`). This adapter answers them from snapshots of one Perpl
///         perpetual, so a second swap market can settle on Perpl's funding without any change to the swap market.
///         - `poke()` (permissionless) snapshots Perpl's cumulative funding sum when a new funding event has applied:
///           F = fundingSumPNS · 10^(18 − priceDecimals − fundingSumScalingExp) (quote WAD per 1 base, rises when
///           longs pay, same convention as the ClearingHouse), and G += I · Δfeb · intervalSec / intervalBlocks with
///           I = Perpl's oracle price at the poke. F and G step together, once per Perpl funding event.
///         - Every view answers from storage only (no call into Perpl); nothing is extrapolated.
///         - Checkpoints: one ring entry per poke that advances, RING_SIZE entries, observation block = the Perpl
///           funding event block (feb). MATH_SPEC §6.8.
interface IPerplFundingSource is IFundingRateOracle {
    /// @notice A new Perpl funding event was snapshotted.
    /// @param cumFunding F after the poke (quote WAD per 1 base)
    /// @param cumIndexTime G after the poke (quote WAD · seconds per 1 base)
    /// @param fundingEventBlock Perpl's funding event block the snapshot is as of
    /// @param priceWad I used for this step of G (Perpl oracle price, WAD)
    /// @param rate Perpl's current funding rate as a per-second WAD rate
    event Poked(int256 cumFunding, uint256 cumIndexTime, uint64 fundingEventBlock, uint256 priceWad, int256 rate);

    /// @notice Perpl's oracle price is older than MAX_PRICE_AGE (or zero): nothing is written, F and G pause together.
    error StalePerplPrice(uint256 oracleTimestampSec);
    /// @notice Perpl changed the market's priceDecimals or fundingSumScalingExp since deploy: the sum's unit moved.
    error PerplScaleChanged();
    /// @notice Constructor bounds: zero exchange, decimals + scaling exponent > 18, zero interval.
    error InvalidParams();

    /// @notice Snapshot Perpl's funding if a new funding event has applied since the last snapshot. Permissionless.
    /// @return advanced true if a new observation was written (false = no new funding event, nothing changed)
    function poke() external returns (bool advanced);

    /// @notice Perpl Exchange (proxy) this adapter reads.
    function exchange() external view returns (address);
    /// @notice Perpl perpetual id (testnet MON = 64).
    function perpId() external view returns (uint256);
    /// @notice Perpl funding interval in blocks (read at deploy).
    function fundingIntervalBlocks() external view returns (uint256);
    /// @notice Perpl funding interval in seconds (deploy parameter, `deployments/perpl.json`).
    function fundingIntervalSec() external view returns (uint256);
    /// @notice F_wad = fundingSumPNS · sumScale.
    function sumScale() external view returns (uint256);
    /// @notice Block of the last poke that wrote an observation.
    function lastPokeBlock() external view returns (uint64);
    /// @notice Raw ring entry `slot` (for indexers and invariant handlers).
    function checkpointAt(uint256 slot)
        external
        view
        returns (int256 cumFunding, int256 cumIndexTime, uint64 blockNumber);
    /// @notice Index of the newest ring entry.
    function checkpointIndex() external view returns (uint256);

    /// @notice Perpl oracle price at the last poke (WAD). Same selector as IClearingHouse.indexPrice.
    function indexPrice() external view returns (uint256 priceWad);
    /// @notice Same ABI as IClearingHouse.fundingParams. Only `rateCap` is meaningful (Perpl's clamp per second WAD,
    ///         with a price-basis buffer); `blockTimeMs` = intervalSec·1000/intervalBlocks; every other field is 0.
    function fundingParams() external view returns (FundingParams memory);
    /// @notice Same ABI as IClearingHouse.fundingState: (F, G, 0, Perpl's rate per second WAD, feb).
    function fundingState() external view returns (FundingState memory);
}
