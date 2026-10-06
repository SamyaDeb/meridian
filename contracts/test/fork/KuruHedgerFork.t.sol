// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {KuruHedger} from "../../src/vault/KuruHedger.sol";

/// @notice The real KuruHedger on a Monad MAINNET fork (runs only with MONAD_RPC_URL; skips cleanly otherwise).
///         Addresses: WMON R10, USDC R10b, Kuru MON/USDC R19b (native-MON base, the liquid market), Kuru Flow
///         entrypoint R16. MON/AUSD on Kuru is dead (R19), so the direct path is exercised on MON/USDC.
///         Kuru Flow: set KURU_FLOW_ROUTE (calldata hex from ws.kuru.io/api/quote for this hedger as the user,
///         USDC→MON) and KURU_FLOW_AMOUNT_IN (USDC units) right before running; otherwise that test skips.
///         > VERIFY: the quote API request schema (docs.kuru.io / kuru-sdk) — the keeper integration needs it.
contract KuruHedgerForkTest is Test {
    address constant WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant MON_USDC = 0x065C9d28E428A0db40191a54d33d5b7c71a9C394;
    address constant FLOW = 0xb3e6778480b2E488385E8205eA05E20060B813cb;

    KuruHedger h;
    bool live;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true); // no MONAD_RPC_URL: SKIPPED, not a silent PASS
        vm.createSelectFork(rpc);
        live = true;
        h = new KuruHedger(address(this), WMON, USDC, FLOW, MON_USDC);
        h.setVault(address(this));
        deal(USDC, address(this), 1000e6);
        IERC20(USDC).approve(address(h), type(uint256).max);
        IERC20(WMON).approve(address(h), type(uint256).max);
    }

    function test_fork_directBuyThenSell() public {
        if (!live) vm.skip(true);
        (uint256 bid, uint256 ask) = h.bestBidAsk();
        assertGt(bid, 0);
        assertGt(ask, bid);
        // buy with 10 USDC; minOut = 10 USDC at the ask + 2%
        uint256 minOut = uint256(10e6) * 1e12 * 1e18 / (ask * 102 / 100);
        uint256 out = h.buySpot(10e6, minOut, "");
        assertGe(out, minOut);
        assertEq(IERC20(WMON).balanceOf(address(this)), out, "native wrapped to WMON (WETH9 deposit on real WMON)");
        // sell half back; minOut at the bid − 2%
        uint256 half = out / 2;
        uint256 minQ = half * (bid * 98 / 100) / 1e18 / 1e12;
        uint256 q = h.sellSpot(half, minQ, "");
        assertGe(q, minQ);
        assertEq(IERC20(USDC).balanceOf(address(h)), 0);
        assertEq(IERC20(WMON).balanceOf(address(h)), 0);
        assertEq(address(h).balance, 0);
        emit log_named_uint("MON bought for 10 USDC (wei)", out);
        emit log_named_uint("USDC for half (6dp)", q);
    }

    function test_fork_flowRoute() public {
        if (!live) vm.skip(true);
        bytes memory route = vm.envOr("KURU_FLOW_ROUTE", bytes(""));
        if (route.length == 0) vm.skip(true); // no fresh route supplied
        uint256 amountIn = vm.envUint("KURU_FLOW_AMOUNT_IN");
        (, uint256 ask) = h.bestBidAsk();
        uint256 minOut = amountIn * 1e12 * 1e18 / (ask * 102 / 100);
        uint256 out = h.buySpot(amountIn, minOut, route);
        assertGe(out, minOut);
        assertEq(IERC20(USDC).allowance(address(h), FLOW), 0, "approval reset");
    }

    receive() external payable {}
}
