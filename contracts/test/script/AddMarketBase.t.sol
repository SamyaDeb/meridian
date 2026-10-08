// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {AddMarket} from "../../script/AddMarket.s.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {MarketFactory} from "../../src/clearing/MarketFactory.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {TestnetKeeperOracle} from "../../src/oracle/TestnetKeeperOracle.sol";
import {RiskParams, FundingParams} from "../../src/interfaces/MeridianTypes.sol";

/// @notice Fixture for the AddMarket tests: a small "existing deployment" (tAUSD, IF, factory, MON-PERP on a mock
///         oracle) on a chain-id-10143 test EVM, written as a deployment record with the extra keys the real
///         deployments/10143.json carries, then `AddMarket.runWith` on it. Records go to deployments/fork-test-*.json
///         (gitignored). No process env: parallel tests can't race.
abstract contract AddMarketBase is Test {
    using stdJson for string;

    uint256 internal constant PK = 0xD3B10A;
    uint256 internal constant ETH0 = 2574.63e18; // reference price (config markets.eth._params)
    address internal deployer;
    address internal keeper = makeAddr("keeper");

    MockERC20 internal ausd;
    InsuranceFund internal fund;
    MarketFactory internal factory;
    ClearingHouse internal monCh;
    OrderBook internal monOb;

    ClearingHouse internal ch;
    OrderBook internal ob;
    TestnetKeeperOracle internal oracle;

    function _baseDeploy(string memory recordName, address recordOwner, bool withMarkets) internal {
        vm.chainId(10_143);
        deployer = vm.addr(PK);
        vm.startPrank(deployer);
        ausd = new MockERC20("Test AUSD", "tAUSD", 6);
        fund = new InsuranceFund(address(ausd), deployer);
        factory = new MarketFactory(deployer);
        MockOracleAdapter monOracle = new MockOracleAdapter(0.0256e18);
        RiskParams memory r = RiskParams(0.2e18, 0.1e18, 0.0005e18, -0.0001e18, 0.01e18, 0.5e18, 250_000e18, 25_000e18);
        FundingParams memory f = FundingParams(0.002e18, 3_472_222_222, 555_555_555_556, 555_555_556, 300, 0.05e18);
        monCh = new ClearingHouse(address(ausd), address(monOracle), address(fund), r, f, deployer);
        monOb = new OrderBook(address(monCh), 1e12, 100e18);
        monCh.setOrderBook(address(monOb));
        fund.setMarketAuthorized(address(monCh), true);
        factory.registerMarket("MON-PERP", address(monOb), address(monCh), address(monOracle), address(0));
        vm.stopPrank();

        string memory c = string.concat("contracts-", recordName);
        c.serialize("AUSD", address(ausd));
        c.serialize("InsuranceFund", address(fund));
        c.serialize("ClearingHouse", address(monCh));
        c.serialize("OrderBook", address(monOb));
        string memory contracts = c.serialize("MarketFactory", address(factory));
        string memory root = string.concat("root-", recordName);
        address[] memory keepers = new address[](1);
        keepers[0] = keeper;
        root.serialize("chainId", uint256(10_143));
        root.serialize("owner", recordOwner);
        root.serialize("keeperAccounts", keepers);
        root.serialize("vaultStartBlock", uint256(68_775_102));
        string memory out = root.serialize("contracts", contracts);
        string memory path = _path(recordName);
        out.write(path);
        if (withMarkets) {
            // a market added by an earlier run: must survive the append
            vm.writeJson(
                string.concat(
                    '[{"symbol":"TEST-PERP","_label":"earlier","oracleKind":"keeper-fed","feedSymbol":"TEST/USD",',
                    '"pythFeedId":"0x00000000000000000000000000000000000000000000000000000000000000aa",',
                    '"tickSizeWad":"1000000000000000","lotSizeWad":"10000000000000000",',
                    '"baseAsset":"0x0000000000000000000000000000000000000000",',
                    '"OracleAdapter":"0x0000000000000000000000000000000000000001",',
                    '"ClearingHouse":"0x0000000000000000000000000000000000000002",',
                    '"OrderBook":"0x0000000000000000000000000000000000000003","startBlock":7}]'
                ),
                path,
                ".markets"
            );
        }
    }

    function _path(string memory recordName) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/../deployments/fork-test-addmarket-", recordName, ".json");
    }

    function _args(string memory recordName, uint256 seed) internal view returns (AddMarket.Args memory a) {
        string memory f = string.concat("fork-test-addmarket-", recordName, ".json");
        a = AddMarket.Args({
            marketKey: "eth", recordIn: f, recordOut: f, pk: PK, keeper: keeper, seedPriceWad: seed, seedPublishTime: 0
        });
    }

    function _addEth(string memory recordName, uint256 seed) internal returns (AddMarket.Out memory o) {
        o = new AddMarket().runWith(_args(recordName, seed));
        ch = ClearingHouse(o.clearingHouse);
        ob = OrderBook(o.orderBook);
        oracle = TestnetKeeperOracle(o.oracle);
    }

    function _fund(address who, uint256 amountToken) internal {
        ausd.mint(who, amountToken);
        vm.startPrank(who);
        ausd.approve(address(ch), type(uint256).max);
        ch.deposit(amountToken);
        vm.stopPrank();
    }

    function _push(uint256 priceWad) internal {
        vm.prank(keeper);
        oracle.pushPrice(priceWad, block.timestamp);
    }

    function _tick(uint256 priceWad) internal view returns (uint32) {
        return uint32(priceWad / ob.tickSize());
    }

    /// @dev Next block: +1 number, +1 s every third block (Monad ≈ 300 ms blocks, 1 s timestamps).
    function _roll(uint256 blocks) internal {
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + (blocks + 2) / 3);
    }
}
