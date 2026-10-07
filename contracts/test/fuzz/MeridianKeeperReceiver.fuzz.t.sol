// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";
import {MeridianKeeperReceiver} from "../../src/automation/MeridianKeeperReceiver.sol";
import {MarginLib} from "../../src/libs/MarginLib.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {AccountView} from "../../src/interfaces/MeridianTypes.sol";
import {IntegrationBase} from "../unit/Integration.t.sol";

/// @notice liquidationHeadroom (port of unwind.ts, H-1): the take never breaks the receiver's own cap or IM, is
///         lot-aligned and never exceeds the target; rounding is against the receiver (it takes less, never more).
contract MeridianKeeperReceiverHeadroomFuzz is Test {
    MeridianKeeperReceiver internal r = new MeridianKeeperReceiver(address(1), address(this));

    struct In {
        int256 keeperSize;
        int256 equity;
        uint256 reserved;
        int256 target;
        uint256 mark;
        uint256 imr;
        uint256 maxPos;
        uint256 lot;
    }

    function _bound(In memory i) internal pure returns (In memory) {
        i.keeperSize = bound(i.keeperSize, -1e24, 1e24);
        i.equity = bound(i.equity, -1e24, 1e26);
        i.reserved = bound(i.reserved, 0, 1e24);
        i.target = bound(i.target, -1e24, 1e24);
        i.mark = bound(i.mark, 1e12, 1e24);
        i.imr = bound(i.imr, 0.01e18, 1e18);
        i.maxPos = bound(i.maxPos, 0, 1e24);
        i.lot = bound(i.lot, 1, 1e21);
        return i;
    }

    function _x(In memory i) internal view returns (uint256) {
        return r.liquidationHeadroom(i.keeperSize, i.equity, i.reserved, i.target, i.mark, i.imr, i.maxPos, i.lot);
    }

    function testFuzz_headroom_neverBreaksReceiverLimits(In memory i) public view {
        i = _bound(i);
        uint256 x = _x(i);
        assertLe(x, FPM.abs(i.target), "never more than the target holds");
        assertEq(x % i.lot, 0, "whole lots");
        if (x == 0) return;
        int256 s = i.keeperSize + (i.target > 0 ? int256(x) : -int256(x));
        if (FPM.abs(s) > FPM.abs(i.keeperSize)) assertLe(FPM.abs(s), i.maxPos, "position cap");
        // ClearingHouse.liquidate: equity (unchanged by a take at the mark) >= IM(s') rounded up, MATH_SPEC §3.2
        assertLe(int256(MarginLib.initialMargin(s, i.mark, i.imr, i.reserved)), i.equity, "receiver stays above IM");
    }

    /// A flat, well-funded receiver under its cap takes the whole (lot-aligned) position.
    function testFuzz_headroom_richFlatReceiverTakesAll(int256 target, uint256 mark, uint256 lot) public view {
        In memory i;
        i.target = bound(target, -1e24, 1e24);
        i.mark = bound(mark, 1e12, 1e21);
        i.lot = bound(lot, 1, 1e21);
        i.imr = 0.2e18;
        i.maxPos = 1e24;
        i.equity = 1e30;
        assertEq(_x(i), FPM.abs(i.target) / i.lot * i.lot);
    }

    /// More equity never means a smaller take (flat receiver).
    function testFuzz_headroom_monotoneInEquity(In memory i, uint256 extra) public view {
        i = _bound(i);
        i.keeperSize = 0;
        uint256 x0 = _x(i);
        i.equity += int256(bound(extra, 0, 1e26));
        assertGe(_x(i), x0);
    }

    /// Rounding direction: the take sits at or below the exact real-valued IM bound (A rounds down, IM per unit up).
    function testFuzz_headroom_roundsAgainstReceiver(In memory i) public view {
        i = _bound(i);
        i.keeperSize = 0;
        i.reserved = 0;
        i.maxPos = type(uint128).max;
        i.equity = bound(i.equity, 1, 1e26);
        uint256 x = _x(i);
        // x·mark·imr ≤ equity·(1 − 2%)  ⇔  x·mark·imr·1e4 ≤ equity·9800·1e36 (all integers; no rounding)
        assertLe(FPM.fullMulDiv(x * 10_000, i.mark * i.imr, 1), uint256(i.equity) * 9800 * 1e36);
    }

    /// Never a take when the receiver has no free margin and is flat.
    function testFuzz_headroom_noFreeMarginNoTake(In memory i) public view {
        i = _bound(i);
        i.keeperSize = 0;
        i.equity = bound(i.equity, -1e24, int256(i.reserved));
        assertEq(_x(i), 0);
    }
}

/// @notice Against the REAL ClearingHouse: whatever the receiver's margin and the crash size, a LIQUIDATE report never
///         reverts, never leaves the receiver below IM, and moves exactly what the receiver gained.
contract MeridianKeeperReceiverLiquidationFuzz is IntegrationBase {
    MockOracleAdapter internal oracle;
    MeridianKeeperReceiver internal r;
    address internal fwd = address(0xF0F0);

    function _oracle() internal override returns (address) {
        oracle = new MockOracleAdapter(I0);
        return address(oracle);
    }

    function setUp() public override {
        super.setUp();
        r = new MeridianKeeperReceiver(fwd, owner);
        actors.push(address(r));
        ausd.mint(owner, 1000e6);
        vm.startPrank(owner);
        ausd.approve(address(fund), 1000e6);
        fund.fund(1000e6);
        vm.stopPrank();
    }

    /// forge-config: default.fuzz.runs = 256
    /// forge-config: ci.fuzz.runs = 512
    function testFuzz_liquidateReport_neverRevertsAndRespectsIM(uint256 margin, uint256 dropBps) public {
        margin = bound(margin, 0, 2000e6);
        dropBps = bound(dropBps, 1200, 3000);
        if (margin != 0) {
            ausd.mint(address(this), margin);
            ausd.approve(address(ch), margin);
            ch.depositFor(address(r), margin);
        }
        _openBobLong();
        _roll(1);
        uint256 p = I0 * (10_000 - dropBps) / 10_000;
        oracle.setPrice(p);
        _quote(uint32(p / TICK));
        _roll(1);
        address[] memory xs = new address[](1);
        xs[0] = bob;
        int256 bob0 = ch.getPosition(bob).size;
        vm.prank(fwd);
        r.onReport("", abi.encode(uint8(2), abi.encode(address(ch), xs)));
        int256 took = ch.getPosition(address(r)).size;
        assertEq(bob0 - ch.getPosition(bob).size, took, "conservation: bob's loss is the receiver's gain");
        assertEq(uint256(took) % LOT, 0);
        AccountView memory v = ch.getAccount(address(r));
        if (took != 0) assertGe(v.equity, int256(v.initialMargin), "receiver above IM");
        _assertI2();
    }
}
