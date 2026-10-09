// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {stdJson} from "forge-std/StdJson.sol";
import {AddMarketBase} from "./AddMarketBase.t.sol";
import {AddMarket} from "../../script/AddMarket.s.sol";
import {IMarketFactory} from "../../src/interfaces/IMarketFactory.sol";
import {RiskParams, FundingParams, AccountView} from "../../src/interfaces/MeridianTypes.sol";

/// @notice K7: `AddMarket` adds ETH-PERP to an existing deployment (PHASES decision 44) and the new market trades,
///         accrues funding and liquidates like MON-PERP, sharing the InsuranceFund and the factory.
contract AddMarketTest is AddMarketBase {
    using stdJson for string;

    function test_registersEthPerpInTheExistingFactory() public {
        _baseDeploy("register", vm.addr(PK), false);
        AddMarket.Out memory o = _addEth("register", 0);

        bytes32[] memory ids = factory.marketIds();
        assertEq(ids.length, 2, "MON-PERP + ETH-PERP");
        assertEq(ids[1], keccak256("ETH-PERP"));
        IMarketFactory.Market memory m = factory.getMarket(keccak256("ETH-PERP"));
        assertEq(m.symbol, "ETH-PERP");
        assertEq(m.clearingHouse, o.clearingHouse);
        assertEq(m.orderBook, o.orderBook);
        assertEq(m.oracle, o.oracle);
        assertEq(m.baseAsset, address(0), "no verified testnet WETH: informational field left empty");
        assertTrue(m.active);
        assertEq(factory.marketByClearingHouse(o.clearingHouse), keccak256("ETH-PERP"));
        // shared insurance fund, own clearing house
        assertTrue(fund.isAuthorized(o.clearingHouse), "IF authorization");
        assertTrue(fund.isAuthorized(address(monCh)), "MON-PERP untouched");
        assertEq(ch.insuranceFund(), address(fund));
        assertEq(ch.collateralToken(), address(ausd));
        assertEq(ch.oracle(), o.oracle);
        assertEq(ch.orderBook(), o.orderBook);
        assertTrue(o.clearingHouse != address(monCh));
        assertEq(ch.owner(), deployer);
        assertEq(oracle.owner(), deployer);
    }

    function test_ethParams() public {
        _baseDeploy("params", vm.addr(PK), false);
        _addEth("params", 0);
        assertEq(ob.tickSize(), 0.1e18, "tick 0.10 USD");
        assertEq(ob.lotSize(), 0.001e18, "lot 0.001 ETH");
        RiskParams memory r = ch.riskParams();
        assertEq(r.imr, 0.2e18);
        assertEq(r.mmr, 0.1e18);
        assertEq(r.takerFee, 0.0005e18);
        assertEq(r.makerFee, -0.0001e18);
        assertEq(r.liqPenalty, 0.01e18);
        assertEq(r.keeperShare, 0.5e18);
        assertEq(r.maxOpenInterest, 2.5e18, "2.5 ETH = MON-PERP's 250k MON in dollars");
        assertEq(r.maxPositionSize, 0.25e18, "0.25 ETH = MON-PERP's 25k MON in dollars");
        assertEq(r.maxPositionSize % ob.lotSize(), 0, "cap is whole lots");
        FundingParams memory f = ch.fundingParams();
        FundingParams memory g = monCh.fundingParams();
        assertEq(f.alpha, g.alpha);
        assertEq(f.interestRate, g.interestRate);
        assertEq(f.rateCap, g.rateCap);
        assertEq(f.maxRateChangePerBlock, g.maxRateChangePerBlock);
        assertEq(f.blockTimeMs, g.blockTimeMs);
        assertEq(f.premiumBandWad, g.premiumBandWad);
        assertEq(oracle.maxStaleness(), 60);
        assertEq(oracle.maxDeviation(), 0.02e18);
        assertEq(oracle.description(), unicode"TESTNET ONLY – keeper-fed ETH/USD");
        assertTrue(oracle.isFeeder(keeper), "keeper feeds");
        assertTrue(oracle.isFeeder(deployer), "operator can seed");
        // relative tick at the reference price ≈ MON-PERP's (0.39 bp)
        assertApproxEqRel(ob.tickSize() * 1e18 / ETH0, monOb.tickSize() * 1e18 / 0.0256e18, 0.01e18);
    }

    function test_seedsTheOracle() public {
        _baseDeploy("seed", vm.addr(PK), false);
        _addEth("seed", ETH0);
        (bool ok, uint256 p,) = oracle.tryGetIndexPrice();
        assertTrue(ok);
        assertEq(p, ETH0);
        assertEq(ch.indexPrice(), ETH0);
    }

    function test_recordGetsOnlyTheMarketsKey() public {
        _baseDeploy("record", vm.addr(PK), false);
        AddMarket.Out memory o = _addEth("record", 0);
        string memory j = vm.readFile(_path("record"));
        assertEq(j.readAddress(".contracts.ClearingHouse"), address(monCh), "contracts.* unchanged");
        assertEq(j.readAddress(".contracts.OrderBook"), address(monOb));
        assertEq(j.readAddressArray(".keeperAccounts")[0], keeper, "other keys survive");
        assertEq(j.readUint(".vaultStartBlock"), 68_775_102);
        assertEq(j.readString(".markets[0].symbol"), "ETH-PERP");
        assertEq(j.readAddress(".markets[0].ClearingHouse"), o.clearingHouse);
        assertEq(j.readAddress(".markets[0].OrderBook"), o.orderBook);
        assertEq(j.readAddress(".markets[0].OracleAdapter"), o.oracle);
        assertEq(j.readString(".markets[0].oracleKind"), "keeper-fed");
        assertEq(j.readString(".markets[0].feedSymbol"), "ETH/USD");
        assertEq(
            j.readBytes32(".markets[0].pythFeedId"), 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace
        );
        assertEq(j.readString(".markets[0].tickSizeWad"), "100000000000000000");
        assertEq(j.readString(".markets[0].lotSizeWad"), "1000000000000000");
        assertEq(j.readUint(".markets[0].startBlock"), o.startBlock);
        assertEq(j.readAddress(".markets[0].keeper"), keeper, "the oracle feeder");
        assertFalse(vm.keyExistsJson(j, ".markets[1]"));
    }

    function test_appendsToAnExistingMarketsList() public {
        _baseDeploy("append", vm.addr(PK), true);
        _addEth("append", 0);
        string memory j = vm.readFile(_path("append"));
        assertEq(j.readString(".markets[0].symbol"), "TEST-PERP", "earlier entry kept");
        assertEq(j.readUint(".markets[0].startBlock"), 7);
        assertEq(j.readAddress(".markets[0].ClearingHouse"), address(2));
        assertEq(j.readString(".markets[1].symbol"), "ETH-PERP");
    }

    function test_handsOverToTheRecordOwner() public {
        address safe = makeAddr("owner");
        _baseDeploy("handover", safe, false);
        _addEth("handover", ETH0);
        assertEq(ch.owner(), safe);
        assertEq(oracle.owner(), safe);
        assertTrue(oracle.isFeeder(keeper));
    }

    function test_refusesADuplicateSymbol() public {
        _baseDeploy("dup", vm.addr(PK), false);
        _addEth("dup", 0);
        AddMarket s = new AddMarket();
        AddMarket.Args memory a = _args("dup", 0);
        vm.expectRevert(bytes("market already registered"));
        s.runWith(a);
    }

    function test_refusesWhenTheDeployerDoesNotOwnTheFactory() public {
        _baseDeploy("notowner", vm.addr(PK), false);
        vm.prank(deployer);
        factory.transferOwnership(makeAddr("other"));
        AddMarket s = new AddMarket();
        AddMarket.Args memory a = _args("notowner", 0);
        vm.expectRevert(bytes("the deployer must own the MarketFactory"));
        s.runWith(a);
    }

    function test_refusesWhenTheDeployerDoesNotOwnTheFund() public {
        _baseDeploy("notowner-if", vm.addr(PK), false);
        vm.prank(deployer);
        fund.transferOwnership(makeAddr("other"));
        AddMarket s = new AddMarket();
        AddMarket.Args memory a = _args("notowner-if", 0);
        vm.expectRevert(bytes("the deployer must own the InsuranceFund"));
        s.runWith(a);
    }

    function test_refusesAnUnknownMarketKey() public {
        _baseDeploy("unknown", vm.addr(PK), false);
        AddMarket s = new AddMarket();
        AddMarket.Args memory a = _args("unknown", 0);
        a.marketKey = "doge";
        vm.expectRevert(bytes("MARKET_KEY: no markets.<key> in the config"));
        s.runWith(a);
    }

    /// SmokeFull-style: trade → funding → crash → liquidation on ETH-PERP, MON-PERP untouched.
    function test_smoke_tradeFundingLiquidation() public {
        _baseDeploy("smoke", vm.addr(PK), false);
        _addEth("smoke", ETH0);
        address mm = makeAddr("mm");
        address victim = makeAddr("victim");
        _fund(mm, 2000e6);
        _fund(victim, 30e6);
        _fund(keeper, 500e6);
        ausd.mint(address(this), 100e6);
        ausd.approve(address(fund), type(uint256).max);
        fund.fund(100e6);
        _roll(1); // the CH caches the oracle read once per block: its deploy block saw no price yet
        _push(ETH0);

        // 1. trade: 55 lots = 0.055 ETH ≈ 141.6 USD on 30 tAUSD ≈ 4.7x long
        uint32 t0 = _tick(ETH0);
        vm.prank(mm);
        ob.placeLimitOrder(false, t0 + 2, 55, 0);
        vm.prank(victim);
        (uint64 filled,) = ob.placeMarketOrder(true, 55, t0 + 10, 55, false);
        assertEq(filled, 55);
        assertEq(ch.getAccount(victim).size, 0.055e18);
        assertEq(ch.getAccount(mm).size, -0.055e18);

        // 2. funding: quotes around the index with a +1 tick skew; 200 blocks of keeper pushes
        vm.startPrank(mm);
        (uint64 bidId,) = ob.placeLimitOrder(true, t0, 5, 0);
        (uint64 ask2,) = ob.placeLimitOrder(false, t0 + 2, 5, 0);
        vm.stopPrank();
        int256 f0 = ch.fundingState().cumFunding;
        for (uint256 i; i < 20; ++i) {
            _roll(10);
            _push(ETH0);
            ch.updateFunding();
        }
        int256 f1 = ch.fundingState().cumFunding;
        assertGt(f1, f0, "F rises: longs pay");
        assertGt(ch.fundingState().rate, 0);
        AccountView memory v = ch.getAccount(victim);
        assertGt(v.pendingFunding, 0, "long owes");
        assertLt(ch.getAccount(mm).pendingFunding, 0, "short is owed");
        assertEq(monCh.fundingState().cumFunding, 0, "MON-PERP untouched");

        // 3. crash −15%: the MM re-quotes around the new index; liquidation in a later block
        vm.startPrank(mm);
        ob.cancelOrder(bidId);
        ob.cancelOrder(ask2);
        vm.stopPrank();
        uint256 p1 = ETH0 * 85 / 100;
        _roll(1);
        _push(p1);
        uint32 t1 = _tick(p1);
        vm.startPrank(mm);
        ob.placeLimitOrder(true, t1 - 1, 5, 0);
        ob.placeLimitOrder(false, t1 + 1, 5, 0);
        vm.stopPrank();
        _roll(1);
        _push(p1);
        assertTrue(ch.isLiquidatable(victim), "4.7x long liquidatable after -15%");
        uint256 ifBefore = fund.balance();
        vm.prank(keeper);
        int256 moved = ch.liquidate(victim, type(uint256).max);
        assertEq(moved, 0.055e18, "whole position to the liquidator");
        assertEq(ch.getAccount(victim).size, 0);
        assertEq(ch.getAccount(keeper).size, 0.055e18);
        assertGt(fund.balance(), ifBefore, "penalty share to the shared IF");
    }
}
