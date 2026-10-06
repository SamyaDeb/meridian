// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IKuruHedger} from "../interfaces/IKuruHedger.sol";
import {IKuruOrderBook} from "../interfaces/external/IKuruOrderBook.sol";
import {IWrappedNative} from "./IWrappedNative.sol";

/// @title KuruHedger — stateless spot leg for the MeridianVault (CR-001, CR-002)
/// @notice Empty `route` ⇒ a market order on the configured Kuru market (native-MON base, `quoteToken` quote; the
///         only shape verified on a mainnet fork, ARCHITECTURE R17). Non-empty ⇒ a low-level call ONLY to the
///         KuruFlowEntrypoint with the keeper-supplied calldata (ws.kuru.io/api/quote), with an exact-amount
///         approval reset to 0 afterwards. Either way the output is measured by balance delta and must be ≥ the
///         vault's `minOut` (Kuru's own minOut is passed as 0: its units are not verified). Native MON output is
///         wrapped to WMON; every leftover goes back to the vault, so the hedger holds nothing between calls.
contract KuruHedger is IKuruHedger, Ownable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @inheritdoc IKuruHedger
    address public immutable kuruMarket;
    /// @inheritdoc IKuruHedger
    address public immutable flowEntrypoint;
    /// @inheritdoc IKuruHedger
    address public immutable baseToken; // WMON
    /// @inheritdoc IKuruHedger
    address public immutable quoteToken;
    /// @dev Kuru market precisions (0 when no direct market is configured).
    uint256 public immutable pricePrecision;
    uint256 public immutable sizePrecision;
    uint256 internal immutable _quoteUnit; // 10^quoteDecimals

    /// @notice The only caller (set once, after the vault is deployed).
    address public vault;

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    /// @param kuruMarket_ Kuru OrderBook with native-MON base and `quoteToken_` quote; address(0) = Flow routes only
    constructor(address owner_, address baseToken_, address quoteToken_, address flowEntrypoint_, address kuruMarket_)
        Ownable(owner_)
    {
        if (baseToken_ == address(0) || quoteToken_ == address(0) || flowEntrypoint_ == address(0)) {
            revert InvalidParams();
        }
        uint256 pp;
        uint256 sp;
        if (kuruMarket_ != address(0)) {
            (uint32 p, uint96 s, address base,, address quote,,,,,,) = IKuruOrderBook(kuruMarket_).getMarketParams();
            if (base != address(0) || quote != quoteToken_ || p == 0 || s == 0) revert InvalidParams();
            (pp, sp) = (p, s);
        }
        (kuruMarket, flowEntrypoint, baseToken, quoteToken) = (kuruMarket_, flowEntrypoint_, baseToken_, quoteToken_);
        (pricePrecision, sizePrecision) = (pp, sp);
        _quoteUnit = 10 ** IERC20Metadata(quoteToken_).decimals();
    }

    /// @notice One-shot wiring (the vault's constructor needs this hedger's address).
    function setVault(address vault_) external onlyOwner {
        if (vault != address(0) || vault_ == address(0)) revert InvalidParams();
        vault = vault_;
    }

    /// @dev Native MON arrives from Kuru (market buys) or from WMON.withdraw (unwrap before a direct sell).
    receive() external payable {}

    /// @inheritdoc IKuruHedger
    function buySpot(uint256 quoteInToken, uint256 minBaseOut, bytes calldata route)
        external
        onlyVault
        nonReentrant
        returns (uint256 baseOut)
    {
        IERC20 quote = IERC20(quoteToken);
        quote.safeTransferFrom(msg.sender, address(this), quoteInToken);
        uint256 base0 = IERC20(baseToken).balanceOf(address(this));
        uint256 native0 = address(this).balance;
        if (route.length == 0) {
            if (kuruMarket == address(0)) revert RouteCallFailed();
            // Kuru quote size is in pricePrecision units (R17: 10 USDC = 1e9 at 1e8), rounds down
            uint96 quoteSize = uint96(quoteInToken * pricePrecision / _quoteUnit);
            quote.forceApprove(kuruMarket, quoteInToken);
            IKuruOrderBook(kuruMarket).placeAndExecuteMarketBuy(quoteSize, 0, false, false);
            quote.forceApprove(kuruMarket, 0);
        } else {
            _flow(quote, quoteInToken, route);
        }
        uint256 native = address(this).balance - native0;
        if (native != 0) IWrappedNative(baseToken).deposit{value: native}();
        baseOut = IERC20(baseToken).balanceOf(address(this)) - base0;
        if (baseOut < minBaseOut) revert SlippageExceeded();
        uint256 leftover = quote.balanceOf(address(this));
        uint256 spent = quoteInToken - (leftover < quoteInToken ? leftover : quoteInToken);
        IERC20(baseToken).safeTransfer(msg.sender, baseOut);
        if (leftover != 0) quote.safeTransfer(msg.sender, leftover);
        emit SpotBought(msg.sender, spent, baseOut, baseOut == 0 ? 0 : spent * (1e36 / _quoteUnit) / baseOut);
    }

    /// @inheritdoc IKuruHedger
    function sellSpot(uint256 baseIn, uint256 minQuoteOut, bytes calldata route)
        external
        onlyVault
        nonReentrant
        returns (uint256 quoteOutToken)
    {
        IERC20 base = IERC20(baseToken);
        IERC20 quote = IERC20(quoteToken);
        base.safeTransferFrom(msg.sender, address(this), baseIn);
        uint256 quote0 = quote.balanceOf(address(this));
        if (route.length == 0) {
            if (kuruMarket == address(0)) revert RouteCallFailed();
            // Kuru sell size is in sizePrecision units of the native base, rounds down; the rest is returned
            uint96 size = uint96(baseIn * sizePrecision / 1e18);
            uint256 value = uint256(size) * 1e18 / sizePrecision;
            IWrappedNative(baseToken).withdraw(value);
            IKuruOrderBook(kuruMarket).placeAndExecuteMarketSell{value: value}(size, 0, false, false);
        } else {
            _flow(base, baseIn, route);
        }
        uint256 native = address(this).balance;
        if (native != 0) IWrappedNative(baseToken).deposit{value: native}();
        quoteOutToken = quote.balanceOf(address(this)) - quote0;
        if (quoteOutToken < minQuoteOut) revert SlippageExceeded();
        uint256 baseLeft = base.balanceOf(address(this));
        quote.safeTransfer(msg.sender, quoteOutToken);
        if (baseLeft != 0) base.safeTransfer(msg.sender, baseLeft);
        uint256 sold = baseIn - (baseLeft < baseIn ? baseLeft : baseIn);
        emit SpotSold(msg.sender, sold, quoteOutToken, sold == 0 ? 0 : quoteOutToken * (1e36 / _quoteUnit) / sold);
    }

    /// @dev CR-002: exact approval to the Flow entrypoint, call it with the keeper's calldata, reset to 0.
    ///      > VERIFY: that the Flow entrypoint (not KuruFlowRouter) is the token spender (docs.kuru.io / kuru-sdk).
    function _flow(IERC20 tokenIn, uint256 amountIn, bytes calldata route) internal {
        tokenIn.forceApprove(flowEntrypoint, amountIn);
        (bool ok,) = flowEntrypoint.call(route);
        if (!ok) revert RouteCallFailed();
        tokenIn.forceApprove(flowEntrypoint, 0);
    }

    /// @inheritdoc IKuruHedger
    /// @dev Kuru's `bestBidAsk` is 1e18-scaled (R17); no market ⇒ (0, max).
    function bestBidAsk() external view returns (uint256 bidWad, uint256 askWad) {
        if (kuruMarket == address(0)) return (0, type(uint256).max);
        return IKuruOrderBook(kuruMarket).bestBidAsk();
    }
}
