// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMeridianMfiFeed — the Meridian Funding Index onchain, under Chainlink CRE DON consensus (CR-016, FROZEN)
/// @notice MFI = open-interest-weighted mean of the annualized MON-perp funding rate on Meridian and Perpl
///         (docs/MFI.md §1, §4.2). A CRE workflow computes it from Meridian's `averageFundingApr(12_000)` (EVM read)
///         and Perpl's funding (HTTP, DON consensus) and publishes it through `IMeridianKeeperReceiver` action 6.
///         All APRs are annualized WAD (0.1e18 = 10% APR), positive ⇒ longs pay shorts; rounding neutral (MFI §4.4).
///         Any contract can read `latest()`.
interface IMeridianMfiFeed {
    /// @param blockNumber Monad block the workflow read Meridian at (strictly increasing)
    /// @param perplFundingBlock Monad block of the Perpl funding event used (`FundingEvent.at.b`), 0 if not included
    event MfiPublished(
        int256 mfiAprWad,
        int256 meridianAprWad,
        int256 perplAprWad,
        uint64 indexed blockNumber,
        uint64 perplFundingBlock
    );

    error OnlyReceiver();
    /// @notice A report for a block not after the stored one (stale / replayed), or after the current block.
    error StaleObservation(uint64 got, uint64 last);
    /// @notice |APR| > MAX_ABS_APR_WAD, or the MFI outside [min, max] of the venue APRs.
    error AprOutOfBounds(int256 aprWad);

    /// @notice Receiver only. Venue APRs not included are passed equal to the MFI (Meridian-only: perpl = mfi).
    function publish(
        int256 mfiAprWad,
        int256 meridianAprWad,
        int256 perplAprWad,
        uint64 blockNumber,
        uint64 perplFundingBlock
    ) external;

    /// @return mfiAprWad the index
    /// @return meridianAprWad Meridian 1 h APR
    /// @return perplAprWad Perpl APR
    /// @return blockNumber observation block (0 = never published)
    /// @return perplFundingBlock Perpl funding event block
    function latest()
        external
        view
        returns (
            int256 mfiAprWad,
            int256 meridianAprWad,
            int256 perplAprWad,
            uint64 blockNumber,
            uint64 perplFundingBlock
        );

    function receiver() external view returns (address);
}
