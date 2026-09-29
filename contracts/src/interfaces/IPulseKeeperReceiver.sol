// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IPulseKeeperReceiver — onchain target for Chainlink CRE workflow reports (FROZEN)
/// @notice CRE delivers signed reports through a Chainlink KeystoneForwarder which calls onReport.
///         IReceiver.onReport(bytes metadata, bytes report) confirmed in CRE docs; the forwarder checks ERC-165
///         support first. Monad KeystoneForwarder (CRE Forwarder Directory, verified has code):
///         mainnet 0x76c9cf548b4179F8901cda1f8623568b58215E62 (simulation: 0x9eF6468C5f37b976E57d52054c693269479A784d),
///         testnet 0xF8344CFd5c43616a4366C34E3EEE75af79a74482 (simulation: 0xB9F79d863261869B234c481D1f9A7af84AeAd192).
///         report = abi.encode(uint8 action, bytes payload):
///           1 VAULT_REBALANCE  payload = abi.encode(address vault)
///           2 LIQUIDATE        payload = abi.encode(address clearingHouse, address[] accounts)  (len <= 32)
///           3 FUNDING_POKE     payload = abi.encode(address[] clearingHouses)                    (len <= 32)
///           4 ORACLE_UPDATE    payload = abi.encode(address oracleAdapter, bytes[] updateData)
interface IPulseKeeperReceiver is IERC165 {
    event ReportExecuted(uint8 indexed action, bool success, bytes32 workflowId);
    event ForwarderUpdated(address indexed forwarder);

    error OnlyForwarder();
    error UnknownAction(uint8 action);

    function onReport(bytes calldata metadata, bytes calldata report) external;
    function forwarder() external view returns (address);
    function setForwarder(address forwarder) external;
}
