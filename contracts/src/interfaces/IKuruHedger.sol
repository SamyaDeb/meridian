// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IKuruHedger — stateless spot-leg adapter to one Kuru market (FROZEN)
/// @notice Vault transfers tokens in; hedger swaps and returns output to the vault in the same call. Holds no
///         balances between calls. CR-002: `route` empty ⇒ direct market order on the configured Kuru market;
///         non-empty ⇒ low-level call ONLY to the KuruFlowEntrypoint with keeper-supplied calldata
///         (ws.kuru.io/api/quote), exact-amount approval reset to 0 afterwards, output verified by balance delta
///         >= minOut. Native MON is wrapped to WMON before returning. Kuru ABI: external/IKuruOrderBook.sol.
interface IKuruHedger {
    event SpotBought(address indexed vault, uint256 quoteInToken, uint256 baseOut, uint256 avgPriceWad);
    event SpotSold(address indexed vault, uint256 baseIn, uint256 quoteOutToken, uint256 avgPriceWad);

    error OnlyVault();
    error SlippageExceeded();
    error RouteCallFailed();
    /// @notice Constructor / one-shot vault wiring: zero address or already set (CR-009, additive).
    error InvalidParams();

    /// @param quoteInToken AUSD (6 dp) pulled from msg.sender
    /// @return baseOut base token units (WMON, 18 dp) sent to msg.sender
    function buySpot(uint256 quoteInToken, uint256 minBaseOut, bytes calldata route) external returns (uint256 baseOut);
    /// @param baseIn base token units pulled from msg.sender
    /// @return quoteOutToken AUSD (6 dp) sent to msg.sender
    function sellSpot(uint256 baseIn, uint256 minQuoteOut, bytes calldata route)
        external
        returns (uint256 quoteOutToken);

    /// @return bidWad best bid, WAD (0 if none) @return askWad best ask, WAD (max if none)
    function bestBidAsk() external view returns (uint256 bidWad, uint256 askWad);
    function kuruMarket() external view returns (address);
    function flowEntrypoint() external view returns (address);
    function baseToken() external view returns (address);
    function quoteToken() external view returns (address);
}
