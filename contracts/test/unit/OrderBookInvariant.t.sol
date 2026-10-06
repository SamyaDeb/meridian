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

    /// @notice Coverage (liveness) check, guarding against a handler that silently does nothing. It runs once at the
    ///         end of every run (depth 128 calls), not after every call: the old per-call form
    ///         (`invariant_actionsExercised`) failed on legitimate runs whose first > 20 successful calls were all
    ///         `placeLimit` (≈ 0.65^25 per run × 256 runs × 3 campaigns ⇒ ~1% of `forge test` invocations). A run
    ///         has 128 calls over 5 selectors (≈ 26 placeLimit, ≈ 26 cancel); once ≥ 8 limit orders succeeded, a run
    ///         with zero successful cancels AND zero successful market orders needs every one of ~26 cancel calls to
    ///         find an empty ghost list and every market order to find no liquidity: only a broken handler does that
    ///         (mutation-checked: cancel as a no-op + uncounted market orders fails this in the first run).
    function afterInvariant() public {
        // CR-007 coverage per run (skips, evictions), appended to bench-out/ob_invariant_coverage.csv
        RecordingEngine eng = handler.eng();
        vm.createDir("./bench-out", true);
        vm.writeLine(
            "./bench-out/ob_invariant_coverage.csv",
            string.concat(vm.toString(eng.makerSkips()), ",", vm.toString(eng.makerEvicts()))
        );
        uint256 placed = handler.calls("placeLimit");
        assertGt(placed + handler.calls("placeLimit.reverted") + handler.calls("placeMarket.reverted"), 0, "no calls");
        if (placed >= 8) {
            assertGt(handler.calls("cancel") + handler.calls("placeMarket"), 0, "no cancel/market in a full run");
        }
    }
}
