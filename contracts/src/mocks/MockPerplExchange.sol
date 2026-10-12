// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPerplExchange} from "../interfaces/external/IPerplExchange.sol";

/// @notice Scripted Perpl Exchange for PerplFundingSource tests: funding events are pushed by hand as
///         (fundingEventBlock, fundingSumPNS); `getFundingSumAtBlock(perp, b)` returns the latest event with feb ≤ b,
///         like the real exchange (docs/PERPL_SWAPS.md §Units). Prices and market info are set directly. Bounded:
///         at most MAX_EVENTS events per perp, scanned newest first.
contract MockPerplExchange is IPerplExchange {
    uint256 public constant MAX_EVENTS = 512;

    struct Ev {
        uint256 feb;
        int48 sum;
    }

    uint256 public fundingInterval = 8571;
    mapping(uint256 => Ev[]) internal _events;
    mapping(uint256 => PerpetualInfoV2) internal _info;

    constructor(uint256 perpId, uint256 priceDecimals, uint256 scalingExp) {
        PerpetualInfoV2 storage i = _info[perpId];
        i.name = "MON Perp";
        i.symbol = "MON";
        i.priceDecimals = priceDecimals;
        i.fundingSumScalingExp = scalingExp;
        i.absFundingClampPctPer100K = 10;
        i.refPriceMaxAgeSec = 60;
    }

    // ─── scripting ──────────────────────────────────────────────────────────────
    function pushEvent(uint256 perpId, uint256 feb, int48 sum) external {
        Ev[] storage e = _events[perpId];
        require(e.length < MAX_EVENTS, "mock: too many events");
        require(e.length == 0 || feb > e[e.length - 1].feb, "mock: feb order");
        e.push(Ev(feb, sum));
    }

    function setPrice(uint256 perpId, uint256 oraclePNS, uint256 oracleTimestampSec) external {
        _info[perpId].oraclePNS = oraclePNS;
        _info[perpId].markPNS = oraclePNS;
        _info[perpId].oracleTimestampSec = oracleTimestampSec;
    }

    function setRate(uint256 perpId, int16 ratePct100k, uint256 clampPct100k) external {
        _info[perpId].fundingRatePct100k = ratePct100k;
        _info[perpId].absFundingClampPctPer100K = clampPct100k;
    }

    function setScale(uint256 perpId, uint256 priceDecimals, uint256 scalingExp) external {
        _info[perpId].priceDecimals = priceDecimals;
        _info[perpId].fundingSumScalingExp = scalingExp;
    }

    function setFundingInterval(uint256 blocks) external {
        fundingInterval = blocks;
    }

    // ─── IPerplExchange ─────────────────────────────────────────────────────────
    function getFundingSumAtBlock(uint256 perpId, uint256 blockNumber) external view returns (int48, uint256) {
        Ev[] storage e = _events[perpId];
        for (uint256 i = e.length; i > 0; --i) {
            if (e[i - 1].feb <= blockNumber) return (e[i - 1].sum, e[i - 1].feb);
        }
        return (0, 0);
    }

    function getFundingInterval() external view returns (uint256) {
        return fundingInterval;
    }

    function getPerpetualInfoV2(uint256 perpId) external view returns (PerpetualInfoV2 memory) {
        return _info[perpId];
    }
}
