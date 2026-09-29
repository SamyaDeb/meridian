// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IKuruMarginAccount — subset (external). Source: https://docs.kuru.io/contracts/MarginAccount
/// @notice Mainnet MarginAccount per Kuru docs: 0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5 (verified: holds ~60k AUSD across Kuru markets).
interface IKuruMarginAccount {
    function deposit(address _user, address _token, uint256 _amount) external payable;
    function withdraw(uint256 _amount, address _token) external;
    function getBalance(address _user, address _token) external view returns (uint256);
}
