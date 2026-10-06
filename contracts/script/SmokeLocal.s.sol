// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../src/mocks/MockOracleAdapter.sol";
import {IClearingHouse} from "../src/interfaces/IClearingHouse.sol";
import {IOrderBook} from "../src/interfaces/IOrderBook.sol";
import {IInsuranceFund} from "../src/interfaces/IInsuranceFund.sol";
import {AccountView} from "../src/interfaces/MeridianTypes.sol";

/// @notice Shared end-to-end scenario on anvil after DeployLocal (B's keeper/MM and C's indexer/app use it):
///   1. fund 3 anvil accounts with tAUSD and deposit (maker 10,000; long 60; liquidator 1,000); seed the IF
///   2. maker rests 3 bids and 3 asks around the index (0.029)
///   3. the long crosses with a market buy of 100 lots (10,000 MON ≈ 290 AUSD, ≈ 4.85x on 60 AUSD)
///   4. (the keeper advances funding from here: `updateFunding` pokes every ≤ 20 blocks)
///   5. oracle −15% (0.029 → 0.02465); the maker requotes around the new index (as the MM bot does)
///   6. `--sig "liquidate()"` (a later block): the liquidator liquidates the long. Skip it to leave it to the keeper.
/// The mark is cached once per block at the first touch (PHASES decision 2), so step 6 must run in a block after
/// the oracle move; that is why it is a separate entry point.
///
///   anvil --code-size-limit 131072 &
///   forge script script/DeployLocal.s.sol --fork-url http://localhost:8545 --broadcast --code-size-limit 131072
///   forge script script/SmokeLocal.s.sol  --fork-url http://localhost:8545 --broadcast --code-size-limit 131072
///   forge script script/SmokeLocal.s.sol  --fork-url http://localhost:8545 --broadcast --sig "liquidate()"
/// @dev Anvil's public dev keys #0–#3 (local only; the script refuses other chains). Run once per fresh deploy.
contract SmokeLocal is Script {
    using stdJson for string;

    uint256 internal constant PK_DEPLOYER = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant PK_MAKER = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant PK_LONG = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 internal constant PK_LIQUIDATOR = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;

    MockERC20 ausd;
    MockOracleAdapter oracle;
    IClearingHouse ch;
    IOrderBook ob;
    address fund;

    function _load() internal {
        require(block.chainid == 31_337, "SmokeLocal: anvil only");
        string memory dep = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/31337.json"));
        ausd = MockERC20(dep.readAddress(".contracts.AUSD"));
        oracle = MockOracleAdapter(dep.readAddress(".contracts.OracleAdapter"));
        ch = IClearingHouse(dep.readAddress(".contracts.ClearingHouse"));
        ob = IOrderBook(dep.readAddress(".contracts.OrderBook"));
        fund = dep.readAddress(".contracts.InsuranceFund");
    }

    function run() external {
        _load();
        address maker = vm.addr(PK_MAKER);
        address long = vm.addr(PK_LONG);
        address liquidator = vm.addr(PK_LIQUIDATOR);
        uint256 index0 = oracle.price();
        uint32 mid0 = uint32(index0 / ob.tickSize()); // 29,000 at 0.029

        // 1. fund + deposit; seed the insurance fund
        vm.startBroadcast(PK_DEPLOYER);
        ausd.mint(maker, 10_000e6);
        ausd.mint(long, 60e6);
        ausd.mint(liquidator, 1000e6);
        ausd.approve(fund, 1000e6);
        IInsuranceFund(fund).fund(1000e6);
        vm.stopBroadcast();
        _deposit(PK_MAKER, 10_000e6);
        _deposit(PK_LONG, 60e6);
        _deposit(PK_LIQUIDATOR, 1000e6);

        // 2. maker quotes 3 levels per side, 100 lots each, 10 ticks apart (10 ticks ≈ 3.4 bps at 0.029)
        uint64[] memory ids = new uint64[](6);
        vm.startBroadcast(PK_MAKER);
        for (uint256 i; i < 3; ++i) {
            (ids[i],) = ob.placeLimitOrder(true, mid0 - 10 * uint32(i + 1), 100, 0);
            (ids[3 + i],) = ob.placeLimitOrder(false, mid0 + 10 * uint32(i + 1), 100, 0);
        }
        vm.stopBroadcast();
        console2.log("book: bestBid tick", ob.bestBid(), "bestAsk tick", ob.bestAsk());

        // 3. the long crosses: market buy 100 lots, worst price = best ask
        vm.startBroadcast(PK_LONG);
        (uint64 filled, uint256 avgPx) = ob.placeMarketOrder(true, 100, ob.bestAsk(), 100, false);
        vm.stopBroadcast();
        AccountView memory a = ch.getAccount(long);
        console2.log("long filled lots", filled, "avg price wad", avgPx);
        console2.log("long size wad", uint256(a.size), "equity wad", uint256(a.equity));
        console2.log("long liq price wad", a.liquidationPrice);

        // 4. The keeper advances funding from here (updateFunding every <= 20 blocks); see keepers/ts-fallback.

        // 5. oracle -15%; the maker requotes around the new index
        uint256 index1 = index0 * 85 / 100;
        uint32 mid1 = uint32(index1 / ob.tickSize());
        vm.startBroadcast(PK_DEPLOYER);
        oracle.setPrice(index1);
        vm.stopBroadcast();
        vm.startBroadcast(PK_MAKER);
        for (uint256 i; i < 3; ++i) {
            ob.replaceOrder(ids[i], mid1 - 10 * uint32(i + 1), 100, 0);
        }
        // asks: the first level was taken by the long; requote the remaining two and re-add the first
        ob.replaceOrder(ids[4], mid1 + 20, 100, 0);
        ob.replaceOrder(ids[5], mid1 + 30, 100, 0);
        ob.placeLimitOrder(false, mid1 + 10, 100, 0);
        vm.stopBroadcast();
        console2.log("oracle now", index1, "; next: --sig \"liquidate()\" in a later block, or let the keeper do it");
    }

    /// @notice Step 6, in a block after the oracle move (fresh mark).
    function liquidate() external {
        _load();
        address long = vm.addr(PK_LONG);
        AccountView memory a = ch.getAccount(long);
        console2.log("mark wad", ch.markPrice(), "index wad", ch.indexPrice());
        console2.log("long equity wad", uint256(a.equity), "maintenance wad", a.maintenanceMargin);
        require(a.liquidatable, "SmokeLocal: long not liquidatable");
        _liquidate(long);
    }

    function _liquidate(address long) internal {
        uint256 ifBefore = ausd.balanceOf(fund);
        vm.startBroadcast(PK_LIQUIDATOR);
        int256 moved = ch.liquidate(long, type(uint256).max);
        vm.stopBroadcast();
        (uint256 lo, uint256 so) = ch.openInterest();
        console2.log("liquidated size wad", uint256(moved));
        console2.log("IF received token", ausd.balanceOf(fund) - ifBefore);
        console2.log("long size after", uint256(ch.getAccount(long).size));
        console2.log("longOI", lo, "shortOI", so);
        require(lo == so, "SmokeLocal: OI imbalance");
    }

    function _deposit(uint256 pk, uint256 amountToken) internal {
        vm.startBroadcast(pk);
        ausd.approve(address(ch), amountToken);
        ch.deposit(amountToken);
        vm.stopBroadcast();
    }
}
