// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IMeridianKeeperReceiver — onchain target for Chainlink CRE workflow reports (FROZEN)
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
///           5 UNWIND           payload = abi.encode(address clearingHouse, uint256 maxSizeWad)    (CR-016)
///           6 MFI_PUBLISH      payload = abi.encode(address feed, int256 mfiAprWad, int256 meridianAprWad,
///                                                   int256 perplAprWad, uint64 blockNumber, uint64 perplFundingBlock)
///                                                                                                 (CR-016)
///         metadata (production KeystoneForwarder) = workflowId (32) ‖ workflowName (10) ‖ workflowOwner (20) ‖
///         reportId (2) = 64 bytes; the simulation forwarder may pass less.
interface IMeridianKeeperReceiver is IERC165 {
    event ReportExecuted(uint8 indexed action, bool success, bytes32 workflowId);
    event ForwarderUpdated(address indexed forwarder);
    /// @notice CR-016: the receiver's reduce-only IOC on the position it inherited from LIQUIDATE.
    event Unwound(address indexed clearingHouse, bool isBid, uint64 lotsRequested, uint64 lotsFilled);
    /// @notice CR-016: zero = that check is off (simulation: the mock forwarder carries no owner / name).
    event ExpectedWorkflowUpdated(address workflowOwner, bytes32 workflowId);

    error OnlyForwarder();
    error UnknownAction(uint8 action);
    /// @notice CR-016: metadata's workflow owner (bytes 42..62) differs from the expected one (or metadata < 62 bytes).
    error InvalidWorkflowOwner(address got);
    /// @notice CR-016: metadata's workflowId (bytes 0..32) differs from the expected one (or metadata < 62 bytes).
    error InvalidWorkflowId(bytes32 got);

    function onReport(bytes calldata metadata, bytes calldata report) external;
    function forwarder() external view returns (address);
    function setForwarder(address forwarder) external;

    // ─── CR-016 (interfaces-v1.8) ──────────────────────────────────────────────
    /// @notice Owner: workflow identity required in every report's metadata (production delivery). Zero disables.
    function setExpectedWorkflow(address workflowOwner, bytes32 workflowId) external;
    function expectedWorkflowOwner() external view returns (address);
    function expectedWorkflowId() external view returns (bytes32);
    /// @notice Owner: withdraw the receiver's margin from `clearingHouse` (AUSD token units) and send it to `to`.
    function withdrawMargin(address clearingHouse, uint256 amountToken, address to) external;
    /// @notice Owner: recover ERC-20s / MON held by the receiver.
    function sweepToken(address token, address to, uint256 amount) external;
    function sweepNative(address payable to, uint256 amount) external;
}
