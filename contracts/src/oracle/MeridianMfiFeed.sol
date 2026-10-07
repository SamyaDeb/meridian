// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMeridianMfiFeed} from "../interfaces/IMeridianMfiFeed.sol";

/// @title MeridianMfiFeed — the Meridian Funding Index onchain (CR-016)
/// @notice Written only by `receiver` (MeridianKeeperReceiver action 6 MFI_PUBLISH, i.e. a DON-signed Chainlink CRE
///         report); read by anyone through `latest()`. Each update must observe a strictly later Monad block than the
///         stored one and not a future block (stale / replayed reports rejected), each APR stays within
///         ± MAX_ABS_APR_WAD, and the index lies between the two venue APRs (it is their OI-weighted mean,
///         docs/MFI.md §4.2). Values are stored as published: rounding neutral, done by the workflow (MFI §4.4).
contract MeridianMfiFeed is IMeridianMfiFeed {
    /// @notice 1000% APR: far beyond any funding rate the venues can print (Meridian's rate cap is ≈ 1752% APR only
    ///         at the clamp; Perpl recorded ±49%), so only a broken input trips it.
    int256 public constant MAX_ABS_APR_WAD = 10e18;

    /// @inheritdoc IMeridianMfiFeed
    address public immutable receiver;

    struct Observation {
        int256 mfiAprWad;
        int256 meridianAprWad;
        int256 perplAprWad;
        uint64 blockNumber;
        uint64 perplFundingBlock;
    }

    Observation internal _latest;

    constructor(address receiver_) {
        receiver = receiver_;
    }

    /// @inheritdoc IMeridianMfiFeed
    function publish(
        int256 mfiAprWad,
        int256 meridianAprWad,
        int256 perplAprWad,
        uint64 blockNumber,
        uint64 perplFundingBlock
    ) external {
        if (msg.sender != receiver) revert OnlyReceiver();
        uint64 last = _latest.blockNumber;
        if (blockNumber <= last || blockNumber > block.number) revert StaleObservation(blockNumber, last);
        _bound(meridianAprWad);
        _bound(perplAprWad);
        (int256 lo, int256 hi) =
            meridianAprWad < perplAprWad ? (meridianAprWad, perplAprWad) : (perplAprWad, meridianAprWad);
        if (mfiAprWad < lo || mfiAprWad > hi) revert AprOutOfBounds(mfiAprWad);
        _latest = Observation(mfiAprWad, meridianAprWad, perplAprWad, blockNumber, perplFundingBlock);
        emit MfiPublished(mfiAprWad, meridianAprWad, perplAprWad, blockNumber, perplFundingBlock);
    }

    /// @inheritdoc IMeridianMfiFeed
    function latest() external view returns (int256, int256, int256, uint64, uint64) {
        Observation memory o = _latest;
        return (o.mfiAprWad, o.meridianAprWad, o.perplAprWad, o.blockNumber, o.perplFundingBlock);
    }

    function _bound(int256 aprWad) internal pure {
        if (aprWad > MAX_ABS_APR_WAD || aprWad < -MAX_ABS_APR_WAD) revert AprOutOfBounds(aprWad);
    }
}
