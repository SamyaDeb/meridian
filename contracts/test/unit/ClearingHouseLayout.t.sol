// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {ClearingHouseBase} from "./ClearingHouseBase.t.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {IClearingHouse} from "../../src/interfaces/IClearingHouse.sol";
import {IOrderBook} from "../../src/interfaces/IOrderBook.sol";
import {FundingParams, FundingState, RiskParams} from "../../src/interfaces/MeridianTypes.sol";

/// @notice Phase 3 gas hardening (ws-02b-gas): the storage packing and the touch-free release keep behaviour.
contract ClearingHouseLayoutTest is ClearingHouseBase {
    uint256 constant MAX_RATE_CAP = 2_777_777_777_778;

    /// FundingParams live in ONE packed slot now: every value the setter accepts reads back unchanged.
    function testFuzz_fundingParams_packRoundTrip(
        uint256 alpha,
        uint256 cap,
        uint256 delta,
        int256 interest,
        uint256 bt,
        uint256 band
    ) public {
        FundingParams memory p;
        p.alpha = bound(alpha, 1, 0.5e18);
        p.rateCap = bound(cap, 1, MAX_RATE_CAP);
        p.maxRateChangePerBlock = bound(delta, 1, p.rateCap);
        p.interestRate = bound(interest, -int256(p.rateCap), int256(p.rateCap));
        p.blockTimeMs = bound(bt, 100, 2000);
        p.premiumBandWad = bound(band, 0, 0.5e18);
        vm.prank(owner);
        ch.setFundingParams(p);
        FundingParams memory r = ch.fundingParams();
        assertEq(r.alpha, p.alpha, "alpha");
        assertEq(r.interestRate, p.interestRate, "interest");
        assertEq(r.rateCap, p.rateCap, "cap");
        assertEq(r.maxRateChangePerBlock, p.maxRateChangePerBlock, "delta");
        assertEq(r.blockTimeMs, p.blockTimeMs, "blockTime");
        assertEq(r.premiumBandWad, p.premiumBandWad, "band");
    }

    function test_fundingParams_extremesRoundTrip() public {
        FundingParams memory p = FundingParams(0.5e18, -int256(MAX_RATE_CAP), MAX_RATE_CAP, MAX_RATE_CAP, 2000, 0.5e18);
        vm.prank(owner);
        ch.setFundingParams(p);
        FundingParams memory r = ch.fundingParams();
        assertEq(abi.encode(r), abi.encode(p));
        p = FundingParams(1, 0, 1, 1, 100, 0);
        vm.prank(owner);
        ch.setFundingParams(p);
        assertEq(abi.encode(ch.fundingParams()), abi.encode(p));
    }

    /// The imr copy in the orderBook slot follows setRiskParams (reservation uses it).
    function test_imrCacheFollowsRiskParams() public {
        RiskParams memory r = _risk();
        r.imr = 0.5e18;
        r.mmr = 0.25e18;
        vm.prank(owner);
        ch.setRiskParams(r);
        _deposit(alice, 100e6);
        vm.prank(alice);
        ob.placeLimitOrder(true, 20_000, 20, 0); // 20 @ 2 ⇒ reserve 20 at imr 50%
        assertEq(_acct(alice).reservedOrderMargin, 20e18);
        vm.prank(alice);
        ob.cancelOrder(1);
        assertEq(_acct(alice).reservedOrderMargin, 0);
    }

    /// Cancel no longer touches funding: no FundingUpdated, lastUpdateBlock unchanged, and the next touch accrues
    /// over the whole gap exactly as if the cancel had not happened (same F, G, EMA, rate).
    function test_release_doesNotTouchFunding() public {
        _deposit(alice, 100e6);
        _deposit(bob, 100e6);
        _trade(bob, alice, true, 10, 2.01e18); // a position so funding has something to settle
        vm.prank(alice);
        (uint64 id,) = ob.placeLimitOrder(true, 19_000, 5, 0);
        uint256 snap = vm.snapshotState();

        _roll(50);
        uint64 before = ch.fundingState().lastUpdateBlock;
        vm.recordLogs();
        vm.prank(alice);
        ob.cancelOrder(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countFundingUpdated(logs), 0, "cancel emitted FundingUpdated");
        assertEq(ch.fundingState().lastUpdateBlock, before, "cancel touched funding");
        _roll(50);
        ch.updateFunding();
        FundingState memory withCancel = ch.fundingState();

        vm.revertToState(snap);
        _roll(100);
        ch.updateFunding();
        FundingState memory without = ch.fundingState();
        assertEq(abi.encode(withCancel), abi.encode(without), "gap accrual differs");
    }

    function test_setOrderBook_rejectsTickSizeOutsideUint64() public {
        ClearingHouse c2 = new ClearingHouse(address(ausd), address(oracle), address(fund), _risk(), _funding(), owner);
        address fake = makeAddr("fakeBook");
        vm.mockCall(fake, abi.encodeCall(IOrderBook.tickSize, ()), abi.encode(uint256(type(uint64).max) + 1));
        vm.prank(owner);
        vm.expectRevert(IClearingHouse.InvalidParams.selector);
        c2.setOrderBook(fake);
        vm.mockCall(fake, abi.encodeCall(IOrderBook.tickSize, ()), abi.encode(uint256(0)));
        vm.prank(owner);
        vm.expectRevert(IClearingHouse.InvalidParams.selector);
        c2.setOrderBook(fake);
    }

    /// Prices are stored as uint96 (mark ≤ 1.05·index): an index above uint96.max/2 is treated as a stale oracle.
    function test_indexAboveUint96IsStale() public {
        _roll(3);
        ch.updateFunding();
        int256 g0 = ch.fundingState().cumIndexTime;
        oracle.setPrice(uint256(type(uint96).max) / 2 + 1);
        _roll(3);
        ch.updateFunding();
        assertEq(ch.fundingState().cumIndexTime, g0, "accrued on an out-of-range index");
        assertEq(ch.indexPrice(), I0, "last good index");
        oracle.setPrice(type(uint96).max / 2);
        _roll(1);
        ch.updateFunding();
        assertGt(ch.fundingState().cumIndexTime, g0, "uint96.max/2 is a valid index");
        assertLe(ch.markPrice(), type(uint96).max, "mark fits");
    }
}
