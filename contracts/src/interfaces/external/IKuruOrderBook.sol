// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IKuruOrderBook — subset of Kuru's OrderBook used by KuruHedger (external, not ours)
/// @notice Signatures taken from the kuru-sdk ABI (github.com/Kuru-Labs/kuru-sdk abi/OrderBook.json) and
///         VERIFIED by a mainnet-fork buy+sell on MON/USDC (2026-09-29, see docs/ARCHITECTURE.md R17).
///         NOTE: docs.kuru.io is WRONG on several points (minOut width, return values, bestBidAsk types) — CR-001.
///         Units (verified on fork):
///           - placeAndExecuteMarketBuy._quoteSize : quote amount in market pricePrecision units
///             (MON/USDC pricePrecision = 1e8 ⇒ 10 USDC = 1e9). Pulls quote via transferFrom when !_isMargin.
///           - placeAndExecuteMarketSell._size     : base amount in market sizePrecision units (1e10 on MON markets);
///             for native-MON-base markets send msg.value = size * 1e18 / sizePrecision.
///           - return value                         : amount received, in the output token's native decimals.
///           - bestBidAsk / getL2Book prices        : 1e18-scaled (bestBidAsk) / pricePrecision-scaled (L2 book).
interface IKuruOrderBook {
    event Trade(
        uint40 orderId,
        address makerAddress,
        bool isBuy,
        uint256 price,
        uint96 updatedSize,
        address takerAddress,
        address txOrigin,
        uint96 filledSize
    );

    function addBuyOrder(uint32 _price, uint96 _size, bool _postOnly) external;
    function addSellOrder(uint32 _price, uint96 _size, bool _postOnly) external;
    function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill)
        external
        payable
        returns (uint256);
    function placeAndExecuteMarketSell(uint96 _size, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill)
        external
        payable
        returns (uint256);
    function batchCancelOrders(uint40[] calldata _orderIds) external;
    /// @return bestBid 1e18-scaled (type(uint256).max / 0 patterns seen on empty books — treat as "no quote")
    function bestBidAsk() external view returns (uint256, uint256);
    /// @return pricePrecision, sizePrecision, baseAsset, baseAssetDecimals, quoteAsset, quoteAssetDecimals,
    ///         tickSize, minSize, maxSize, takerFeeBps, makerFeeBps
    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256);
    function getL2Book() external view returns (bytes memory);
}
