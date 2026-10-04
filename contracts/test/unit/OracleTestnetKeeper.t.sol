// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TestnetKeeperOracle} from "../../src/oracle/TestnetKeeperOracle.sol";
import {IOracleAdapter} from "../../src/interfaces/IOracleAdapter.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {RiskParams, FundingParams} from "../../src/interfaces/PulseTypes.sol";

contract OracleTestnetKeeperTest is Test {
    TestnetKeeperOracle o;
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address eve = makeAddr("eve");

    function setUp() public {
        vm.warp(1_790_000_000);
        o = new TestnetKeeperOracle(owner, 60, 0.02e18, "MON/USD");
        vm.prank(owner);
        o.setFeeder(keeper, true);
    }

    function _push(uint256 p, uint256 t) internal {
        vm.prank(keeper);
        o.pushPrice(p, t);
    }

    // ─── deployment guard ───────────────────────────────────────────────
    function test_constructor_refusesMainnet() public {
        vm.chainId(143);
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        new TestnetKeeperOracle(owner, 60, 0.02e18, "MON/USD");
    }

    function test_constructor_refusesOtherChains() public {
        uint256[3] memory ids = [uint256(1), 8453, 10_144];
        for (uint256 i; i < ids.length; ++i) {
            vm.chainId(ids[i]);
            vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
            new TestnetKeeperOracle(owner, 60, 0.02e18, "MON/USD");
        }
    }

    function test_constructor_testnetAndAnvil() public {
        vm.chainId(10_143);
        TestnetKeeperOracle t = new TestnetKeeperOracle(owner, 60, 0.02e18, "MON/USD");
        assertEq(t.description(), unicode"TESTNET ONLY – keeper-fed MON/USD");
        assertEq(t.name(), unicode"TESTNET ONLY – keeper-fed");
        assertEq(t.maxStaleness(), 60);
        assertEq(t.maxDeviation(), 0.02e18);
        assertEq(t.owner(), owner);
        vm.chainId(31_337);
        new TestnetKeeperOracle(owner, 1, 0.1e18, "x");
    }

    function test_constructor_paramBounds() public {
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        new TestnetKeeperOracle(owner, 0, 0.02e18, "x");
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        new TestnetKeeperOracle(owner, 3601, 0.02e18, "x");
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        new TestnetKeeperOracle(owner, 60, 0, "x");
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        new TestnetKeeperOracle(owner, 60, 0.1e18 + 1, "x");
    }

    // ─── admin ──────────────────────────────────────────────────────────
    function test_setFeeder_onlyOwnerNonZero() public {
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        o.setFeeder(eve, true);
        vm.prank(owner);
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        o.setFeeder(address(0), true);
        vm.expectEmit(address(o));
        emit TestnetKeeperOracle.FeederSet(keeper, false);
        vm.prank(owner);
        o.setFeeder(keeper, false);
        assertFalse(o.isFeeder(keeper));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        o.pushPrice(0.029e18, block.timestamp);
    }

    function test_setOracleParams() public {
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        o.setOracleParams(10, 0.01e18);
        vm.expectEmit(address(o));
        emit IOracleAdapter.OracleParamsUpdated(10, 0.01e18);
        vm.prank(owner);
        o.setOracleParams(10, 0.01e18);
        assertEq(o.maxStaleness(), 10);
        vm.prank(owner);
        vm.expectRevert(IOracleAdapter.InvalidOracleParams.selector);
        o.setOracleParams(0, 0.01e18);
    }

    // ─── pushes ─────────────────────────────────────────────────────────
    function test_push_onlyFeeder() public {
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        o.pushPrice(0.029e18, block.timestamp);
        bytes[] memory d = new bytes[](1);
        d[0] = abi.encode(uint256(0.029e18), block.timestamp);
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        o.updatePrice(d);
    }

    function test_push_emitsAndStores() public {
        vm.expectEmit(address(o));
        emit IOracleAdapter.PriceUpdated(0.029e18, block.timestamp, IOracleAdapter.Source.Primary);
        _push(0.029e18, block.timestamp);
        (uint256 p, uint256 t) = o.getIndexPrice();
        assertEq(p, 0.029e18);
        assertEq(t, block.timestamp);
    }

    function test_push_rejectsBadValues() public {
        vm.startPrank(keeper);
        vm.expectRevert(IOracleAdapter.InvalidPrice.selector);
        o.pushPrice(0, block.timestamp);
        vm.expectRevert(IOracleAdapter.InvalidPrice.selector);
        o.pushPrice(uint256(type(uint128).max) + 1, block.timestamp);
        vm.expectRevert(IOracleAdapter.InvalidPrice.selector);
        o.pushPrice(1e18, uint256(type(uint128).max) + 1);
        o.pushPrice(0.03e18, block.timestamp);
        vm.expectRevert(IOracleAdapter.StalePrice.selector); // an older observation never overwrites a newer one
        o.pushPrice(0.02e18, block.timestamp - 1);
        o.pushPrice(0.031e18, block.timestamp); // same second is fine
        vm.stopPrank();
        (, uint256 p,) = o.tryGetIndexPrice();
        assertEq(p, 0.031e18);
    }

    function test_updatePrice_decodesLastElementAndRefunds() public {
        bytes[] memory d = new bytes[](2);
        d[0] = abi.encode(uint256(1e18), block.timestamp);
        d[1] = abi.encode(uint256(0.0291e18), block.timestamp);
        vm.deal(keeper, 1 ether);
        vm.prank(keeper);
        o.updatePrice{value: 0.1 ether}(d);
        assertEq(keeper.balance, 1 ether, "refund");
        (uint256 p,) = o.getIndexPrice();
        assertEq(p, 0.0291e18);
        assertEq(o.updateFee(d), 0);
        vm.prank(keeper);
        vm.expectRevert(IOracleAdapter.InvalidPrice.selector);
        o.updatePrice(new bytes[](0));
    }

    // ─── staleness (same semantics as the Pyth adapter) ────────────────
    function test_read_beforeFirstPush() public {
        vm.expectRevert(IOracleAdapter.InvalidPrice.selector);
        o.getIndexPrice();
        (bool ok,,) = o.tryGetIndexPrice();
        assertFalse(ok);
    }

    function test_read_staleness() public {
        _push(0.029e18, block.timestamp);
        skip(60);
        (bool ok,,) = o.tryGetIndexPrice();
        assertTrue(ok, "age == maxStaleness is fresh");
        skip(1);
        (ok,,) = o.tryGetIndexPrice();
        assertFalse(ok, "age > maxStaleness is stale");
        vm.expectRevert(IOracleAdapter.StalePrice.selector);
        o.getIndexPrice();
        (uint256 p, uint256 t) = o.latest();
        assertEq(p, 0.029e18);
        assertEq(t, block.timestamp - 61);
    }

    function test_read_futurePublishTimeIsFresh() public {
        _push(0.029e18, block.timestamp + 5);
        (bool ok,,) = o.tryGetIndexPrice();
        assertTrue(ok);
    }

    /// Review A-10: a publish time far in the future (ms pushed as s) is refused, so it can't freeze the price.
    function test_push_rejectsFarFuturePublishTime() public {
        vm.startPrank(keeper);
        o.pushPrice(0.029e18, block.timestamp + 60); // clock skew up to 60 s is fine
        vm.expectRevert(IOracleAdapter.InvalidPrice.selector);
        o.pushPrice(0.029e18, block.timestamp + 61);
        vm.expectRevert(IOracleAdapter.InvalidPrice.selector);
        o.pushPrice(0.029e18, block.timestamp * 1000); // milliseconds
        vm.stopPrank();
    }

    // ─── on the real ClearingHouse: fresh ⇒ accrual, stale ⇒ frozen ────
    function test_clearingHouse_accruesOnlyWhileFed() public {
        _push(0.029e18, block.timestamp);
        MockERC20 ausd = new MockERC20("Test AUSD", "tAUSD", 6);
        InsuranceFund fund = new InsuranceFund(address(ausd), owner);
        ClearingHouse ch = new ClearingHouse(
            address(ausd),
            address(o),
            address(fund),
            RiskParams(0.2e18, 0.1e18, 0.0005e18, -0.0001e18, 0.01e18, 0.5e18, 250_000e18, 25_000e18),
            FundingParams(0.002e18, 3_472_222_222, 555_555_555_556, 555_555_556, 300, 0.05e18),
            owner
        );
        vm.roll(block.number + 10);
        ch.updateFunding();
        int256 g1 = ch.fundingState().cumIndexTime;
        assertGt(g1, 0, "accrues while fed");
        skip(61);
        vm.roll(block.number + 10);
        ch.updateFunding();
        assertEq(ch.fundingState().cumIndexTime, g1, "frozen while stale");
        _push(0.03e18, block.timestamp);
        vm.roll(block.number + 1);
        ch.updateFunding();
        assertGt(ch.fundingState().cumIndexTime, g1, "resumes after a push");
        assertEq(ch.indexPrice(), 0.03e18);
    }
}
