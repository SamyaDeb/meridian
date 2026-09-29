// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IOracleAdapter — index price for one market (FROZEN)
/// @notice Primary: Pyth pull feed (pushed by keeper/MM bot). Secondary: Chainlink push feed used as a
///         deviation guard. Both VERIFY'd live on Monad mainnet (see docs/ARCHITECTURE.md §Research).
interface IOracleAdapter {
    enum Source {
        Primary,
        Secondary
    }

    event PriceUpdated(uint256 priceWad, uint256 publishTime, Source source);
    event DeviationGuardTripped(uint256 primaryWad, uint256 secondaryWad);
    event OracleParamsUpdated(uint256 maxStalenessSec, uint256 maxDeviationWad);

    error StalePrice();
    error InvalidPrice();
    error PriceDeviation();
    error InsufficientUpdateFee();
    /// @notice Constructor/setter bounds violated (CR-005): maxStaleness ∈ [1, 3600] s, maxDeviation ∈ (0, 10%].
    error InvalidOracleParams();

    /// @notice Reverts StalePrice / InvalidPrice / PriceDeviation.
    /// @return priceWad quote per base, WAD
    /// @return updatedAt unix seconds of the observation
    function getIndexPrice() external view returns (uint256 priceWad, uint256 updatedAt);
    /// @notice Non-reverting variant used by the ClearingHouse to degrade gracefully.
    function tryGetIndexPrice() external view returns (bool ok, uint256 priceWad, uint256 updatedAt);
    /// @notice Push primary-source update data (Pyth). msg.value must cover updateFee(data); excess refunded.
    function updatePrice(bytes[] calldata updateData) external payable;
    function updateFee(bytes[] calldata updateData) external view returns (uint256 feeWei);

    function maxStaleness() external view returns (uint256 sec);
    function maxDeviation() external view returns (uint256 wad);
    function description() external view returns (string memory);
}
