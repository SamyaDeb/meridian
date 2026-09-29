// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {MockClearingHouse} from "../../src/mocks/MockClearingHouse.sol";
import {MockOrderBook} from "../../src/mocks/MockOrderBook.sol";
import {MockInsuranceFund} from "../../src/mocks/MockInsuranceFund.sol";
import {IOrderBook} from "../../src/interfaces/IOrderBook.sol";
import {IClearingHouse} from "../../src/interfaces/IClearingHouse.sol";

/// @notice Records the hook call order; `makerOk` toggles the maker margin check result.
contract HookRecorder {
    bytes32[] public calls;
    bool public makerOk = true;

    function setMakerOk(bool ok) external {
        makerOk = ok;
    }

    function callCount() external view returns (uint256) {
        return calls.length;
    }

    function settleMakerFill(address, bool, uint256, uint256) external returns (bool) {
        calls.push("maker");
        return makerOk;
    }

    function settleTakerFill(address, bool, uint256, uint256, bool) external {
        calls.push("taker");
    }
}

/// @notice Phase 2 decision 8: MockOrderBook hook order and eviction.
contract MockOrderBookHookOrderTest is Test {
    HookRecorder rec;
    MockOrderBook ob;

    function setUp() public {
        rec = new HookRecorder();
        ob = new MockOrderBook(address(rec), 1e12, 100e18);
        ob.mockSetFillPrice(0.029e18);
    }

    function test_makerFillsBeforeSingleTakerFill() public {
        (uint64 filled, uint256 px) = ob.placeMarketOrder(true, 5, 0, 5, false);
        assertEq(filled, 5);
        assertEq(px, 0.029e18);
        assertEq(rec.callCount(), 2);
        assertEq(rec.calls(0), bytes32("maker"));
        assertEq(rec.calls(1), bytes32("taker"));
    }

    function test_makerRejectedIsEvictedAndTakerNotSettled() public {
        rec.setMakerOk(false);
        vm.expectEmit(true, true, false, true, address(ob));
        emit IOrderBook.OrderEvicted(0, ob.mockMaker(), 5);
        (uint64 filled, uint256 px) = ob.placeMarketOrder(true, 5, 0, 0, false);
        assertEq(filled, 0);
        assertEq(px, 0);
        assertEq(rec.callCount(), 1); // maker only, no taker fill when nothing filled
        (uint256 lastPx,) = ob.lastTrade();
        assertEq(lastPx, 0);
    }

    function test_makerRejectedWithMinFillReverts() public {
        rec.setMakerOk(false);
        vm.expectRevert(IOrderBook.SlippageExceeded.selector);
        ob.placeMarketOrder(true, 5, 0, 1, false);
    }
}

/// @notice Regression for C's "double credit" report on MockClearingHouse.liquidate.
///         Result: the mock keeps Σq == 0 and longOI == shortOI. The double credit came from ghost sums that
///         counted the Liquidated event on top of the two PositionChanged events the transfer already emits.
contract MockClearingHouseLiquidateTest is Test {
    MockERC20 ausd;
    MockOracleAdapter oracle;
    MockClearingHouse ch;
    MockOrderBook ob;
    address alice = address(0xA11CE); // 5x long
    address bob = address(0xB0B); // liquidator
    address maker = address(0xBEEF); // synthetic counterparty (short)

    function setUp() public {
        ausd = new MockERC20("Test AUSD", "tAUSD", 6);
        oracle = new MockOracleAdapter(0.029e18);
        ch = new MockClearingHouse(address(ausd), address(oracle), address(new MockInsuranceFund(address(ausd))));
        ob = new MockOrderBook(address(ch), 1e12, 100e18);
        ch.setOrderBook(address(ob));
        ob.mockSetFillPrice(0.029e18);
        _fund(alice, 600e6);
        _fund(bob, 10_000e6);
        _fund(maker, 10_000e6);
    }

    function _fund(address a, uint256 amt) internal {
        ausd.mint(a, amt);
        vm.startPrank(a);
        ausd.approve(address(ch), type(uint256).max);
        ch.deposit(amt);
        vm.stopPrank();
    }

    function test_liquidateKeepsSumQZeroAndOIBalanced() public {
        vm.recordLogs();
        vm.prank(alice);
        ob.placeMarketOrder(true, 1000, 0, 1000, false); // long 100,000 MON @ 0.029 = 2,900 AUSD (~4.8x)
        oracle.setPrice(0.029e18 * 80 / 100); // −20% (mock mmr = 5%)
        assertTrue(ch.isLiquidatable(alice));
        vm.prank(bob);
        int256 moved = ch.liquidate(alice, type(uint256).max);
        assertEq(moved, 100_000e18);

        int256 sumQ = ch.getPosition(alice).size + ch.getPosition(bob).size + ch.getPosition(maker).size;
        assertEq(sumQ, 0);
        assertEq(ch.getPosition(alice).size, 0);
        (uint256 l, uint256 s) = ch.openInterest();
        assertEq(l, s);
        assertEq(l, 100_000e18);

        // Ghost sums from events: PositionChanged alone reproduces Σq = 0; adding Liquidated double-counts.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        int256 ghostPC;
        int256 ghostLiq;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IClearingHouse.PositionChanged.selector) {
                (int256 d,,,,,) = abi.decode(logs[i].data, (int256, int256, uint256, int256, int256, bool));
                ghostPC += d;
            } else if (logs[i].topics[0] == IClearingHouse.Liquidated.selector) {
                (int256 sz,,,,,) = abi.decode(logs[i].data, (int256, uint256, uint256, uint256, uint256, uint256));
                ghostLiq += sz; // liquidator side counted a second time
            }
        }
        assertEq(ghostPC, 0);
        assertEq(ghostPC + ghostLiq, 100_000e18); // the reported "double credit"
    }
}
