// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MeridianMfiFeed} from "../../src/oracle/MeridianMfiFeed.sol";
import {MeridianKeeperReceiver} from "../../src/automation/MeridianKeeperReceiver.sol";
import {IMeridianMfiFeed} from "../../src/interfaces/IMeridianMfiFeed.sol";
import {IMeridianKeeperReceiver} from "../../src/interfaces/IMeridianKeeperReceiver.sol";

/// @notice Example consumer (CR-016): any contract can price off the MFI, e.g. quote a fixed funding rate at MFI + 2%.
contract MfiConsumerExample {
    IMeridianMfiFeed public immutable feed;
    uint64 public constant MAX_AGE_BLOCKS = 12_000; // 1 h of 300 ms blocks

    constructor(IMeridianMfiFeed feed_) {
        feed = feed_;
    }

    /// @return aprWad MFI + 2 APR points; reverts when the feed is empty or older than an hour
    function fixedQuoteApr() external view returns (int256 aprWad) {
        (int256 mfi,,, uint64 at,) = feed.latest();
        require(at != 0 && block.number - at <= MAX_AGE_BLOCKS, "MFI stale");
        return mfi + 0.02e18;
    }
}

contract MeridianMfiFeedTest is Test {
    address internal fwd = address(0xF0F0);
    address internal owner = makeAddr("owner");
    MeridianKeeperReceiver internal r;
    MeridianMfiFeed internal feed;

    function setUp() public {
        vm.roll(1_000_000);
        r = new MeridianKeeperReceiver(fwd, owner);
        feed = new MeridianMfiFeed(address(r));
    }

    function _publish(int256 mfi, int256 mer, int256 perpl, uint64 b, uint64 pb) internal {
        vm.prank(fwd);
        r.onReport("", abi.encode(uint8(6), abi.encode(address(feed), mfi, mer, perpl, b, pb)));
    }

    function test_publishThroughTheReceiver_andConsumerReads() public {
        vm.expectEmit(address(feed));
        emit IMeridianMfiFeed.MfiPublished(0.106e18, 0.1095e18, 0.10512e18, 999_990, 999_000);
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(6, true, bytes32(0));
        _publish(0.106e18, 0.1095e18, 0.10512e18, 999_990, 999_000);
        (int256 mfi, int256 mer, int256 perpl, uint64 b, uint64 pb) = feed.latest();
        assertEq(mfi, 0.106e18);
        assertEq(mer, 0.1095e18);
        assertEq(perpl, 0.10512e18);
        assertEq(b, 999_990);
        assertEq(pb, 999_000);
        MfiConsumerExample c = new MfiConsumerExample(feed);
        assertEq(c.fixedQuoteApr(), 0.126e18);
        vm.roll(block.number + 12_100);
        vm.expectRevert(bytes("MFI stale"));
        c.fixedQuoteApr();
    }

    function test_emptyFeed() public {
        (,,, uint64 b,) = feed.latest();
        assertEq(b, 0);
        MfiConsumerExample c = new MfiConsumerExample(feed);
        vm.expectRevert(bytes("MFI stale"));
        c.fixedQuoteApr();
        assertEq(feed.receiver(), address(r));
    }

    function test_onlyReceiver() public {
        vm.expectRevert(IMeridianMfiFeed.OnlyReceiver.selector);
        feed.publish(0, 0, 0, 1, 0);
        vm.prank(fwd);
        vm.expectRevert(IMeridianMfiFeed.OnlyReceiver.selector);
        feed.publish(0, 0, 0, 1, 0);
    }

    function test_staleReplayAndFutureRejected() public {
        vm.startPrank(address(r));
        feed.publish(0.1e18, 0.1e18, 0.1e18, 999_990, 0);
        vm.expectRevert(abi.encodeWithSelector(IMeridianMfiFeed.StaleObservation.selector, 999_990, 999_990));
        feed.publish(0.1e18, 0.1e18, 0.1e18, 999_990, 0); // replay
        vm.expectRevert(abi.encodeWithSelector(IMeridianMfiFeed.StaleObservation.selector, 999_000, 999_990));
        feed.publish(0.1e18, 0.1e18, 0.1e18, 999_000, 0); // older
        vm.expectRevert(abi.encodeWithSelector(IMeridianMfiFeed.StaleObservation.selector, 1_000_001, 999_990));
        feed.publish(0.1e18, 0.1e18, 0.1e18, 1_000_001, 0); // future
        vm.expectRevert(abi.encodeWithSelector(IMeridianMfiFeed.StaleObservation.selector, 0, 999_990));
        feed.publish(0.1e18, 0.1e18, 0.1e18, 0, 0);
        vm.stopPrank();
    }

    function test_boundsRejected() public {
        vm.startPrank(address(r));
        vm.expectRevert(abi.encodeWithSelector(IMeridianMfiFeed.AprOutOfBounds.selector, int256(10e18 + 1)));
        feed.publish(0.1e18, 10e18 + 1, 0.1e18, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(IMeridianMfiFeed.AprOutOfBounds.selector, -int256(10e18 + 1)));
        feed.publish(0.1e18, 0.1e18, -10e18 - 1, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(IMeridianMfiFeed.AprOutOfBounds.selector, int256(0.3e18)));
        feed.publish(0.3e18, 0.1e18, 0.2e18, 1, 0); // above both venues
        vm.expectRevert(abi.encodeWithSelector(IMeridianMfiFeed.AprOutOfBounds.selector, int256(-0.01e18)));
        feed.publish(-0.01e18, 0.1e18, 0.2e18, 1, 0); // below both venues
        feed.publish(10e18, 10e18, 10e18, 1, 0); // edges are inside
        feed.publish(-10e18, -10e18, -10e18, 2, 0);
        vm.stopPrank();
    }

    /// The receiver turns a feed revert (stale replay) into success = false, never a reverted report.
    function test_replayThroughTheReceiverIsAFailureNotARevert() public {
        _publish(0.1e18, 0.1e18, 0.1e18, 999_990, 0);
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(6, false, bytes32(0));
        _publish(0.2e18, 0.2e18, 0.2e18, 999_990, 0);
        (int256 mfi,,,,) = feed.latest();
        assertEq(mfi, 0.1e18, "unchanged");
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(6, false, bytes32(0));
        vm.prank(fwd);
        r.onReport(
            "", abi.encode(uint8(6), abi.encode(address(0xBEEF), int256(0), int256(0), int256(0), uint64(1), uint64(0)))
        );
    }

    /// Any MFI inside [min, max] of the venues at a later block is accepted and stored verbatim.
    function testFuzz_publish_acceptsMeansStoresVerbatim(int256 mer, int256 perpl, uint256 wBps, uint64 b) public {
        mer = bound(mer, -10e18, 10e18);
        perpl = bound(perpl, -10e18, 10e18);
        wBps = bound(wBps, 0, 10_000);
        b = uint64(bound(b, 1, block.number));
        // OI-weighted mean, truncated toward zero (docs/MFI.md §4.4): stays within [min, max]
        int256 mfi = (mer * int256(wBps) + perpl * int256(10_000 - wBps)) / 10_000;
        vm.prank(address(r));
        feed.publish(mfi, mer, perpl, b, 7);
        (int256 m, int256 a, int256 p, uint64 bb, uint64 pb) = feed.latest();
        assertEq(m, mfi);
        assertEq(a, mer);
        assertEq(p, perpl);
        assertEq(bb, b);
        assertEq(pb, 7);
    }
}
