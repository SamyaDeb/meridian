// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockKuruHedger} from "../src/mocks/MockKuruHedger.sol";
import {TestnetKeeperOracle} from "../src/oracle/TestnetKeeperOracle.sol";
import {IClearingHouse} from "../src/interfaces/IClearingHouse.sol";
import {IFundingRateOracle} from "../src/interfaces/IFundingRateOracle.sol";
import {IOrderBook} from "../src/interfaces/IOrderBook.sol";
import {IInsuranceFund} from "../src/interfaces/IInsuranceFund.sol";
import {IPulseVault} from "../src/interfaces/IPulseVault.sol";
import {IFundingSwapMarket} from "../src/interfaces/IFundingSwapMarket.sol";
import {AccountView, HedgeState, SwapAccountView} from "../src/interfaces/PulseTypes.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// @notice Full-stack local rehearsal (Phase 4 step 4) after `DeployPulse` with DEPLOY_VAULT=1 DEPLOY_SWAPS=1 on a
///         LOCAL anvil (chain id 10143 with LOCAL_REHEARSAL=1, or 31337). Entry points (see script/README.md):
///   run()        seed: price, IF, collateral (keeper, MM, taker, swap taker) on perp + swap market; the MM rests asks,
///                a taker goes 25,000 MON long (the MM ends short = the skew the vault may absorb); the MM rests a
///                bid wall at the index and an ask 2 ticks up (book mid = index + 1 tick ⇒ positive premium ⇒
///                funding above the 10.95% floor, so the vault's 8 h entry rule can pass); swap long/short fill at
///                12% APR; a depositor puts 1,000 tAUSD in the vault (stays idle: the entry rule needs 8 h history).
///   push()       one feeder push at the current price (keeps the keeper-fed oracle fresh while mining history).
///   report()     view-only: funding APRs, vault hedge state / capacity / share price, swap accounts, IF.
///   skewDrop()   the taker sells part of its long ⇒ capacity < vault short ⇒ needsRebalance = SkewCap.
///   crashSetup() a ≈ 4.9x long for the crash; crash() = oracle −15% (+ mock spot price); liquidate() in a LATER
///                block (the mark is cached once per block), or leave it to the keeper.
/// @dev Anvil public dev keys only; refuses anything but a local chain.
contract SmokeFull is Script {
    using stdJson for string;

    uint256 internal constant PK_DEPLOYER = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant PK_KEEPER = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant PK_MM = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 internal constant PK_TAKER = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
    uint256 internal constant PK_SWAP_TAKER = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;
    uint256 internal constant PK_DEPOSITOR = 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba;
    uint256 internal constant PK_VICTIM = 0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e;

    uint256 internal constant PRICE0 = 0.0266e18;
    uint64 internal constant TAKER_LOTS = 250; // 25,000 MON = maxPositionSize (launch cap)

    MockERC20 ausd;
    TestnetKeeperOracle oracle;
    IClearingHouse ch;
    IOrderBook ob;
    IInsuranceFund fund;
    IPulseVault vault;
    IFundingSwapMarket swap;
    IOrderBook sob;
    MockKuruHedger hedger;

    function _load() internal {
        require(
            block.chainid == 31_337 || (block.chainid == 10_143 && vm.envOr("LOCAL_REHEARSAL", false)),
            "SmokeFull: local anvil only (LOCAL_REHEARSAL=1 on a chain-id-10143 anvil)"
        );
        string memory name = vm.envOr("DEPLOYMENTS_OUT", string("anvil-10143.json"));
        string memory dep = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/", name));
        ausd = MockERC20(dep.readAddress(".contracts.AUSD"));
        oracle = TestnetKeeperOracle(dep.readAddress(".contracts.OracleAdapter"));
        ch = IClearingHouse(dep.readAddress(".contracts.ClearingHouse"));
        ob = IOrderBook(dep.readAddress(".contracts.OrderBook"));
        fund = IInsuranceFund(dep.readAddress(".contracts.InsuranceFund"));
        vault = IPulseVault(dep.readAddress(".contracts.PulseVault"));
        swap = IFundingSwapMarket(dep.readAddress(".contracts.FundingSwapMarket"));
        sob = IOrderBook(dep.readAddress(".contracts.SwapOrderBook"));
        hedger = MockKuruHedger(dep.readAddress(".contracts.KuruHedger"));
    }

    function _tick(uint256 priceWad) internal view returns (uint32) {
        return uint32(priceWad / ob.tickSize());
    }

    function run() external {
        _load();
        address keeper = vm.addr(PK_KEEPER);
        address mm = vm.addr(PK_MM);
        address taker = vm.addr(PK_TAKER);
        address swapTaker = vm.addr(PK_SWAP_TAKER);

        vm.startBroadcast(PK_DEPLOYER);
        oracle.pushPrice(PRICE0, block.timestamp);
        hedger.setPrice(PRICE0); // testnet vault spot leg = labelled mock at the index (DeployPulse)
        ausd.mint(vm.addr(PK_DEPLOYER), 100_000e6);
        ausd.approve(address(fund), type(uint256).max);
        ausd.approve(address(ch), type(uint256).max);
        ausd.approve(address(swap), type(uint256).max);
        fund.fund(1000e6);
        ch.depositFor(keeper, 500e6);
        ch.depositFor(mm, 3000e6);
        ch.depositFor(taker, 1500e6);
        swap.depositFor(keeper, 200e6);
        swap.depositFor(mm, 1000e6);
        swap.depositFor(swapTaker, 200e6);
        ausd.mint(vm.addr(PK_DEPOSITOR), 1000e6);
        ausd.mint(vm.addr(PK_VICTIM), 30e6);
        vm.stopBroadcast();

        uint32 t0 = _tick(PRICE0);
        vm.broadcast(PK_MM);
        ob.placeLimitOrder(false, t0 + 2, TAKER_LOTS, 0); // asks for the taker
        vm.broadcast(PK_TAKER);
        ob.placeMarketOrder(true, TAKER_LOTS, t0 + 10, TAKER_LOTS, false); // 25,000 MON long; MM short 25,000
        vm.startBroadcast(PK_MM);
        ob.placeLimitOrder(true, t0, 200, 0); // bid wall at the index: the vault sells its hedge into it
        ob.placeLimitOrder(false, t0 + 2, 10, 0); // ask 2 ticks up: mid = index + 1 tick (premium > 0)
        sob.placeLimitOrder(false, 11_200, 3, 0); // swap: MM short 3 lots at 12.00% APR
        vm.stopBroadcast();
        vm.broadcast(PK_SWAP_TAKER);
        sob.placeMarketOrder(true, 3, 11_300, 3, false); // swap long 3,000 MON at 12%
        vm.startBroadcast(PK_DEPOSITOR);
        ausd.approve(address(vault), type(uint256).max);
        IERC4626(address(vault)).deposit(1000e6, vm.addr(PK_DEPOSITOR));
        vm.stopBroadcast();
        _report();
    }

    function push() external {
        _load();
        (, uint256 p,) = oracle.tryGetIndexPrice();
        vm.broadcast(PK_DEPLOYER);
        oracle.pushPrice(p == 0 ? PRICE0 : p, block.timestamp);
    }

    function report() external {
        _load();
        _report();
    }

    /// @dev SKEW_DROP_LOTS (default 50 = 5,000 MON) of the taker's long sold reduce-only into the MM's bids: takers' net
    ///      long 25,000 → 20,000 ⇒ capacity 0.8 × 20,000 = 16,000 < the vault's 20,000 short ⇒ SkewCap.
    function skewDrop() external {
        _load();
        uint64 lots = uint64(vm.envOr("SKEW_DROP_LOTS", uint256(50)));
        vm.broadcast(PK_TAKER);
        ob.placeMarketOrder(false, lots, 1, lots, true);
        _report();
    }

    function crashSetup() external {
        _load();
        (, uint256 p,) = oracle.tryGetIndexPrice();
        uint32 t = _tick(p);
        vm.broadcast(PK_MM);
        ob.placeLimitOrder(false, t + 3, 55, 0);
        vm.startBroadcast(PK_VICTIM);
        ausd.approve(address(ch), type(uint256).max);
        ch.deposit(30e6);
        // 5,500 MON ≈ 146 AUSD on 30 ⇒ ≈ 4.9x (liq ≈ −11%); the 4x first version survived −15% (liq price 0.022166)
        ob.placeMarketOrder(true, 55, t + 10, 55, false);
        vm.stopBroadcast();
        AccountView memory v = ch.getAccount(vm.addr(PK_VICTIM));
        console2.log("victim size / equity / MM / liq price", uint256(v.size), uint256(v.equity), v.maintenanceMargin);
        console2.log("  liq price", v.liquidationPrice);
    }

    function crash() external {
        _load();
        (, uint256 p,) = oracle.tryGetIndexPrice();
        uint256 np = p * 85 / 100;
        vm.startBroadcast(PK_DEPLOYER);
        oracle.pushPrice(np, block.timestamp);
        hedger.setPrice(np);
        vm.stopBroadcast();
        // the MM re-quotes around the new index (as the bot does) so the mark follows
        uint32 t = _tick(np);
        vm.startBroadcast(PK_MM);
        ob.placeLimitOrder(true, t - 1, 5, 0);
        ob.placeLimitOrder(false, t + 1, 5, 0);
        vm.stopBroadcast();
        console2.log("crash: index", p, "->", np);
    }

    function liquidate() external {
        _load();
        address victim = vm.addr(PK_VICTIM);
        console2.log("liquidatable", ch.isLiquidatable(victim));
        uint256 ifBefore = fund.balance();
        vm.broadcast(PK_KEEPER);
        ch.liquidate(victim, type(uint256).max);
        console2.log("IF before / after", ifBefore, fund.balance());
    }

    function _report() internal view {
        IFundingRateOracle fo = IFundingRateOracle(address(ch));
        (,, uint64 obsBlock) = fo.latestObservation();
        console2.log("block / last funding observation", block.number, obsBlock);
        try fo.averageFundingApr(96_000) returns (int256 apr8h) {
            console2.log("realized APR 8h (bps)", apr8h / 1e14);
        } catch {
            console2.log("realized APR 8h: not enough history");
        }
        try fo.averageFundingApr(12_000) returns (int256 apr1h) {
            console2.log("realized APR 1h (bps)", apr1h / 1e14);
        } catch {
            console2.log("realized APR 1h: not enough history");
        }
        HedgeState memory h = vault.hedgeState();
        console2.log("vault nav / idle (tAUSD units)", h.nav, h.idleAssets);
        console2.log("vault spot / perp size (MON WAD)", h.spotBase, uint256(-h.perpSize));
        console2.log("vault hedged / marginRatio", h.hedged, h.marginRatio);
        console2.log("netDelta (signed WAD) abs", h.netDelta < 0 ? uint256(-h.netDelta) : uint256(h.netDelta));
        console2.log("shortCapacity / sharePrice", vault.shortCapacity(), vault.sharePrice());
        console2.log("needsRebalance", uint8(vault.needsRebalance()));
        SwapAccountView memory s = swap.getAccount(vm.addr(PK_SWAP_TAKER));
        console2.log(
            "swap taker size / accruedNet(abs)",
            uint256(s.size),
            s.accruedNet < 0 ? uint256(-s.accruedNet) : uint256(s.accruedNet)
        );
        console2.log("swap matured / IF balance", swap.isMatured(), fund.balance());
    }
}
