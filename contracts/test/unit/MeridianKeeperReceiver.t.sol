// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {MeridianKeeperReceiver} from "../../src/automation/MeridianKeeperReceiver.sol";
import {PythChainlinkOracleAdapter} from "../../src/oracle/PythChainlinkOracleAdapter.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {IMeridianKeeperReceiver} from "../../src/interfaces/IMeridianKeeperReceiver.sol";
import {IClearingHouse} from "../../src/interfaces/IClearingHouse.sol";
import {IMeridianVault} from "../../src/interfaces/IMeridianVault.sol";
import {IOracleAdapter} from "../../src/interfaces/IOracleAdapter.sol";
import {IOrderBook} from "../../src/interfaces/IOrderBook.sol";
import {IPythMinimal} from "../../src/interfaces/external/IPythMinimal.sol";
import {AggregatorV3Interface} from "../../src/interfaces/external/AggregatorV3Interface.sol";
import {AccountView} from "../../src/interfaces/MeridianTypes.sol";
import {IntegrationBase} from "./Integration.t.sol";
import {MeridianVaultBase} from "./MeridianVault.t.sol";
import {OracleMockPyth} from "./OracleMockPyth.sol";

/// @dev Report helpers shared by the receiver suites. `fwd` plays the KeystoneForwarder.
abstract contract ReceiverHelpers {
    bytes32 internal constant WF_ID = keccak256("meridian-liquidation-guardian");
    address internal fwd = address(0xF0F0);

    /// Production layout: workflowId ‖ bytes10 name ‖ owner ‖ bytes2 reportId = 64 bytes.
    function _meta64() internal pure returns (bytes memory) {
        return abi.encodePacked(WF_ID, bytes10("guardian01"), address(0xA11CE), bytes2(0x0001));
    }

    function _accounts1(address a) internal pure returns (address[] memory xs) {
        xs = new address[](1);
        xs[0] = a;
    }
}

/// @notice REAL ClearingHouse + OrderBook + InsuranceFund (IntegrationBase) with the settable mock oracle.
contract MeridianKeeperReceiverTest is IntegrationBase, ReceiverHelpers {
    MockOracleAdapter internal oracle;
    MeridianKeeperReceiver internal r;

    function _oracle() internal override returns (address) {
        oracle = new MockOracleAdapter(I0);
        return address(oracle);
    }

    function setUp() public override {
        super.setUp();
        r = new MeridianKeeperReceiver(fwd, owner);
        _marginFor(address(r), 1000e6);
        // the IF can absorb a penalty share and any bad debt
        ausd.mint(owner, 1000e6);
        vm.startPrank(owner);
        ausd.approve(address(fund), 1000e6);
        fund.fund(1000e6);
        vm.stopPrank();
    }

    function _marginFor(address who, uint256 amountToken) internal {
        ausd.mint(address(this), amountToken);
        ausd.approve(address(ch), amountToken);
        ch.depositFor(who, amountToken);
    }

    function _send(uint8 action, bytes memory payload) internal {
        vm.prank(fwd);
        r.onReport(_meta64(), abi.encode(action, payload));
    }

    function _liq(address[] memory accounts) internal {
        _send(2, abi.encode(address(ch), accounts));
    }

    /// bob ~4.85x long 10,000 MON; then the index falls 15% and the MM requotes ⇒ bob is liquidatable.
    function _crash() internal {
        _openBobLong();
        _drop15();
    }

    function _drop15() internal {
        _roll(1);
        oracle.setPrice(I0 * 85 / 100);
        _quote(uint32(I0 * 85 / 100 / TICK));
        _roll(1);
        assertTrue(ch.isLiquidatable(bob));
    }

    // ═══ access + decoding ═════════════════════════════════════════════════════

    function test_constructor_setsForwarderAndOwner() public view {
        assertEq(r.forwarder(), fwd);
        assertEq(r.owner(), owner);
    }

    function test_onReport_revertsUnlessForwarder() public {
        vm.expectRevert(IMeridianKeeperReceiver.OnlyForwarder.selector);
        r.onReport(_meta64(), abi.encode(uint8(3), abi.encode(new address[](0))));
        vm.prank(owner);
        vm.expectRevert(IMeridianKeeperReceiver.OnlyForwarder.selector);
        r.onReport("", abi.encode(uint8(3), abi.encode(new address[](0))));
    }

    function test_onReport_unknownAction() public {
        vm.prank(fwd);
        vm.expectRevert(abi.encodeWithSelector(IMeridianKeeperReceiver.UnknownAction.selector, uint8(0)));
        r.onReport(_meta64(), abi.encode(uint8(0), bytes("")));
        vm.prank(fwd);
        vm.expectRevert(abi.encodeWithSelector(IMeridianKeeperReceiver.UnknownAction.selector, uint8(7)));
        r.onReport(_meta64(), abi.encode(uint8(7), abi.encode(address(ch))));
        vm.prank(fwd);
        vm.expectRevert(abi.encodeWithSelector(IMeridianKeeperReceiver.UnknownAction.selector, uint8(255)));
        r.onReport(_meta64(), abi.encode(uint8(255), bytes("")));
    }

    function test_onReport_malformedReportReverts() public {
        vm.prank(fwd);
        vm.expectRevert();
        r.onReport(_meta64(), hex"0102");
    }

    function test_onReport_malformedPayloadReverts() public {
        vm.prank(fwd);
        vm.expectRevert();
        r.onReport(_meta64(), abi.encode(uint8(2), hex"deadbeef")); // not (address, address[])
        vm.prank(fwd);
        vm.expectRevert();
        r.onReport(_meta64(), abi.encode(uint8(3), hex"00")); // not address[]
    }

    function test_onReport_moreThan32ItemsReverts() public {
        vm.prank(fwd);
        vm.expectRevert(IOrderBook.BatchTooLarge.selector);
        r.onReport(_meta64(), abi.encode(uint8(2), abi.encode(address(ch), new address[](33))));
        vm.prank(fwd);
        vm.expectRevert(IOrderBook.BatchTooLarge.selector);
        r.onReport(_meta64(), abi.encode(uint8(3), abi.encode(new address[](33))));
        vm.prank(fwd);
        vm.expectRevert(IOrderBook.BatchTooLarge.selector);
        r.onReport(_meta64(), abi.encode(uint8(4), abi.encode(address(oracle), new bytes[](33))));
    }

    /// Simulation forwarder: no or short metadata ⇒ workflowId 0; 62 and 64 bytes ⇒ the first 32 bytes.
    function test_onReport_metadataLengths() public {
        bytes memory report = abi.encode(uint8(3), abi.encode(_accounts1(address(ch))));
        bytes[4] memory metas = [
            bytes(""), bytes(hex"00112233"), abi.encodePacked(WF_ID, bytes10("guardian01"), address(0xA11CE)), _meta64()
        ];
        bytes32[4] memory ids = [bytes32(0), bytes32(0), WF_ID, WF_ID];
        assertEq(metas[2].length, 62);
        assertEq(metas[3].length, 64);
        for (uint256 i; i < 4; ++i) {
            _roll(1);
            vm.expectEmit(address(r));
            emit IMeridianKeeperReceiver.ReportExecuted(3, true, ids[i]);
            vm.prank(fwd);
            r.onReport(metas[i], report);
        }
    }

    function test_supportsInterface() public view {
        assertTrue(r.supportsInterface(bytes4(keccak256("onReport(bytes,bytes)"))), "IReceiver");
        assertTrue(r.supportsInterface(type(IERC165).interfaceId));
        assertTrue(r.supportsInterface(type(IMeridianKeeperReceiver).interfaceId));
        assertFalse(r.supportsInterface(0xffffffff));
        assertFalse(r.supportsInterface(0x12345678));
    }

    // ═══ admin ═════════════════════════════════════════════════════════════════

    function test_setForwarder_onlyOwner_andSwitchesGate() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        r.setForwarder(address(1));
        address prod = address(0xF8344CFd5c43616a4366C34E3EEE75af79a74482);
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ForwarderUpdated(prod);
        vm.prank(owner);
        r.setForwarder(prod);
        assertEq(r.forwarder(), prod);
        vm.prank(fwd);
        vm.expectRevert(IMeridianKeeperReceiver.OnlyForwarder.selector);
        r.onReport("", abi.encode(uint8(3), abi.encode(new address[](0))));
        vm.prank(prod);
        r.onReport("", abi.encode(uint8(3), abi.encode(new address[](0))));
    }

    function test_withdrawMargin_onlyOwner_andPays() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        r.withdrawMargin(address(ch), 1e6, address(this));
        vm.prank(owner);
        r.withdrawMargin(address(ch), 400e6, dave);
        assertEq(ausd.balanceOf(dave), 400e6);
        assertEq(ch.getAccount(address(r)).collateral, 600e18);
    }

    function test_sweeps_onlyOwner() public {
        ausd.mint(address(r), 5e6);
        vm.deal(address(r), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        r.sweepToken(address(ausd), dave, 5e6);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        r.sweepNative(payable(dave), 1 ether);
        vm.startPrank(owner);
        r.sweepToken(address(ausd), dave, 5e6);
        r.sweepNative(payable(dave), 1 ether);
        vm.stopPrank();
        assertEq(ausd.balanceOf(dave), 5e6);
        assertEq(dave.balance, 1 ether);
    }

    // ═══ 3 FUNDING_POKE ════════════════════════════════════════════════════════

    function test_fundingPoke_updatesTheIndex() public {
        _roll(15);
        assertLt(ch.fundingState().lastUpdateBlock, block.number);
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(3, true, WF_ID);
        _send(3, abi.encode(_accounts1(address(ch))));
        assertEq(ch.fundingState().lastUpdateBlock, block.number);
    }

    function test_fundingPoke_partialFailureStillPokesTheRest() public {
        _roll(15);
        address[] memory chs = new address[](3);
        chs[0] = dave; // EOA
        chs[1] = address(oracle); // a contract without updateFunding
        chs[2] = address(ch);
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(3, false, WF_ID);
        _send(3, abi.encode(chs));
        assertEq(ch.fundingState().lastUpdateBlock, block.number);
    }

    // ═══ 2 LIQUIDATE ═══════════════════════════════════════════════════════════

    function test_liquidate_receiverTakesThePosition() public {
        _crash();
        uint256 mark = ch.markPrice();
        vm.expectEmit(true, true, false, false, address(ch));
        emit IClearingHouse.Liquidated(bob, address(r), 10_000e18, mark, 0, 0, 0, 0);
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(2, true, WF_ID);
        _liq(_accounts1(bob));
        assertEq(ch.getPosition(bob).size, 0);
        assertEq(ch.getPosition(address(r)).size, 10_000e18, "the receiver is the liquidator");
        assertGt(ch.getAccount(address(r)).collateral, 1000e18, "keeper share of the penalty");
        assertFalse(ch.isLiquidatable(address(r)));
    }

    function test_liquidate_healthyAccountIsAFailureNotARevert() public {
        _openBobLong();
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(2, false, WF_ID);
        _liq(_accounts1(bob));
        assertEq(ch.getPosition(bob).size, 10_000e18);
    }

    function test_liquidate_partiallyFailingBatch() public {
        _openBobLong();
        _fund(alice, 1000e6);
        vm.prank(alice);
        ob.placeMarketOrder(true, 10, MID0 + 20, 10, false); // healthy 1,000 MON long
        _drop15();
        address[] memory xs = new address[](5);
        xs[0] = alice; // healthy: NotLiquidatable
        xs[1] = address(r); // self: skipped
        xs[2] = address(0); // flat
        xs[3] = bob; // liquidatable
        xs[4] = bob; // already flat by now
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(2, false, WF_ID);
        _liq(xs);
        assertEq(ch.getPosition(bob).size, 0, "the good item still went through");
        assertEq(ch.getPosition(address(r)).size, 10_000e18);
        assertEq(ch.getPosition(alice).size, 1000e18);
    }

    /// 15 AUSD of margin: IM capacity ≈ 15·0.98/(0.02465·0.2) ≈ 2,980 MON ⇒ 29 lots, not the whole 10,000.
    function test_liquidate_sizedToHeadroom() public {
        MeridianKeeperReceiver small = new MeridianKeeperReceiver(fwd, owner);
        _marginFor(address(small), 15e6);
        _crash();
        vm.prank(fwd);
        small.onReport(_meta64(), abi.encode(uint8(2), abi.encode(address(ch), _accounts1(bob))));
        int256 took = ch.getPosition(address(small)).size;
        assertGt(took, 0);
        assertLt(took, 10_000e18);
        assertEq(uint256(took) % LOT, 0, "whole lots");
        AccountView memory v = ch.getAccount(address(small));
        assertGe(v.equity, int256(v.initialMargin), "the receiver stays above IM");
        assertEq(ch.getPosition(bob).size, 10_000e18 - took);
    }

    function test_liquidate_noMarginIsAFailure() public {
        MeridianKeeperReceiver broke = new MeridianKeeperReceiver(fwd, owner);
        _crash();
        vm.expectEmit(address(broke));
        emit IMeridianKeeperReceiver.ReportExecuted(2, false, WF_ID);
        vm.prank(fwd);
        broke.onReport(_meta64(), abi.encode(uint8(2), abi.encode(address(ch), _accounts1(bob))));
        assertEq(ch.getPosition(bob).size, 10_000e18);
    }

    function test_liquidate_badClearingHouseIsAFailure() public {
        _crash();
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(2, false, WF_ID);
        _send(2, abi.encode(dave, _accounts1(bob))); // EOA
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(2, false, WF_ID);
        _send(2, abi.encode(address(oracle), _accounts1(bob))); // contract, not a CH
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(2, true, WF_ID);
        _send(2, abi.encode(dave, new address[](0))); // nothing to do
    }

    // ═══ CR-016 identity checks ═══════════════════════════════════════════════

    function test_setExpectedWorkflow_onlyOwnerAndEvent() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        r.setExpectedWorkflow(address(0xA11CE), WF_ID);
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ExpectedWorkflowUpdated(address(0xA11CE), WF_ID);
        vm.prank(owner);
        r.setExpectedWorkflow(address(0xA11CE), WF_ID);
        assertEq(r.expectedWorkflowOwner(), address(0xA11CE));
        assertEq(r.expectedWorkflowId(), WF_ID);
    }

    function test_identity_acceptsMatchingMetadata62and64() public {
        vm.prank(owner);
        r.setExpectedWorkflow(address(0xA11CE), WF_ID);
        bytes memory report = abi.encode(uint8(3), abi.encode(new address[](0)));
        vm.prank(fwd);
        r.onReport(_meta64(), report);
        vm.prank(fwd);
        r.onReport(abi.encodePacked(WF_ID, bytes10("other-name"), address(0xA11CE)), report);
    }

    function test_identity_rejectsWrongOwnerIdOrShortMetadata() public {
        bytes memory report = abi.encode(uint8(3), abi.encode(new address[](0)));
        vm.prank(owner);
        r.setExpectedWorkflow(address(0xA11CE), WF_ID);
        vm.prank(fwd);
        vm.expectRevert(abi.encodeWithSelector(IMeridianKeeperReceiver.InvalidWorkflowId.selector, bytes32(uint256(1))));
        r.onReport(abi.encodePacked(bytes32(uint256(1)), bytes10("guardian01"), address(0xA11CE), bytes2(0)), report);
        vm.prank(fwd);
        vm.expectRevert(abi.encodeWithSelector(IMeridianKeeperReceiver.InvalidWorkflowOwner.selector, address(0xB0B)));
        r.onReport(abi.encodePacked(WF_ID, bytes10("guardian01"), address(0xB0B), bytes2(0)), report);
        vm.prank(fwd);
        vm.expectRevert(abi.encodeWithSelector(IMeridianKeeperReceiver.InvalidWorkflowId.selector, bytes32(0)));
        r.onReport("", report); // the simulation forwarder's metadata can't pass a production check
        // owner-only check: a short metadata reports the owner error
        vm.prank(owner);
        r.setExpectedWorkflow(address(0xA11CE), bytes32(0));
        vm.prank(fwd);
        vm.expectRevert(abi.encodeWithSelector(IMeridianKeeperReceiver.InvalidWorkflowOwner.selector, address(0)));
        r.onReport(hex"00", report);
        // any id passes when only the owner is checked
        vm.prank(fwd);
        r.onReport(abi.encodePacked(bytes32(uint256(9)), bytes10("x"), address(0xA11CE), bytes2(0)), report);
        // both off again: anything from the forwarder goes
        vm.prank(owner);
        r.setExpectedWorkflow(address(0), bytes32(0));
        vm.prank(fwd);
        r.onReport("", report);
    }

    // ═══ 5 UNWIND (CR-016) ═════════════════════════════════════════════════════

    function _unwind(uint256 maxSize) internal {
        _send(5, abi.encode(address(ch), maxSize));
    }

    function test_unwind_closesTheInheritedLongReduceOnly() public {
        _crash();
        _liq(_accounts1(bob));
        assertEq(ch.getPosition(address(r)).size, 10_000e18);
        uint32 bid = ob.bestBid();
        assertGt(bid, 0);
        vm.expectEmit(true, false, false, true, address(r));
        emit IMeridianKeeperReceiver.Unwound(address(ch), false, 100, 100);
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(5, true, WF_ID);
        _unwind(type(uint256).max);
        assertEq(ch.getPosition(address(r)).size, 0, "flat after the IOC");
        assertFalse(ch.isLiquidatable(address(r)));
        _assertI2();
    }

    function test_unwind_partialMaxSizeThenRest() public {
        _crash();
        _liq(_accounts1(bob));
        _unwind(30 * LOT + 1); // whole lots only: 30
        assertEq(ch.getPosition(address(r)).size, 70 * int256(LOT));
        _unwind(type(uint256).max); // reduce-only: the rest, never past flat

        assertEq(ch.getPosition(address(r)).size, 0);
    }

    function test_unwind_buysBackAShort() public {
        // the receiver ends up short: it liquidates a short that a +25% move broke
        _fund(alice, 60e6);
        vm.prank(alice);
        ob.placeMarketOrder(false, 100, MID0 - 10, 100, false); // ~4.85x short
        _roll(1);
        uint256 p = I0 * 125 / 100;
        oracle.setPrice(p);
        _quote(uint32(p / TICK));
        _roll(1);
        assertTrue(ch.isLiquidatable(alice));
        _liq(_accounts1(alice));
        assertEq(ch.getPosition(address(r)).size, -10_000e18);
        vm.expectEmit(true, false, false, true, address(r));
        emit IMeridianKeeperReceiver.Unwound(address(ch), true, 100, 100);
        _unwind(type(uint256).max);
        assertEq(ch.getPosition(address(r)).size, 0);
    }

    function test_unwind_flatIsNothingToDo() public {
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(5, true, WF_ID);
        _unwind(type(uint256).max);
    }

    function test_unwind_staleIndexWaits() public {
        _crash();
        _liq(_accounts1(bob));
        oracle.setStale(true);
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(5, false, WF_ID);
        _unwind(type(uint256).max);
        assertEq(ch.getPosition(address(r)).size, 10_000e18);
    }

    function test_unwind_noLiquidityWithinOnePercentIsAFailure() public {
        _crash();
        _liq(_accounts1(bob));
        // the MM pulls its quotes: no bid within 1% of the index
        vm.startPrank(mm);
        for (uint256 i; i < mmIds.length; ++i) {
            if (ob.getOrder(mmIds[i]).remainingLots != 0) ob.cancelOrder(mmIds[i]);
        }
        vm.stopPrank();
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(5, false, WF_ID);
        _unwind(type(uint256).max);
        assertEq(ch.getPosition(address(r)).size, 10_000e18);
    }

    function test_unwind_badClearingHouseIsAFailure() public {
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(5, false, WF_ID);
        _send(5, abi.encode(dave, type(uint256).max));
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(5, false, WF_ID);
        _send(5, abi.encode(address(oracle), type(uint256).max));
    }

    function test_unwindLimitTick_matchesTheTsRule() public view {
        // index 0.02465, tick 1e-6: bid worst 0.0248965 → 24896; ask worst 0.0244035 → 24404 (ceil)
        assertEq(r.unwindLimitTick(true, 0.02465e18, TICK), 24_896);
        assertEq(r.unwindLimitTick(false, 0.02465e18, TICK), 24_404);
        assertEq(r.unwindLimitTick(true, 1e18, 0), 0);
    }

    /// Gas: a full 32-account liquidation report (32 × ~4.85x longs of 300 MON after a −15% move).
    function test_gas_liquidate32() public {
        address[] memory xs = new address[](32);
        for (uint256 i; i < 32; ++i) {
            xs[i] = makeAddr(string(abi.encodePacked("long", vm.toString(i))));
            _fund(xs[i], 1.8e6);
            vm.prank(xs[i]);
            ob.placeMarketOrder(true, 3, MID0 + 30, 3, false);
        }
        _roll(1);
        oracle.setPrice(I0 * 85 / 100);
        _quote(uint32(I0 * 85 / 100 / TICK));
        _roll(1);
        for (uint256 i; i < 32; ++i) {
            assertTrue(ch.isLiquidatable(xs[i]));
        }
        bytes memory report = abi.encode(uint8(2), abi.encode(address(ch), xs));
        bytes memory meta = _meta64();
        vm.prank(fwd);
        vm.startSnapshotGas("receiver", "liquidate32");
        r.onReport(meta, report);
        uint256 used = vm.stopSnapshotGas();
        for (uint256 i; i < 32; ++i) {
            assertEq(ch.getPosition(xs[i]).size, 0);
        }
        assertEq(ch.getPosition(address(r)).size, 9600e18);
        assertLt(used, 3_000_000, "a 32-account report fits 3M gas (keeper gas limit = estimate x 1.2)");
    }

    function test_gas_liquidate1_fundingPoke1_unwind() public {
        _crash();
        bytes memory meta = _meta64();
        bytes memory liq = abi.encode(uint8(2), abi.encode(address(ch), _accounts1(bob)));
        vm.prank(fwd);
        vm.startSnapshotGas("receiver", "liquidate1");
        r.onReport(meta, liq);
        vm.stopSnapshotGas();
        _roll(5);
        bytes memory poke = abi.encode(uint8(3), abi.encode(_accounts1(address(ch))));
        vm.prank(fwd);
        vm.startSnapshotGas("receiver", "fundingPoke1");
        r.onReport(meta, poke);
        vm.stopSnapshotGas();
        bytes memory unwind = abi.encode(uint8(5), abi.encode(address(ch), type(uint256).max));
        vm.prank(fwd);
        vm.startSnapshotGas("receiver", "unwind100lots");
        r.onReport(meta, unwind);
        vm.stopSnapshotGas();
        assertEq(ch.getPosition(address(r)).size, 0);
    }
}

/// @notice 4 ORACLE_UPDATE on the REAL PythChainlinkOracleAdapter over a mock Pyth that charges 1 wei per update.
contract MeridianKeeperReceiverOracleTest is IntegrationBase, ReceiverHelpers {
    bytes32 internal constant ID = 0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1;
    OracleMockPyth internal pyth;
    PythChainlinkOracleAdapter internal adapter;
    MeridianKeeperReceiver internal r;

    function _oracle() internal override returns (address) {
        pyth = new OracleMockPyth(1);
        pyth.setPrice(ID, 2_900_000, 1000, -8, block.timestamp);
        adapter = new PythChainlinkOracleAdapter(
            address(this),
            IPythMinimal(address(pyth)),
            ID,
            AggregatorV3Interface(address(0)),
            60,
            0.02e18,
            3600,
            "MON/USD"
        );
        return address(adapter);
    }

    function setUp() public override {
        super.setUp();
        r = new MeridianKeeperReceiver(fwd, owner);
    }

    function _update(int64 price) internal view returns (bytes memory) {
        bytes[] memory upd = new bytes[](1);
        upd[0] = abi.encode(ID, price, uint64(1000), int32(-8), block.timestamp);
        return abi.encode(address(adapter), upd);
    }

    function test_oracleUpdate_paysTheFeeAndPushes() public {
        vm.deal(address(r), 1 ether);
        vm.warp(block.timestamp + 10);
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(4, true, WF_ID);
        vm.prank(fwd);
        r.onReport(_meta64(), abi.encode(uint8(4), _update(3_000_000)));
        (uint256 p, uint256 t) = adapter.getIndexPrice();
        assertEq(p, 0.03e18);
        assertEq(t, block.timestamp);
        assertEq(address(r).balance, 1 ether - 1, "fee = updateFee(data) = 1 wei");
    }

    function test_oracleUpdate_noBalanceIsAFailure() public {
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(4, false, WF_ID);
        vm.prank(fwd);
        r.onReport(_meta64(), abi.encode(uint8(4), _update(3_000_000)));
        (uint256 p,) = adapter.getIndexPrice();
        assertEq(p, 0.029e18);
    }

    function test_oracleUpdate_badTargetOrDataIsAFailure() public {
        vm.deal(address(r), 1 ether);
        bytes[] memory none = new bytes[](0);
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(4, false, WF_ID);
        vm.prank(fwd);
        r.onReport(_meta64(), abi.encode(uint8(4), abi.encode(address(0xBEEF), none))); // no code
        bytes[] memory junk = new bytes[](1);
        junk[0] = hex"01";
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(4, false, WF_ID);
        vm.prank(fwd);
        r.onReport(_meta64(), abi.encode(uint8(4), abi.encode(address(adapter), junk))); // Pyth rejects it
    }

    function test_receive_acceptsMon() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(r).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(r).balance, 1 ether);
    }
}

/// @notice 1 VAULT_REBALANCE on the REAL MeridianVault (+ CH/OB, MockKuruHedger for spot).
contract MeridianKeeperReceiverVaultTest is MeridianVaultBase, ReceiverHelpers {
    MeridianKeeperReceiver internal r;

    function setUp() public override {
        super.setUp();
        r = new MeridianKeeperReceiver(fwd, owner);
    }

    function _send() internal {
        vm.prank(fwd);
        r.onReport(_meta64(), abi.encode(uint8(1), abi.encode(address(vault))));
    }

    function test_vaultRebalance_enterHedge() public {
        vm.prank(owner);
        vault.setKeeper(address(r), true);
        _whaleLong(1000);
        _setAvgApr(0.3e18);
        _deposit(alice, 10_000e6);
        assertEq(uint8(vault.needsRebalance()), uint8(IMeridianVault.RebalanceReason.EnterHedge));
        vm.expectEmit(true, false, false, false, address(vault));
        emit IMeridianVault.Rebalanced(IMeridianVault.RebalanceReason.EnterHedge, 0, 0, 0, 0);
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(1, true, WF_ID);
        _send();
        assertTrue(vault.hedgeState().hedged);
        assertLt(vault.hedgeState().perpSize, 0);
    }

    function test_vaultRebalance_notKeeperIsAFailure() public {
        _whaleLong(1000);
        _setAvgApr(0.3e18);
        _deposit(alice, 10_000e6);
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(1, false, WF_ID);
        _send(); // OnlyKeeper, caught
        assertFalse(vault.hedgeState().hedged);
    }

    function test_vaultRebalance_nothingToDoIsAFailure() public {
        vm.prank(owner);
        vault.setKeeper(address(r), true);
        vm.expectEmit(address(r));
        emit IMeridianKeeperReceiver.ReportExecuted(1, false, WF_ID);
        _send(); // NothingToDo, caught
    }

    function test_gas_vaultRebalance() public {
        vm.prank(owner);
        vault.setKeeper(address(r), true);
        _whaleLong(1000);
        _setAvgApr(0.3e18);
        _deposit(alice, 10_000e6);
        bytes memory meta = _meta64();
        bytes memory report = abi.encode(uint8(1), abi.encode(address(vault)));
        vm.prank(fwd);
        vm.startSnapshotGas("receiver", "vaultRebalance");
        r.onReport(meta, report);
        vm.stopSnapshotGas();
    }
}
