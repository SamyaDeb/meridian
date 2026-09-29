// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {FundingSwapBase} from "../unit/FundingSwapMarket.t.sol";
import {IFundingSwapMarket} from "../../src/interfaces/IFundingSwapMarket.sol";

/// @notice MATH_SPEC §6.2 conservation through the market: any sequence of fills (random actors, sides, sizes,
///         APRs) and accrual paths keeps Σq = 0, ΣK = 0, longOI = shortOI, and the accrual rounding dust is
///         0 ≤ Σdeposits − (Σcollateral + fees) ≤ #settlements wei (every settlement rounds ↓ once).
contract FundingSwapMarketFuzzTest is FundingSwapBase {
    address[4] actors;

    function setUp() public override {
        super.setUp();
        actors = [alice, bob, carol, dave];
        for (uint256 i; i < actors.length; ++i) {
            _deposit(actors[i], 1_000_000e6);
        }
    }

    function testFuzz_conservation(uint256 seed) public {
        uint256 settlements;
        vm.recordLogs();
        for (uint256 step; step < 24; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            if (r % 3 == 0) {
                // accrual: realized APR in [−50%, +100%], 1 h .. 3 d
                int256 apr = int256((r >> 8) % 150) * 0.01e18 - 0.5e18;
                int256 sec = int256(1 hours + (r >> 40) % 3 days);
                _accrue(apr, sec);
                continue;
            }
            address taker = actors[(r >> 8) % 4];
            address maker = actors[(r >> 16) % 4];
            if (taker == maker) continue;
            uint64 lots = uint64(1 + (r >> 24) % 300);
            int256 aprBp = int256((r >> 48) % 8000) - 2000; // [−20%, +60%) in bp
            ob.mockSetMaker(maker);
            ob.mockSetFillPrice(uint256(1e18 + aprBp * 1e14));
            vm.prank(taker);
            try ob.placeMarketOrder((r >> 32) % 2 == 0, lots, 0, 0, false) {} catch {}
        }
        for (uint256 i; i < actors.length; ++i) {
            fs.settle(actors[i]);
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IFundingSwapMarket.SwapAccrualSettled.selector) ++settlements;
        }

        int256 sumQ;
        int256 sumK;
        int256 sumC;
        for (uint256 i; i < actors.length; ++i) {
            sumQ += fs.getPosition(actors[i]).size;
            sumK += fs.getPosition(actors[i]).fixedAprNotional;
            sumC += fs.collateralOf(actors[i]);
        }
        assertEq(sumQ, 0, "sum q");
        assertEq(sumK, 0, "sum K");
        (uint256 lo, uint256 so) = fs.openInterest();
        assertEq(lo, so, "OI balanced");
        int256 dust = 4 * 1_000_000e18 - (sumC + int256(fs.accruedFees()));
        assertGe(dust, 0, "accrual never creates value");
        assertLe(dust, int256(settlements), "at most 1 wei per settlement");
        assertGe(int256(ausd.balanceOf(address(fs))) * 1e12, sumC + int256(fs.accruedFees()), "solvent");
    }
}
