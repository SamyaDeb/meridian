// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IKuruHedger} from "../interfaces/IKuruHedger.sol";
import {MockERC20} from "./MockERC20.sol";
import {PulseConstants} from "../interfaces/PulseTypes.sol";

/// @notice Ignores `route`. Swaps at a settable price by burning/minting MockERC20s (infinite liquidity) minus `spreadWad`
///         on each side. base = 18 dp, quote = 6 dp (AUSD). Rounds output down.
contract MockKuruHedger is IKuruHedger {
    address public immutable baseToken;
    address public immutable quoteToken;
    address public constant kuruMarket = address(0);
    address public constant flowEntrypoint = address(0);
    uint256 public priceWad;
    uint256 public spreadWad; // e.g. 0.0005e18 = 5 bps half-spread

    constructor(address base_, address quote_, uint256 priceWad_) {
        baseToken = base_;
        quoteToken = quote_;
        priceWad = priceWad_;
    }

    function setPrice(uint256 p) external {
        priceWad = p;
    }

    function setSpread(uint256 s) external {
        spreadWad = s;
    }

    function _ask() internal view returns (uint256) {
        return priceWad * (PulseConstants.WAD + spreadWad) / PulseConstants.WAD;
    }

    function _bid() internal view returns (uint256) {
        return priceWad * (PulseConstants.WAD - spreadWad) / PulseConstants.WAD;
    }

    function buySpot(uint256 quoteInToken, uint256 minBaseOut, bytes calldata) external returns (uint256 baseOut) {
        MockERC20(quoteToken).burn(msg.sender, quoteInToken);
        baseOut = quoteInToken * PulseConstants.AUSD_TO_WAD * PulseConstants.WAD / _ask();
        if (baseOut < minBaseOut) revert SlippageExceeded();
        MockERC20(baseToken).mint(msg.sender, baseOut);
        emit SpotBought(msg.sender, quoteInToken, baseOut, _ask());
    }

    function sellSpot(uint256 baseIn, uint256 minQuoteOut, bytes calldata) external returns (uint256 quoteOut) {
        MockERC20(baseToken).burn(msg.sender, baseIn);
        quoteOut = baseIn * _bid() / PulseConstants.WAD / PulseConstants.AUSD_TO_WAD;
        if (quoteOut < minQuoteOut) revert SlippageExceeded();
        MockERC20(quoteToken).mint(msg.sender, quoteOut);
        emit SpotSold(msg.sender, baseIn, quoteOut, _bid());
    }

    function bestBidAsk() external view returns (uint256, uint256) {
        return (_bid(), _ask());
    }
}
