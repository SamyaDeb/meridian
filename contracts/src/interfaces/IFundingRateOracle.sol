// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IFundingRateOracle — Monad-native, per-block funding rate as a public primitive (FROZEN, CR-003)
/// @notice Implemented by the perp ClearingHouse. Two cumulative indices, both updated O(1) on the first touch
///         per block (MATH_SPEC §1.2, §1.8):
///           F = Σ rate_b · index_b · Δt_b   (quote WAD per 1 base)   — what a 1-unit long has paid
///           G = Σ index_b · Δt_b            (quote WAD · seconds)    — "notional-time" per 1 base
///         ⇒ time-and-price-weighted average rate over any window = ΔF / ΔG (per second, WAD).
///         Checkpoints: one ring-buffer entry every CHECKPOINT_BLOCKS (200 blocks ≈ 60 s), 1440 entries (≈ 24 h).
///         Writes happen inside the funding touch; no loops.
interface IFundingRateOracle {
    event FundingCheckpoint(uint32 indexed slot, uint64 blockNumber, int256 cumFunding, int256 cumIndexTime);

    error ObservationTooOld();

    /// @notice As if the market were touched now (includes not-yet-written accrual).
    function latestObservation() external view returns (int256 cumFunding, int256 cumIndexTime, uint64 blockNumber);
    /// @notice Most recent checkpoint at or before (block.number - blocksAgo). Reverts ObservationTooOld.
    function observe(uint64 blocksAgo)
        external
        view
        returns (int256 cumFunding, int256 cumIndexTime, uint64 observedBlock);
    /// @notice ΔF/ΔG between the checkpoint `blocksAgo` back and now; per-second WAD (signed).
    function averageFundingRate(uint64 blocksAgo) external view returns (int256 ratePerSecondWad);
    /// @notice averageFundingRate * 365 days; WAD (0.1e18 = 10% APR).
    function averageFundingApr(uint64 blocksAgo) external view returns (int256 aprWad);
}
