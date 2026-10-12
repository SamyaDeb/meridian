// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPerplExchange — the subset of Perpl's Exchange that PerplFundingSource reads (external, CR-017)
/// @notice Copied from the vendored ABI `indexer/abis/PerplExchange.json` (dex-sdk dbb37c5, contract 1.7.5): only the
///         two views and the one event the adapter relies on. Testnet exchange (ERC-1967 proxy)
///         0x1964c32f0be608e7d29302aff5e61268e72080cc (`deployments/perpl.json`).
///         Units (docs/PERPL_SWAPS.md §Units, verified 12 Oct 2026 on 10143 perp 64):
///         - `fundingSumPNS` is a per-1-lot cumulative funding sum in price units ×10^fundingSumScalingExp; it RISES
///           when longs pay. F_wad = fundingSumPNS · 10^(18 − priceDecimals − fundingSumScalingExp).
///         - `fundingEventBlock` (feb) is the block a funding event applies from; the sum for feb is written ~78 blocks
///           earlier but `getFundingSumAtBlock(perp, b)` only returns it for b ≥ feb.
///         - `fundingRatePct100k`, `absFundingClampPctPer100K`: fraction of notional per funding interval ×1e5.
///         - `oraclePNS` / `markPNS`: price ×10^priceDecimals; `oracleTimestampSec`: unix seconds.
interface IPerplExchange {
    struct PerpetualInfoV2 {
        string name;
        string symbol;
        uint256 priceDecimals;
        uint256 lotDecimals;
        bytes32 linkFeedId;
        uint256 priceTolPer100K;
        uint256 marginTol;
        uint256 marginTolDecimals;
        uint256 refPriceMaxAgeSec;
        uint256 positionBalanceCNS;
        uint256 insuranceBalanceCNS;
        uint256 markPNS;
        uint256 markTimestamp;
        uint256 lastPNS;
        uint256 lastTimestamp;
        uint256 oraclePNS;
        uint256 oracleTimestampSec;
        uint256 longOpenInterestLNS;
        uint256 shortOpenInterestLNS;
        uint256 fundingStartBlock;
        int16 fundingRatePct100k;
        uint256 absFundingClampPctPer100K;
        uint8 status;
        uint256 basePricePNS;
        uint256 maxBidPriceONS;
        uint256 minBidPriceONS;
        uint256 maxAskPriceONS;
        uint256 minAskPriceONS;
        uint256 numOrders;
        bool ignOracle;
        uint256 fundingSumScalingExp;
    }

    event FundingEventCompleted(
        uint256 perpId,
        uint256 fundingEventBlock,
        int256 specifiedRatePct100k,
        int256 actualRatePct100k,
        uint256 fundingPricePNS,
        int48 fundingPaymentPNS,
        int48 fundingSumPNS,
        bool allowOverwrite
    );

    /// @notice Cumulative funding sum of the latest funding event at or before `blockNumber`, and that event's block.
    function getFundingSumAtBlock(uint256 perpId, uint256 blockNumber)
        external
        view
        returns (int48 fundingSumPNS, uint256 fundingEventBlock);

    /// @notice Funding interval in blocks (8,571 on 10143 and 143). `pure` in Perpl's ABI; declared `view` here so a
    ///         mock can script it (same selector, called with STATICCALL either way).
    function getFundingInterval() external view returns (uint256 fundingInterval);

    function getPerpetualInfoV2(uint256 perpId) external view returns (PerpetualInfoV2 memory perpetualInfo);
}
