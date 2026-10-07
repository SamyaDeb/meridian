// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {ClearingHouseBase} from "./ClearingHouseBase.t.sol";

/// Gas of the funding touch (Foundry prices with the Ethereum/Cancun schedule, NOT Monad MIP-8; see docs/outputs/BENCHMARKS.md).
///  - "cold": new tx, first touch of CH, oracle and book (every slot and account cold).
///  - "incremental": first touch minus a no-op touch under the same warmth ⇒ what the first tx in a block pays
///    on top of a later tx (the acceptance-criteria number).
contract ClearingHouseGasTest is ClearingHouseBase {
    function _cool() internal {
        vm.cool(address(ch));
        vm.cool(address(oracle));
        vm.cool(address(ob));
    }

    function _touchGas() internal returns (uint256 g) {
        g = gasleft();
        ch.updateFunding();
        g -= gasleft();
    }

    /// Gas of the four external views the first touch makes (oracle + 3 book views), measured the same way
    /// (cold accounts and slots), so the ClearingHouse's own share can be separated from the mocks'.
    function _externalViewGas() internal returns (uint256 g) {
        _cool();
        g = gasleft();
        oracle.tryGetIndexPrice();
        ob.bestBid();
        ob.bestAsk();
        ob.lastTrade();
        g -= gasleft();
    }

    /// Returns (cold first touch, cold no-op touch, warm no-op touch).
    function _measure() internal returns (uint256 first, uint256 noopCold, uint256 noopWarm) {
        _cool();
        first = _touchGas();
        _cool();
        noopCold = _touchGas();
        noopWarm = _touchGas();
    }

    function _positions(uint256 from, uint256 to) internal {
        for (uint256 i = from; i < to; ++i) {
            address a = address(uint160(0x10000 + i));
            _deposit(a, 10e6);
            _trade(a, bob, true, 1, 2e18);
        }
    }

    /// F and G start at 0: the very first accrual is a one-off zero → nonzero write. Take it out of the numbers.
    function _warmIndices() internal {
        vm.roll(block.number + 1);
        ch.updateFunding();
    }

    function test_gas_fundingTouch() public {
        _warmIndices();
        _deposit(bob, 1_000_000e6);
        _positions(0, 1);
        ob.mockSetBook(19_990, 20_010);

        vm.roll(1210); // new bucket ⇒ checkpoint, ring slot written for the first time (zero → nonzero)
        (uint256 ckFirstPass, uint256 noopCold,) = _measure();
        vm.roll(1211); // same bucket ⇒ no checkpoint
        (uint256 plain,, uint256 noopWarm) = _measure();

        // Wrap the ring so the next checkpoint overwrites a nonzero slot (steady state after ~24 h).
        uint256 b = 1211;
        for (uint256 i; i < 1440; ++i) {
            b += 200;
            vm.roll(b);
            ch.updateFunding();
        }
        vm.roll(b + 200);
        (uint256 ckSteady,,) = _measure();

        uint256 ext = _externalViewGas();
        console2.log("external views (mock oracle + mock book)", ext);
        console2.log("CH-own incremental, no checkpoint       ", plain - noopCold - ext);
        console2.log("CH-own incremental + checkpoint, steady ", ckSteady - noopCold - ext);
        console2.log("first touch, no checkpoint (cold)      ", plain);
        console2.log("first touch + checkpoint, ring 1st pass", ckFirstPass);
        console2.log("first touch + checkpoint, steady state ", ckSteady);
        console2.log("no-op touch (cold tx)                  ", noopCold);
        console2.log("no-op touch (warm, later in same tx)   ", noopWarm);
        console2.log("incremental, no checkpoint             ", plain - noopCold);
        console2.log("incremental + checkpoint, steady state ", ckSteady - noopCold);
        console2.log("incremental + checkpoint, first pass   ", ckFirstPass - noopCold);

        assertLt(noopWarm, 3000, "later touch < 3k");
        // Budgets on the ClearingHouse's own work; the external views depend on the real adapter/book
        // (mocks here) and on Monad's MIP-8 pricing, reported separately.
        assertLt(plain - noopCold - ext, 30_000, "CH-own first touch incremental < 30k");
        // OPEN (standup A, 29 Sep): with the checkpoint the CH-own share is ~33.9k here, ~10k of it the two cold
        // ring-slot SSTOREs the spec's 2-slot checkpoint requires (Ethereum schedule). Regression ceiling only.
        assertLt(ckSteady - noopCold - ext, 36_000, "CH-own first touch incl. checkpoint: regression ceiling");
    }

    /// O(1): the touch costs the same with 1, 100 and 1,000 open positions.
    function test_gas_fundingIndependentOfPositionCount() public {
        _warmIndices();
        _deposit(bob, 1_000_000e6);
        uint256[3] memory counts = [uint256(1), 100, 1000];
        uint256[3] memory gas;
        uint256 have;
        for (uint256 k; k < 3; ++k) {
            _positions(have, counts[k]);
            have = counts[k];
            vm.roll(block.number + 1);
            (gas[k],,) = _measure(); // n = 1 blocks elapsed each time
        }
        (uint256 lo,) = ch.openInterest();
        assertEq(lo, 1000e18);
        console2.log("touch gas @1 / @100 / @1000 positions", gas[0], gas[1], gas[2]);
        assertEq(gas[0], gas[1]);
        assertEq(gas[1], gas[2]);
    }

    /// Hot-path hook costs (warm book, touch already done in the block), reported for WS-01's gas budget.
    function test_gas_hooks() public {
        _deposit(alice, 1000e6);
        _deposit(bob, 1000e6);
        vm.roll(block.number + 1);
        ch.updateFunding();
        vm.startPrank(address(ob));
        uint256 g = gasleft();
        ch.reserveOrderMargin(bob, false, 10e18, 2e18);
        uint256 gReserve = g - gasleft();
        g = gasleft();
        ch.settleMakerFill(bob, false, 10e18, 2e18);
        uint256 gMaker = g - gasleft();
        g = gasleft();
        ch.settleTakerFill(alice, true, 10e18, 20e18, false);
        uint256 gTaker = g - gasleft();
        g = gasleft();
        ch.releaseOrderMargin(bob, false, 1e18, 2e18);
        uint256 gRelease = g - gasleft();
        vm.stopPrank();
        console2.log("reserve / maker fill (open) / taker fill (open) / release", gReserve, gMaker, gTaker);
        console2.log("release", gRelease);
    }
}
