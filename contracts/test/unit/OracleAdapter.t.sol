// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IOracleAdapter} from "../../src/interfaces/IOracleAdapter.sol";
import {IPythMinimal} from "../../src/interfaces/external/IPythMinimal.sol";
import {AggregatorV3Interface} from "../../src/interfaces/external/AggregatorV3Interface.sol";
import {MockAggregatorV3} from "../../src/mocks/MockAggregatorV3.sol";
import {PythChainlinkOracleAdapter} from "../../src/oracle/PythChainlinkOracleAdapter.sol";
import {OracleMockPyth} from "./OracleMockPyth.sol";

contract OracleAdapterTest is Test {
    bytes32 constant ID = keccak256("MON/USD");
    uint256 constant FEE = 1 wei;
    uint256 constant T0 = 1_800_000_000;

    OracleMockPyth pyth;
    MockAggregatorV3 cl;
    PythChainlinkOracleAdapter oracle;
    address owner = makeAddr("owner");

    event PriceUpdated(uint256 priceWad, uint256 publishTime, IOracleAdapter.Source source);
    event DeviationGuardTripped(uint256 primaryWad, uint256 secondaryWad);
    event OracleParamsUpdated(uint256 maxStalenessSec, uint256 maxDeviationWad);

    function setUp() public {
        vm.warp(T0);
        pyth = new OracleMockPyth(FEE);
        cl = new MockAggregatorV3(8, 2_900_000); // 0.029 USD, 8 dp
        oracle = _deploy(address(cl));
        pyth.setPrice(ID, 2_900_000, 1000, -8, T0); // 0.029, conf 0.00001
    }

    function _deploy(address secondary) internal returns (PythChainlinkOracleAdapter) {
        return new PythChainlinkOracleAdapter(
            owner, IPythMinimal(address(pyth)), ID, AggregatorV3Interface(secondary), 10, 0.02e18, 1 hours, "MON / USD"
        );
    }

    // ───────────────────────────── constructor ─────────────────────────────

    function test_constructor_setsParams() public view {
        assertEq(oracle.maxStaleness(), 10);
        assertEq(oracle.maxDeviation(), 0.02e18);
        assertEq(oracle.secondaryMaxStaleness(), 1 hours);
        assertEq(oracle.description(), "MON / USD");
        assertEq(oracle.owner(), owner);
        assertEq(address(oracle.pyth()), address(pyth));
        assertEq(oracle.priceId(), ID);
        assertEq(address(oracle.secondary()), address(cl));
        assertEq(oracle.secondaryScale(), 1e10); // 8 dp Chainlink answer · 1e10 = WAD
    }

    function test_constructor_revertsOnBadParams() public {
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        new PythChainlinkOracleAdapter(owner, IPythMinimal(address(pyth)), ID, cl, 0, 0.02e18, 1 hours, "x");
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        new PythChainlinkOracleAdapter(owner, IPythMinimal(address(pyth)), ID, cl, 3601, 0.02e18, 1 hours, "x");
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        new PythChainlinkOracleAdapter(owner, IPythMinimal(address(pyth)), ID, cl, 10, 0, 1 hours, "x");
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        new PythChainlinkOracleAdapter(owner, IPythMinimal(address(pyth)), ID, cl, 10, 0.1e18 + 1, 1 hours, "x");
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        new PythChainlinkOracleAdapter(owner, IPythMinimal(address(pyth)), ID, cl, 10, 0.02e18, 59, "x");
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        new PythChainlinkOracleAdapter(owner, IPythMinimal(address(pyth)), ID, cl, 10, 0.02e18, 2 days + 1, "x");
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        new PythChainlinkOracleAdapter(owner, IPythMinimal(address(0)), ID, cl, 10, 0.02e18, 1 hours, "x");
    }

    function test_constructor_revertsOnSecondaryDecimalsAbove18() public {
        MockAggregatorV3 bad = new MockAggregatorV3(19, 1);
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        _deploy(address(bad));
    }

    // ───────────────────────────── primary scaling ─────────────────────────────

    function test_getIndexPrice_expoMinus8() public view {
        (uint256 p, uint256 t) = oracle.getIndexPrice();
        assertEq(p, 0.029e18);
        assertEq(t, T0);
    }

    function test_getIndexPrice_expo0() public {
        _noGuard();
        pyth.setPrice(ID, 3, 0, 0, T0);
        (uint256 p,) = oracle.getIndexPrice();
        assertEq(p, 3e18);
    }

    function test_getIndexPrice_expoMinus18() public {
        _noGuard();
        pyth.setPrice(ID, 29e15, 0, -18, T0);
        (uint256 p,) = oracle.getIndexPrice();
        assertEq(p, 0.029e18);
    }

    function test_getIndexPrice_revertsExpoBelowMinus18() public {
        pyth.setPrice(ID, 29e16, 0, -19, T0);
        vm.expectRevert(IOracleAdapter.InvalidPrice.selector);
        oracle.getIndexPrice();
    }

    function test_getIndexPrice_revertsPositiveExpo() public {
        pyth.setPrice(ID, 1, 0, 1, T0);
        vm.expectRevert(IOracleAdapter.InvalidPrice.selector);
        oracle.getIndexPrice();
    }

    function test_getIndexPrice_revertsZeroPrice() public {
        pyth.setPrice(ID, 0, 0, -8, T0);
        vm.expectRevert(IOracleAdapter.InvalidPrice.selector);
        oracle.getIndexPrice();
    }

    function test_getIndexPrice_revertsNegativePrice() public {
        pyth.setPrice(ID, -1, 0, -8, T0);
        vm.expectRevert(IOracleAdapter.InvalidPrice.selector);
        oracle.getIndexPrice();
    }

    // ───────────────────────────── confidence ─────────────────────────────

    function test_getIndexPrice_confExactly1PercentOk() public {
        pyth.setPrice(ID, 2_900_000, 29_000, -8, T0);
        (uint256 p,) = oracle.getIndexPrice();
        assertEq(p, 0.029e18);
    }

    function test_getIndexPrice_revertsConfAbove1Percent() public {
        pyth.setPrice(ID, 2_900_000, 29_001, -8, T0);
        vm.expectRevert(IOracleAdapter.InvalidPrice.selector);
        oracle.getIndexPrice();
    }

    // ───────────────────────────── staleness ─────────────────────────────

    function test_getIndexPrice_atMaxStalenessOk() public {
        vm.warp(T0 + 10);
        cl.setAnswer(2_900_000);
        (uint256 p,) = oracle.getIndexPrice();
        assertEq(p, 0.029e18);
    }

    function test_getIndexPrice_revertsWhenStale() public {
        vm.warp(T0 + 11);
        vm.expectRevert(IOracleAdapter.StalePrice.selector);
        oracle.getIndexPrice();
    }

    function test_getIndexPrice_futurePublishTimeOk() public {
        pyth.setPrice(ID, 2_900_000, 0, -8, T0 + 2);
        (, uint256 t) = oracle.getIndexPrice();
        assertEq(t, T0 + 2);
    }

    function test_getIndexPrice_revertsWhenPythReverts() public {
        pyth.setRevertOnRead(true);
        vm.expectRevert(IOracleAdapter.StalePrice.selector);
        oracle.getIndexPrice();
    }

    // ───────────────────────────── secondary guard ─────────────────────────────

    function test_guard_deviationAtLimitOk() public {
        cl.setAnswer(2_958_000); // +2.0% vs 0.029 ⇒ |p−s|/s = 1.96% ≤ 2%
        oracle.getIndexPrice();
        cl.setAnswer(2_843_138); // s such that (p−s)/s ≈ 1.99998% ≤ 2%
        oracle.getIndexPrice();
    }

    function test_guard_revertsAboveMaxDeviation() public {
        cl.setAnswer(2_843_137); // (2_900_000 − 2_843_137)/2_843_137 = 2.00000...7% > 2%
        vm.expectRevert(IOracleAdapter.PriceDeviation.selector);
        oracle.getIndexPrice();
        cl.setAnswer(3_000_000); // p below s by 3.3%
        vm.expectRevert(IOracleAdapter.PriceDeviation.selector);
        oracle.getIndexPrice();
    }

    function test_guard_staleSecondaryIgnored() public {
        cl.setAnswer(5_000_000);
        cl.setUpdatedAt(T0 - 1 hours - 1);
        (uint256 p,) = oracle.getIndexPrice();
        assertEq(p, 0.029e18);
    }

    function test_guard_secondaryAtStalenessLimitStillGuards() public {
        cl.setAnswer(5_000_000);
        cl.setUpdatedAt(T0 - 1 hours);
        vm.expectRevert(IOracleAdapter.PriceDeviation.selector);
        oracle.getIndexPrice();
    }

    function test_guard_nonPositiveSecondaryIgnored() public {
        cl.setAnswer(0);
        oracle.getIndexPrice();
        cl.setAnswer(-5);
        oracle.getIndexPrice();
    }

    function test_guard_revertingSecondaryIgnored() public {
        RevertingAggregator bad = new RevertingAggregator();
        oracle = _deploy(address(bad));
        (uint256 p,) = oracle.getIndexPrice();
        assertEq(p, 0.029e18);
    }

    function test_guard_disabledWhenSecondaryZero() public {
        oracle = _deploy(address(0));
        cl.setAnswer(5_000_000);
        (uint256 p,) = oracle.getIndexPrice();
        assertEq(p, 0.029e18);
    }

    function test_guard_scalesNon8DecimalFeeds() public {
        MockAggregatorV3 cl18 = new MockAggregatorV3(18, 0.029e18);
        oracle = _deploy(address(cl18));
        oracle.getIndexPrice();
        cl18.setAnswer(0.03e18);
        vm.expectRevert(IOracleAdapter.PriceDeviation.selector);
        oracle.getIndexPrice();
    }

    // ───────────────────────────── tryGetIndexPrice ─────────────────────────────

    function test_tryGet_ok() public view {
        (bool ok, uint256 p, uint256 t) = oracle.tryGetIndexPrice();
        assertTrue(ok);
        assertEq(p, 0.029e18);
        assertEq(t, T0);
    }

    function test_tryGet_neverRevertsOnFailures() public {
        vm.warp(T0 + 11);
        cl.setAnswer(2_900_000);
        _assertTryFails(); // stale
        pyth.setPrice(ID, 0, 0, -8, T0 + 11);
        _assertTryFails(); // invalid
        pyth.setPrice(ID, 2_900_000, 0, -8, T0 + 11);
        cl.setAnswer(3_500_000);
        _assertTryFails(); // deviation
        pyth.setRevertOnRead(true);
        _assertTryFails(); // pyth reverts
    }

    function test_tryGet_extremeValuesNeverRevert() public {
        pyth.setPrice(ID, 2_900_000, 0, -8, type(uint256).max); // far-future publishTime
        cl.setAnswer(type(int256).max); // saturates, trips the guard
        _assertTryFails();
        cl.setUpdatedAt(type(uint256).max);
        _assertTryFails();
        pyth.setPrice(ID, type(int64).max, 0, 0, T0);
        cl.setAnswer(type(int256).max);
        _assertTryFails();
    }

    function _assertTryFails() internal view {
        (bool ok,,) = oracle.tryGetIndexPrice();
        assertFalse(ok);
    }

    // ───────────────────────────── updatePrice ─────────────────────────────

    function _update(int64 price, uint256 publishTime) internal pure returns (bytes[] memory data) {
        data = new bytes[](1);
        data[0] = abi.encode(ID, price, uint64(0), int32(-8), publishTime);
    }

    function test_updateFee_passthrough() public view {
        bytes[] memory data = new bytes[](3);
        assertEq(oracle.updateFee(data), 3 * FEE);
    }

    function test_updatePrice_pushesAndEmits() public {
        vm.warp(T0 + 30);
        cl.setAnswer(2_910_000);
        bytes[] memory data = _update(2_910_000, T0 + 30);
        vm.expectEmit(address(oracle));
        emit PriceUpdated(0.0291e18, T0 + 30, IOracleAdapter.Source.Primary);
        oracle.updatePrice{value: FEE}(data);
        (uint256 p, uint256 t) = oracle.getIndexPrice();
        assertEq(p, 0.0291e18);
        assertEq(t, T0 + 30);
    }

    function test_updatePrice_refundsExcess() public {
        address keeper = makeAddr("keeper");
        vm.deal(keeper, 1 ether);
        vm.prank(keeper);
        oracle.updatePrice{value: 1 ether}(_update(2_900_000, T0));
        assertEq(keeper.balance, 1 ether - FEE);
        assertEq(address(pyth).balance, FEE);
        assertEq(address(oracle).balance, 0);
    }

    function test_updatePrice_revertsInsufficientFee() public {
        bytes[] memory data = _update(2_900_000, T0);
        vm.expectRevert(IOracleAdapter.InsufficientUpdateFee.selector);
        oracle.updatePrice{value: FEE - 1}(data);
    }

    function test_updatePrice_emitsDeviationGuardTripped() public {
        cl.setAnswer(3_500_000);
        vm.expectEmit(address(oracle));
        emit DeviationGuardTripped(0.029e18, 0.035e18);
        oracle.updatePrice{value: FEE}(_update(2_900_000, T0));
    }

    function test_updatePrice_revertsWhenRefundRejected() public {
        NoReceive nr = new NoReceive();
        vm.deal(address(nr), 1 ether);
        bytes[] memory data = _update(2_900_000, T0);
        vm.expectRevert();
        nr.push{value: 2 wei}(oracle, data);
        // exact fee (no refund) works for the same caller
        nr.push{value: FEE}(oracle, data);
    }

    function test_updatePrice_blocksReentrancy() public {
        Reenterer r = new Reenterer(oracle, _update(2_900_000, T0));
        vm.deal(address(r), 1 ether);
        r.go{value: 2 wei}();
        // The re-entrant call inside the refund hit the guard, not some other failure.
        assertEq(
            r.reentryError(), abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(address(r).balance, 1 ether + 2 wei - FEE); // outer refund still paid
    }

    // ───────────────────────────── admin ─────────────────────────────

    function test_setOracleParams() public {
        vm.expectEmit(address(oracle));
        emit OracleParamsUpdated(60, 0.03e18);
        vm.prank(owner);
        oracle.setOracleParams(60, 0.03e18);
        assertEq(oracle.maxStaleness(), 60);
        assertEq(oracle.maxDeviation(), 0.03e18);
    }

    function test_setOracleParams_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        oracle.setOracleParams(60, 0.03e18);
    }

    function test_setOracleParams_revertsOutOfBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        oracle.setOracleParams(0, 0.02e18);
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        oracle.setOracleParams(3601, 0.02e18);
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        oracle.setOracleParams(10, 0);
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        oracle.setOracleParams(10, 0.1e18 + 1);
        vm.stopPrank();
    }

    // ───────────────────────────── fuzz ─────────────────────────────

    /// Scaling is exact for every expo in [−18, 0]: priceWad / 10^(18+expo) == price, no rounding.
    function testFuzz_scalingExact(int64 price, int32 expo) public {
        _noGuard();
        price = int64(bound(price, 1, type(int64).max));
        expo = int32(bound(expo, -18, 0));
        pyth.setPrice(ID, price, 0, expo, T0);
        (uint256 p,) = oracle.getIndexPrice();
        uint256 scale = 10 ** uint256(int256(18 + expo));
        assertEq(p, uint256(int256(price)) * scale);
        assertEq(p / scale, uint256(int256(price)));
    }

    /// The guard trips iff |p−s|·1e18 > maxDev·s (exact comparison, no rounding).
    function testFuzz_guardBoundary(uint256 s) public {
        s = bound(s, 1_000_000, 10_000_000);
        cl.setAnswer(int256(s));
        uint256 p = 2_900_000;
        uint256 diff = p > s ? p - s : s - p;
        (bool ok,,) = oracle.tryGetIndexPrice();
        assertEq(ok, diff * 1e18 <= 0.02e18 * s);
    }

    function _noGuard() internal {
        oracle = _deploy(address(0));
    }
}

contract RevertingAggregator {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert("down");
    }
}

contract NoReceive {
    function push(PythChainlinkOracleAdapter o, bytes[] calldata data) external payable {
        o.updatePrice{value: msg.value}(data);
    }
}

contract Reenterer {
    PythChainlinkOracleAdapter immutable o;
    bytes[] data;

    constructor(PythChainlinkOracleAdapter o_, bytes[] memory d) {
        o = o_;
        data = d;
    }

    function go() external payable {
        o.updatePrice{value: msg.value}(data);
    }

    bytes public reentryError;

    receive() external payable {
        try o.updatePrice{value: 1 wei}(data) {}
        catch (bytes memory err) {
            reentryError = err;
        }
    }
}
