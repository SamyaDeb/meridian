// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IWrappedNative — WETH9-style wrapper (WMON, ARCHITECTURE R10). External, not ours.
/// @notice `deposit`/`withdraw` are the WETH9 surface; exercised against mainnet WMON by test/fork/KuruHedgerFork.t.sol.
interface IWrappedNative {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}
