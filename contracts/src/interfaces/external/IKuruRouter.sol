// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IKuruRouter — subset (external). Source: https://docs.kuru.io/contracts/Router
/// @notice Mainnet Router (market factory): 0xd651346d7c789536ebf06dc72aE3C8502cd695CC (verified: has code, owner
///         0x8B736DCe2071783Fd9DB0a423dad17cc8ed5788b).
///         OrderBookType: 0 = two ERC20s, 1 = base is native MON, 2 = quote is native MON.
///         deployProxy is NOT permissionless: eth_call from a random EOA reverts Unauthorized() (0x82b42900),
///         verified 2026-09-29. Listing a new market requires the Kuru team (see RISKS T2).
///         kuruAmmSpread: 10–500 bps, multiple of 10 (docs: 100 for volatile, 30 for stable pairs).
interface IKuruRouter {
    function deployProxy(
        uint8 _type,
        address _baseAssetAddress,
        address _quoteAssetAddress,
        uint96 _sizePrecision,
        uint32 _pricePrecision,
        uint32 _tickSize,
        uint96 _minSize,
        uint96 _maxSize,
        uint256 _takerFeeBps,
        uint256 _makerFeeBps,
        uint96 _kuruAmmSpread
    ) external returns (address proxy);

    function anyToAnySwap(
        address[] calldata _marketAddresses,
        bool[] calldata _isBuy,
        bool[] calldata _nativeSend,
        address _debitToken,
        address _creditToken,
        uint256 _amount,
        uint256 _minAmountOut
    ) external payable returns (uint256 _amountOut);
}
