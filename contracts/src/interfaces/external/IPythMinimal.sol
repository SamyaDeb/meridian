// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPythMinimal — subset of Pyth's IPyth (external). WS-03 may swap for @pythnetwork/pyth-sdk-solidity.
/// @notice Monad mainnet Pyth: 0x2880aB155794e7179c9eE2e38200202908C17B43 (monad-crypto/protocols, VERIFY).
interface IPythMinimal {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory price);
    function getPriceUnsafe(bytes32 id) external view returns (Price memory price);
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount);
    function updatePriceFeeds(bytes[] calldata updateData) external payable;
}
