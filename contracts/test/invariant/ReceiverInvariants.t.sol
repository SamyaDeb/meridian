// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {MeridianKeeperReceiver} from "../../src/automation/MeridianKeeperReceiver.sol";
import {RiskParams, FundingParams} from "../../src/interfaces/MeridianTypes.sol";
import {ReceiverHandler} from "./handlers/ReceiverHandler.sol";

/// @notice CRE backstop keeper on the REAL OrderBook + ClearingHouse: only the forwarder delivers, a well-formed report
///         never reverts, liquidations conserve size and never leave the receiver below IM, OI stays balanced.
contract ReceiverInvariantsTest is StdInvariant, Test {
    ReceiverHandler handler;
    ClearingHouse ch;

    function setUp() public {
        vm.roll(1000);
        vm.warp(1_790_000_000);
        address owner = makeAddr("owner");
        MockERC20 ausd = new MockERC20("Test AUSD", "tAUSD", 6);
        MockOracleAdapter oracle = new MockOracleAdapter(0.029e18);
        InsuranceFund fund = new InsuranceFund(address(ausd), owner);
        ch = new ClearingHouse(
            address(ausd),
            address(oracle),
            address(fund),
            RiskParams(0.2e18, 0.1e18, 0.0005e18, -0.0001e18, 0.01e18, 0.5e18, 250_000e18, 25_000e18),
            FundingParams(0.002e18, 3_472_222_222, 555_555_555_556, 555_555_556, 300, 0.05e18),
            owner
        );
        OrderBook ob = new OrderBook(address(ch), 1e12, 100e18);
        vm.startPrank(owner);
        ch.setOrderBook(address(ob));
        fund.setMarketAuthorized(address(ch), true);
        vm.stopPrank();
        ausd.mint(address(fund), 1000e6);
        address fwd = makeAddr("forwarder");
        MeridianKeeperReceiver receiver = new MeridianKeeperReceiver(fwd, owner);
        handler = new ReceiverHandler(ch, ob, oracle, ausd, receiver, fwd);
        targetContract(address(handler));
    }

    function invariant_onlyForwarderDelivers() public view {
        assertFalse(handler.ghostStrangerAccepted());
    }

    function invariant_wellFormedReportsNeverRevert() public view {
        assertFalse(handler.ghostWellFormedReverted());
    }

    function invariant_liquidationsConserveSize() public view {
        assertFalse(handler.ghostConservation());
    }

    function invariant_receiverAboveIMAfterTakes() public view {
        assertFalse(handler.ghostBelowIM());
    }

    function invariant_oiBalanced() public view {
        (uint256 longOI, uint256 shortOI) = ch.openInterest();
        assertEq(longOI, shortOI);
    }

    function afterInvariant() external view {
        assertGt(handler.liquidationReports(), 0, "coverage: liquidation reports ran");
    }
}
