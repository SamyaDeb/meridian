// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ClearingHouseBase} from "./ClearingHouseBase.t.sol";
import {MarketFactory} from "../../src/clearing/MarketFactory.sol";
import {IMarketFactory} from "../../src/interfaces/IMarketFactory.sol";

contract MarketFactoryTest is ClearingHouseBase {
    MarketFactory factory;
    address wmon = makeAddr("wmon");

    function setUp() public override {
        super.setUp();
        factory = new MarketFactory(owner);
    }

    function _register() internal returns (bytes32) {
        vm.prank(owner);
        return factory.registerMarket("MON-PERP", address(ob), address(ch), address(oracle), wmon);
    }

    function test_register_andViews() public {
        bytes32 id = keccak256("MON-PERP");
        vm.expectEmit(address(factory));
        emit IMarketFactory.MarketRegistered(id, "MON-PERP", address(ob), address(ch), address(oracle));
        assertEq(_register(), id);
        IMarketFactory.Market memory m = factory.getMarket(id);
        assertEq(m.marketId, id);
        assertEq(m.symbol, "MON-PERP");
        assertEq(m.orderBook, address(ob));
        assertEq(m.clearingHouse, address(ch));
        assertEq(m.oracle, address(oracle));
        assertEq(m.baseAsset, wmon);
        assertTrue(m.active);
        assertEq(factory.marketIds().length, 1);
        assertEq(factory.marketByClearingHouse(address(ch)), id);
    }

    function test_register_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        factory.registerMarket("MON-PERP", address(ob), address(ch), address(oracle), wmon);

        vm.startPrank(owner);
        vm.expectRevert(IMarketFactory.InvalidParams.selector);
        factory.registerMarket("", address(ob), address(ch), address(oracle), wmon);
        vm.expectRevert(IMarketFactory.InvalidParams.selector);
        factory.registerMarket("MON-PERP", address(0), address(ch), address(oracle), wmon);
        vm.expectRevert(IMarketFactory.InvalidParams.selector);
        factory.registerMarket("MON-PERP", address(ob), address(ch), address(0), wmon);
        vm.expectRevert(IMarketFactory.InvalidParams.selector);
        factory.registerMarket("MON-PERP", alice, address(ch), address(oracle), wmon); // not the CH's book
        vm.stopPrank();

        _register();
        vm.prank(owner);
        vm.expectRevert(IMarketFactory.MarketExists.selector);
        factory.registerMarket("MON-PERP", address(ob), address(ch), address(oracle), wmon);
    }

    function test_setMarketActive() public {
        bytes32 id = _register();
        vm.expectEmit(address(factory));
        emit IMarketFactory.MarketStatusChanged(id, false);
        vm.prank(owner);
        factory.setMarketActive(id, false);
        assertFalse(factory.getMarket(id).active);
        vm.prank(owner);
        vm.expectRevert(IMarketFactory.UnknownMarket.selector);
        factory.setMarketActive(bytes32(uint256(1)), true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        factory.setMarketActive(id, true);
    }

    function test_unknownMarketViews() public {
        vm.expectRevert(IMarketFactory.UnknownMarket.selector);
        factory.getMarket(bytes32(uint256(1)));
        vm.expectRevert(IMarketFactory.UnknownMarket.selector);
        factory.marketByClearingHouse(alice);
    }
}
