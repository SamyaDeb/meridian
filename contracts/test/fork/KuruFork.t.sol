// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

// Signatures from kuru-sdk abi/OrderBook.json (NOT the docs page)
interface IKuruOB {
    function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill)
        external
        payable
        returns (uint256);
    function placeAndExecuteMarketSell(uint96 _size, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill)
        external
        payable
        returns (uint256);
    function bestBidAsk() external view returns (uint256, uint256);
}

contract KuruForkTest is Test {
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    IKuruOB constant OB = IKuruOB(0x065C9d28E428A0db40191a54d33d5b7c71a9C394); // MON/USDC, base native MON
    receive() external payable {}

    function test_buyThenSell() public {
        string memory rpc = vm.envOr("MONAD_RPC_URL", string("")); // fork tests run only with MONAD_RPC_URL
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        (uint256 bid, uint256 ask) = OB.bestBidAsk();
        emit log_named_uint("bid 1e18", bid);
        emit log_named_uint("ask 1e18", ask);
        deal(USDC, address(this), 100e6);
        IERC20(USDC).approve(address(OB), type(uint256).max);
        uint256 mon0 = address(this).balance;
        // quote size: try token decimals (6dp) -> 10 USDC
        uint256 out = OB.placeAndExecuteMarketBuy(uint96(10e6 * 100), 0, false, false);
        uint256 got = address(this).balance - mon0;
        emit log_named_uint("return value", out);
        emit log_named_uint("MON received (wei)", got);
        emit log_named_uint("USDC left", IERC20(USDC).balanceOf(address(this)));
        assertGt(got, 0);
        // sell back half: size in sizePrecision (1e10)
        uint256 usdc0 = IERC20(USDC).balanceOf(address(this));
        uint96 sz = uint96(got / 2 / 1e8); // wei(1e18) -> 1e10 precision
        uint256 out2 = OB.placeAndExecuteMarketSell{value: uint256(sz) * 1e8}(sz, 0, false, false);
        emit log_named_uint("sell return", out2);
        emit log_named_uint("USDC received", IERC20(USDC).balanceOf(address(this)) - usdc0);
    }
}
