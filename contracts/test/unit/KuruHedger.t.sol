// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {KuruHedger} from "../../src/vault/KuruHedger.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {IKuruHedger} from "../../src/interfaces/IKuruHedger.sol";

/// @dev WETH9-style wrapper.
contract TestWMON is ERC20("Wrapped MON", "WMON") {
    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 a) external {
        _burn(msg.sender, a);
        payable(msg.sender).transfer(a);
    }
}

/// @dev Kuru market shape verified on the mainnet fork (R17): native-MON base, pricePrecision 1e8, sizePrecision 1e10.
contract TestKuruMarket {
    address public quote;
    uint256 public priceWad; // quote per MON, WAD
    uint256 public lastQuoteSize;

    constructor(address quote_, uint256 priceWad_) payable {
        quote = quote_;
        priceWad = priceWad_;
    }

    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)
    {
        return (1e8, 1e10, address(0), 18, quote, 6, 100, 0, 0, 0, 0);
    }

    function placeAndExecuteMarketBuy(uint96 quoteSize, uint256, bool, bool) external payable returns (uint256 out) {
        lastQuoteSize = quoteSize;
        uint256 quoteToken = uint256(quoteSize) * 1e6 / 1e8;
        IERC20(quote).transferFrom(msg.sender, address(this), quoteToken);
        out = quoteToken * 1e12 * 1e18 / priceWad;
        payable(msg.sender).transfer(out);
    }

    function placeAndExecuteMarketSell(uint96 size, uint256, bool, bool) external payable returns (uint256 out) {
        require(msg.value == uint256(size) * 1e18 / 1e10, "value");
        out = msg.value * priceWad / 1e18 / 1e12;
        MockERC20(quote).mint(msg.sender, out);
    }

    function bestBidAsk() external view returns (uint256, uint256) {
        return (priceWad, priceWad);
    }

    receive() external payable {}
}

/// @dev Kuru Flow stand-in: pulls `amountIn` of tokenIn from the caller and pays `out` of tokenOut (or native).
contract TestFlow {
    function swap(address tokenIn, uint256 amountIn, address tokenOut, uint256 out, bool nativeOut) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        if (nativeOut) payable(msg.sender).transfer(out);
        else MockERC20(tokenOut).mint(msg.sender, out);
    }

    /// Malicious route: takes the input, pays the (native) output to someone else. The call itself succeeds.
    function steal(address tokenIn, uint256 amountIn, uint256 out, address to) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        payable(to).transfer(out);
    }

    receive() external payable {}
}

contract KuruHedgerTest is Test {
    MockERC20 ausd;
    TestWMON wmon;
    TestKuruMarket market;
    TestFlow flow;
    KuruHedger h;
    address owner = makeAddr("owner");
    address vault = makeAddr("vault");

    function setUp() public {
        ausd = new MockERC20("AUSD", "AUSD", 6);
        wmon = new TestWMON();
        market = new TestKuruMarket{value: 1_000_000 ether}(address(ausd), 0.029e18);
        flow = new TestFlow();
        vm.deal(address(flow), 1_000_000 ether);
        h = new KuruHedger(owner, address(wmon), address(ausd), address(flow), address(market));
        vm.prank(owner);
        h.setVault(vault);
        ausd.mint(vault, 1_000_000e6);
        vm.deal(vault, 1_000_000 ether);
        vm.startPrank(vault);
        wmon.deposit{value: 1_000_000 ether}();
        ausd.approve(address(h), type(uint256).max);
        wmon.approve(address(h), type(uint256).max);
        vm.stopPrank();
    }

    // ─── wiring ─────────────────────────────────────────────────────────
    function test_constructor_readsMarketAndValidates() public {
        assertEq(h.pricePrecision(), 1e8);
        assertEq(h.sizePrecision(), 1e10);
        assertEq(h.kuruMarket(), address(market));
        assertEq(h.baseToken(), address(wmon));
        assertEq(h.quoteToken(), address(ausd));
        vm.expectRevert(IKuruHedger.InvalidParams.selector);
        new KuruHedger(owner, address(0), address(ausd), address(flow), address(market));
        MockERC20 other = new MockERC20("x", "x", 6);
        vm.expectRevert(IKuruHedger.InvalidParams.selector); // market quote != quoteToken
        new KuruHedger(owner, address(wmon), address(other), address(flow), address(market));
    }

    function test_setVault_onceOwnerOnly() public {
        vm.prank(owner);
        vm.expectRevert(IKuruHedger.InvalidParams.selector);
        h.setVault(address(1));
        KuruHedger h2 = new KuruHedger(owner, address(wmon), address(ausd), address(flow), address(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, vault));
        vm.prank(vault);
        h2.setVault(vault);
    }

    function test_onlyVault() public {
        vm.expectRevert(IKuruHedger.OnlyVault.selector);
        h.buySpot(1, 0, "");
        vm.expectRevert(IKuruHedger.OnlyVault.selector);
        h.sellSpot(1, 0, "");
    }

    // ─── direct Kuru market ─────────────────────────────────────────────
    function test_directBuy_unitsWrapAndReturn() public {
        uint256 w0 = wmon.balanceOf(vault);
        vm.prank(vault);
        uint256 out = h.buySpot(10e6, 344e18, "");
        assertEq(market.lastQuoteSize(), 10e8, "quote size in pricePrecision units (R17: 10 USDC = 1e9)");
        assertEq(out, uint256(10e6) * 1e12 * 1e18 / 0.029e18);
        assertEq(wmon.balanceOf(vault) - w0, out, "native wrapped and returned");
        _assertEmpty();
    }

    function test_directSell_sizePrecisionAndDust() public {
        uint256 baseIn = 1000e18 + 12_345; // below sizePrecision dust is returned
        uint256 a0 = ausd.balanceOf(vault);
        uint256 w0 = wmon.balanceOf(vault);
        vm.prank(vault);
        uint256 out = h.sellSpot(baseIn, 28e6, "");
        assertEq(out, 29e6);
        assertEq(ausd.balanceOf(vault) - a0, out);
        assertEq(w0 - wmon.balanceOf(vault), 1000e18, "only whole sizePrecision units sold");
        _assertEmpty();
    }

    function test_minOutEnforcedByBalanceDelta() public {
        vm.prank(vault);
        vm.expectRevert(IKuruHedger.SlippageExceeded.selector);
        h.buySpot(10e6, 345e18, ""); // 344.8 MON at 0.029
        vm.prank(vault);
        vm.expectRevert(IKuruHedger.SlippageExceeded.selector);
        h.sellSpot(1000e18, 29e6 + 1, "");
    }

    // ─── Kuru Flow route (CR-002) ───────────────────────────────────────
    function test_flowBuy_exactApprovalResetAndNativeWrapped() public {
        bytes memory route = abi.encodeCall(TestFlow.swap, (address(ausd), 100e6, address(0), 3400 ether, true));
        uint256 w0 = wmon.balanceOf(vault);
        vm.prank(vault);
        uint256 out = h.buySpot(100e6, 3400 ether, route);
        assertEq(out, 3400 ether);
        assertEq(wmon.balanceOf(vault) - w0, 3400 ether);
        assertEq(ausd.allowance(address(h), address(flow)), 0, "approval reset to 0");
        _assertEmpty();
    }

    function test_flowSell_leftoverReturned() public {
        bytes memory route = abi.encodeCall(TestFlow.swap, (address(wmon), 600e18, address(ausd), 17e6, false));
        uint256 w0 = wmon.balanceOf(vault);
        vm.prank(vault);
        uint256 out = h.sellSpot(1000e18, 17e6, route); // the route only used 600
        assertEq(out, 17e6);
        assertEq(w0 - wmon.balanceOf(vault), 600e18, "unused base returned");
        assertEq(wmon.allowance(address(h), address(flow)), 0);
        _assertEmpty();
    }

    function test_flowRoute_outputToSomeoneElseReverts() public {
        address thief = makeAddr("thief");
        bytes memory route = abi.encodeCall(TestFlow.steal, (address(ausd), 100e6, 3400 ether, thief));
        vm.prank(vault);
        vm.expectRevert(IKuruHedger.SlippageExceeded.selector); // the route succeeded; the balance delta is 0
        h.buySpot(100e6, 1, route);
        assertEq(thief.balance, 0, "reverted as a whole");
    }

    function test_flowRoute_failingCallReverts() public {
        vm.prank(vault);
        vm.expectRevert(IKuruHedger.RouteCallFailed.selector);
        h.buySpot(100e6, 1, hex"deadbeef");
    }

    function test_noMarket_directRouteRefused() public {
        KuruHedger h2 = new KuruHedger(owner, address(wmon), address(ausd), address(flow), address(0));
        vm.prank(owner);
        h2.setVault(vault);
        vm.startPrank(vault);
        ausd.approve(address(h2), 1e6);
        vm.expectRevert(IKuruHedger.RouteCallFailed.selector);
        h2.buySpot(1e6, 0, "");
        vm.stopPrank();
        (uint256 bid, uint256 ask) = h2.bestBidAsk();
        assertEq(bid, 0);
        assertEq(ask, type(uint256).max);
    }

    function _assertEmpty() internal view {
        assertEq(ausd.balanceOf(address(h)), 0, "hedger holds no quote");
        assertEq(wmon.balanceOf(address(h)), 0, "hedger holds no WMON");
        assertEq(address(h).balance, 0, "hedger holds no native");
    }
}
