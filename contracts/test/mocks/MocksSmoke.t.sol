// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {MockClearingHouse} from "../../src/mocks/MockClearingHouse.sol";
import {MockOrderBook} from "../../src/mocks/MockOrderBook.sol";
import {MockInsuranceFund} from "../../src/mocks/MockInsuranceFund.sol";
import {MockKuruHedger} from "../../src/mocks/MockKuruHedger.sol";
import {MockMeridianVault} from "../../src/mocks/MockMeridianVault.sol";
import {AccountView} from "../../src/interfaces/MeridianTypes.sol";

/// @notice Proves the mocks wire together the way downstream workstreams will use them.
contract MocksSmokeTest is Test {
    MockERC20 ausd;
    MockERC20 wmon;
    MockOracleAdapter oracle;
    MockClearingHouse ch;
    MockOrderBook ob;
    address alice = address(0xA11CE);

    function setUp() public {
        ausd = new MockERC20("Agora USD", "AUSD", 6);
        wmon = new MockERC20("Wrapped MON", "WMON", 18);
        oracle = new MockOracleAdapter(2e18);
        ch = new MockClearingHouse(address(ausd), address(oracle), address(new MockInsuranceFund(address(ausd))));
        ob = new MockOrderBook(address(ch), 1e14, 1e18);
        ch.setOrderBook(address(ob));
        ob.mockSetFillPrice(2e18);
    }

    function test_shortOpensAndFundingPaysShort() public {
        ausd.mint(alice, 1000e6);
        vm.startPrank(alice);
        ausd.approve(address(ch), type(uint256).max);
        ch.deposit(1000e6);
        ob.placeMarketOrder(false, 100, 0, 100, false); // short 100 @ 2
        vm.stopPrank();

        assertEq(ch.getPosition(alice).size, -100e18);
        (uint256 l, uint256 s) = ch.openInterest();
        assertEq(l, s);

        ch.mockAccrueFunding(0.01e18, 0); // longs pay 0.01 per unit
        AccountView memory a = ch.getAccount(alice);
        assertEq(a.pendingFunding, -1e18); // short is owed 1 AUSD
        assertEq(a.equity, 1001e18);
    }

    function test_vaultAndHedger() public {
        MockMeridianVault v = new MockMeridianVault(address(ausd));
        ausd.mint(alice, 100e6);
        vm.startPrank(alice);
        ausd.approve(address(v), type(uint256).max);
        uint256 shares = v.deposit(100e6, alice);
        vm.stopPrank();
        assertEq(shares, 100e18);
        v.mockGain(10e6);
        assertApproxEqAbs(v.sharePrice(), 1.1e18, 1e12);

        MockKuruHedger h = new MockKuruHedger(address(wmon), address(ausd), 2e18);
        ausd.mint(address(this), 10e6);
        uint256 base = h.buySpot(10e6, 0, "");
        assertEq(base, 5e18);
    }

    /// @notice mockDeploy makes the sync paths idle-only (like CR-014), so a large exit goes through the queue.
    function test_vaultMockDeployQueue() public {
        MockMeridianVault v = new MockMeridianVault(address(ausd));
        ausd.mint(alice, 100e6);
        vm.startPrank(alice);
        ausd.approve(address(v), type(uint256).max);
        uint256 shares = v.deposit(100e6, alice);
        vm.stopPrank();
        assertEq(v.maxRedeem(alice), shares);
        v.mockDeploy(90e6);
        assertEq(v.maxRedeem(alice), 10e18);
        assertEq(v.maxWithdraw(alice), 10e6);
        assertEq(v.hedgeState().idleAssets, 10e6);
        vm.prank(alice);
        vm.expectRevert();
        v.redeem(shares, alice, alice);
        vm.prank(alice);
        uint256 id = v.requestRedeem(shares, alice, alice);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        v.fulfillRedeems(ids, "");
        vm.prank(alice);
        assertEq(v.claimRedeem(id), 100e6);
        assertEq(ausd.balanceOf(alice), 100e6);
    }
}

/// @notice Pins the two-index semantics the funding-swap market relies on (MATH_SPEC §1.8, §6).
contract FundingIndexSemanticsTest is Test {
    function test_avgRateIsDeltaFOverDeltaG() public {
        MockERC20 ausd = new MockERC20("Agora USD", "AUSD", 6);
        MockOracleAdapter oracle = new MockOracleAdapter(0.03e18);
        MockClearingHouse ch = new MockClearingHouse(address(ausd), address(oracle), address(0));
        int256 r = 3_472_222_222; // 10.95% APR per second, WAD
        int256 idx = 0.03e18;
        int256 dt = 3600;
        int256 dG = idx * dt; // index * seconds
        int256 dF = r * idx * dt / 1e18; // rate * index * seconds
        ch.mockAccrue(dF, dG, r);
        (int256 f, int256 g,) = ch.latestObservation();
        assertApproxEqAbs(f * 1e18 / g, r, 1); // ΔF/ΔG == rate
        assertApproxEqRel(ch.averageFundingApr(0), 0.1095e18, 1e14);
    }
}
