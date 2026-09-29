// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AggregatorV3Interface — Chainlink push feed (external, standard ABI)
/// @notice Monad mainnet proxies (monad-crypto/protocols chainlink.jsonc; all verified live onchain,
///         8 decimals. MON/USD observed updating every ~minutes, i.e. deviation/heartbeat-driven: guard only):
///         MON/USD 0xBcD78f76005B7515837af6b50c7C52BCf73822fb, ETH/USD 0x1B1414782B859871781bA3E4B0979b9ca57A0A04,
///         AUSD/USD 0xE20751C7B5867bCBef815ffc1b284c3f412a9e13.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
