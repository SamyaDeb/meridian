// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// DEFERRED (CR-003, 29 Sep 2026): PT/YT is out of hackathon scope, replaced by IFundingSwapMarket. Kept for post-hackathon.
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title IPrincipalToken — PT for one maturity (FROZEN). 18 decimals, 1 PT = claim on 1 AUSD at maturity.
interface IPrincipalToken is IERC20Metadata {
    function tokenizer() external view returns (address);
    function maturity() external view returns (uint256);
    /// @notice onlyTokenizer
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}
