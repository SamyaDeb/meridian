// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {IInsuranceFund} from "../../src/interfaces/IInsuranceFund.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

contract InsuranceFundTest is Test {
    MockERC20 ausd;
    InsuranceFund fund;
    address owner = makeAddr("owner");
    address market = makeAddr("market");

    function setUp() public {
        ausd = new MockERC20("Agora Dollar", "AUSD", 6);
        fund = new InsuranceFund(address(ausd), owner);
        ausd.mint(address(this), 100e6);
        ausd.approve(address(fund), type(uint256).max);
    }

    function test_fund_andBalance() public {
        vm.expectEmit(address(fund));
        emit IInsuranceFund.Funded(address(this), 60e6);
        fund.fund(60e6);
        assertEq(fund.balance(), 60e6);
        assertEq(fund.asset(), address(ausd));
        ausd.mint(address(fund), 1e6); // plain transfers (liquidation surplus) count too
        assertEq(fund.balance(), 61e6);
    }

    function test_coverBadDebt_unauthorizedReverts() public {
        vm.prank(market);
        vm.expectRevert(IInsuranceFund.UnauthorizedMarket.selector);
        fund.coverBadDebt(1);
    }

    function test_coverBadDebt_paysMinOfRequestAndBalance() public {
        fund.fund(10e6);
        vm.prank(owner);
        fund.setMarketAuthorized(market, true);
        vm.startPrank(market);
        vm.expectEmit(address(fund));
        emit IInsuranceFund.BadDebtCovered(market, 4e6, 4e6);
        assertEq(fund.coverBadDebt(4e6), 4e6);
        assertEq(fund.coverBadDebt(100e6), 6e6);
        assertEq(fund.coverBadDebt(1), 0);
        vm.stopPrank();
        assertEq(ausd.balanceOf(market), 10e6);
    }

    function test_setMarketAuthorized_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        fund.setMarketAuthorized(market, true);
        vm.expectEmit(address(fund));
        emit IInsuranceFund.MarketAuthorized(market, true);
        vm.prank(owner);
        fund.setMarketAuthorized(market, true);
        assertTrue(fund.isAuthorized(market));
        vm.prank(owner);
        fund.setMarketAuthorized(market, false);
        assertFalse(fund.isAuthorized(market));
    }
}
