// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ClearingHouseBase} from "./ClearingHouseBase.t.sol";
import {ClearingHouseHandler} from "../invariant/handlers/ClearingHouseHandler.sol";

/// Smoke run of ClearingHouseHandler for I1–I5 and I11 (the full suites live in test/invariant/, WS-08).
contract ClearingHouseInvariantTest is StdInvariant, ClearingHouseBase {
    ClearingHouseHandler handler;
    uint256 deployBlock;

    function setUp() public override {
        super.setUp();
        deployBlock = block.number;
        address[] memory a = new address[](6);
        for (uint256 i; i < a.length; ++i) {
            a[i] = address(uint160(0xA000 + i));
        }
        handler = new ClearingHouseHandler(ch, ob, oracle, ausd, a);
        for (uint256 i; i < a.length; ++i) {
            handler.deposit(i, 5000e6);
        }
        bytes4[] memory sel = new bytes4[](11);
        sel[0] = handler.deposit.selector;
        sel[1] = handler.withdraw.selector;
        sel[2] = handler.trade.selector;
        sel[3] = handler.trade.selector; // weight trades ×3
        sel[4] = handler.trade.selector;
        sel[5] = handler.liquidate.selector;
        sel[6] = handler.settle.selector;
        sel[7] = handler.pokeTwice.selector;
        sel[8] = handler.roll.selector;
        sel[9] = handler.movePrice.selector;
        sel[10] = handler.quote.selector;
        targetSelector(FuzzSelector(address(handler), sel));
        targetContract(address(handler));
    }

    /// Deterministic path through the handler: max-leverage fill, two −8% moves, liquidation, then every
    /// invariant still holds (random runs do not reach liquidation in every run).
    function test_handler_liquidationPath() public {
        handler.trade(0, 1, true, type(uint256).max, 0);
        assertEq(handler.calls("trade"), 1);
        handler.roll(1);
        handler.movePrice(-800);
        handler.roll(1);
        handler.movePrice(-800);
        handler.roll(1);
        handler.pokeTwice();
        assertTrue(ch.isLiquidatable(address(uint160(0xA000))));
        handler.liquidate(0, type(uint256).max);
        assertEq(handler.calls("liquidate"), 1);
        invariant_I1_solvency();
        invariant_I2_oiBalance();
        invariant_I3_fundingConservation();
        invariant_I4_oncePerBlock();
        invariant_I5_rateBounds();
        invariant_I11_oracle();
    }

    function invariant_I1_solvency() public view {
        assertGe(handler.checkSolvencySlack(), 0);
    }

    function invariant_I2_oiBalance() public view {
        (uint256 lo, uint256 so, uint256 sl, uint256 ss) = handler.checkOI();
        assertEq(lo, so);
        assertEq(lo, sl);
        assertEq(so, ss);
    }

    function invariant_I3_fundingConservation() public view {
        (int256 total, uint256 terms) = handler.checkFundingConservation();
        assertGe(total, 0);
        assertLe(total, int256(terms));
    }

    function invariant_I4_oncePerBlock() public view {
        assertFalse(handler.ghostTouchedTwice());
    }

    function invariant_I5_rateBounds() public view {
        assertFalse(handler.ghostRateViolation());
    }

    function invariant_I11_oracle() public view {
        assertFalse(handler.ghostGDecreased());
        assertTrue(handler.checkCheckpoints());
        int256 cap = int256(ch.fundingParams().rateCap);
        uint256 age = block.number - deployBlock;
        uint64[3] memory w = [uint64(0), uint64(age / 2), uint64(age)];
        for (uint256 i; i < 3; ++i) {
            int256 r = ch.averageFundingRate(w[i]);
            assertLe(r, cap);
            assertGe(r, -cap);
        }
    }
}
