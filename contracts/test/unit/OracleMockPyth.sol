// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPythMinimal} from "../../src/interfaces/external/IPythMinimal.sol";

/// @notice Test double for Pyth: settable price per id, fixed per-update fee, optional revert on reads.
/// `updatePriceFeeds` decodes each update as abi.encode(id, price, conf, expo, publishTime).
contract OracleMockPyth is IPythMinimal {
    error PriceFeedNotFound();
    error InsufficientFee();

    uint256 public feePerUpdate;
    bool public revertOnRead;
    mapping(bytes32 => Price) internal _prices;

    constructor(uint256 feePerUpdate_) {
        feePerUpdate = feePerUpdate_;
    }

    function setPrice(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) external {
        _prices[id] = Price(price, conf, expo, publishTime);
    }

    function setRevertOnRead(bool r) external {
        revertOnRead = r;
    }

    function getPriceUnsafe(bytes32 id) public view returns (Price memory p) {
        if (revertOnRead) revert PriceFeedNotFound();
        p = _prices[id];
        if (p.publishTime == 0) revert PriceFeedNotFound();
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory p) {
        p = getPriceUnsafe(id);
        require(p.publishTime + age >= block.timestamp, "stale");
    }

    function getUpdateFee(bytes[] calldata updateData) public view returns (uint256) {
        return feePerUpdate * updateData.length;
    }

    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        if (msg.value < getUpdateFee(updateData)) revert InsufficientFee();
        for (uint256 i; i < updateData.length; ++i) {
            (bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) =
                abi.decode(updateData[i], (bytes32, int64, uint64, int32, uint256));
            _prices[id] = Price(price, conf, expo, publishTime);
        }
    }
}
