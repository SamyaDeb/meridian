// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {RecordingEngine} from "./OrderBookEngine.t.sol";
import {OrderBookHandler} from "../invariant/handlers/OrderBookHandler.sol";

/// @notice Runs I6/I7 through OrderBookHandler on the perp book parameters. WS-08 owns the full invariant suite;
///         this proves the handler before hand-off.
contract OrderBookInvariantTest is Test {
    OrderBookHandler handler;

    function setUp() public {
        RecordingEngine eng = new RecordingEngine();
        OrderBook ob = new OrderBook(address(eng), 1e12, 100e18);
        eng.setOrderBook(address(ob));
        handler = new OrderBookHandler(ob, eng);
        targetContract(address(handler));
    }

    function invariant_I6_bookIntegrity() public view {
        handler.checkI6();
    }

    function invariant_I7_reservationSums() public view {
        handler.checkI7();
    }

    function invariant_actionsExercised() public view {
        // guards against a handler that silently does nothing
        if (handler.calls("placeLimit") > 20) assertGt(handler.calls("cancel") + handler.calls("placeMarket"), 0);
    }
}
