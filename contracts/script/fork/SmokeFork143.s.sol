// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IClearingHouse} from "../../src/interfaces/IClearingHouse.sol";
import {IFundingRateOracle} from "../../src/interfaces/IFundingRateOracle.sol";
import {IOracleAdapter} from "../../src/interfaces/IOracleAdapter.sol";
import {IOrderBook} from "../../src/interfaces/IOrderBook.sol";
import {IInsuranceFund} from "../../src/interfaces/IInsuranceFund.sol";
import {IPulseVault} from "../../src/interfaces/IPulseVault.sol";
import {IFundingSwapMarket} from "../../src/interfaces/IFundingSwapMarket.sol";
import {AccountView, SwapAccountView} from "../../src/interfaces/PulseTypes.sol";

/// @notice End-to-end smoke of a DeployPulse record on a MAINNET FORK (chain 143 on a local anvil), Phase 3 P2. The
///         mainnet counterpart of SmokeFull, without mocks: real AUSD (funded on the fork by impersonating a holder,
///         labelled), the real Pyth adapter (kept fresh by `keepers/ts-fallback/scripts/fork-pyth-relay.ts`, which
///         replays real signed mainnet updates). Steps: seed the IF; keeper, MM and taker collateral; the MM rests
///         asks, a taker goes 25,000 MON long (= maxPositionSize), the MM rests a bid wall + an ask; a swap long/short
///         fills at 12% APR; a depositor puts 1,000 AUSD in the vault, which stays idle (skewCapacity 0). Then checks
///         the end state and asserts it. Refuses anything but an anvil node (`anvil_nodeInfo`) with chain id 143.
///   FORK_DEPLOYMENTS=dry-run/143-fork.json forge script script/fork/SmokeFork143.s.sol --rpc-url http://127.0.0.1:8545 \
///     --broadcast --slow --gas-estimate-multiplier 200
/// @dev Anvil public dev keys only (#0 seeder, #1 keeper, #2 MM, #3 taker, #4 swap taker, #5 depositor; skipDemo: #6
///      trader, #9 owner stand-in).
contract SmokeFork143 is Script {
    using stdJson for string;

    uint256 internal constant PK_SEEDER = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant PK_KEEPER = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant PK_MM = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 internal constant PK_TAKER = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
    uint256 internal constant PK_SWAP_TAKER = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;
    uint256 internal constant PK_DEPOSITOR = 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba;
    uint256 internal constant PK_SKIP_TRADER = 0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e;
    /// @dev anvil #9 = rehearse-143.sh's owner stand-in (FORK_OWNER unset), never the real Safe
    uint256 internal constant PK_OWNER_STANDIN = 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6;

    uint64 internal constant TAKER_LOTS = 250; // 25,000 MON = maxPositionSize (launch cap)
    uint256 internal constant IF_SEED = 1500e6;
    uint256 internal constant VAULT_DEPOSIT = 1000e6;

    IERC20 ausd;
    IClearingHouse ch;
    IOrderBook ob;
    IOracleAdapter oracle;
    IInsuranceFund fund;
    IPulseVault vault;
    IFundingSwapMarket swap;
    IOrderBook sob;

    function _load() internal {
        require(block.chainid == 143, "SmokeFork143: mainnet FORK only (chain id 143 on anvil)");
        // a real Monad node rejects anvil_* methods: this is what keeps the script off the real network
        vm.rpc("anvil_nodeInfo", "[]");
        string memory dep = vm.readFile(
            string.concat(
                vm.projectRoot(), "/../deployments/", vm.envOr("FORK_DEPLOYMENTS", string("dry-run/143-fork.json"))
            )
        );
        require(dep.readBoolOr(".fork", false), "SmokeFork143: the deployments record is not a labelled fork record");
        ausd = IERC20(dep.readAddress(".contracts.AUSD"));
        ch = IClearingHouse(dep.readAddress(".contracts.ClearingHouse"));
        ob = IOrderBook(dep.readAddress(".contracts.OrderBook"));
        oracle = IOracleAdapter(dep.readAddress(".contracts.OracleAdapter"));
        fund = IInsuranceFund(dep.readAddress(".contracts.InsuranceFund"));
        vault = IPulseVault(dep.readAddress(".contracts.PulseVault"));
        swap = IFundingSwapMarket(dep.readAddress(".contracts.FundingSwapMarket"));
        sob = IOrderBook(dep.readAddress(".contracts.SwapOrderBook"));
    }

    function run() external {
        _load();
        (bool fresh, uint256 p0,) = oracle.tryGetIndexPrice();
        require(fresh, "SmokeFork143: oracle stale - start fork-pyth-relay first");
        uint32 t0 = uint32(p0 / ob.tickSize());
        console2.log("index price (WAD) / tick", p0, t0);
        uint256 ifBefore = fund.balance();

        vm.startBroadcast(PK_SEEDER);
        ausd.approve(address(fund), IF_SEED);
        fund.fund(IF_SEED);
        vm.stopBroadcast();

        _deposit(PK_KEEPER, 500e6, 0);
        _deposit(PK_MM, 3000e6, 1000e6);
        _deposit(PK_TAKER, 1500e6, 0);
        _deposit(PK_SWAP_TAKER, 0, 200e6);

        vm.broadcast(PK_MM);
        ob.placeLimitOrder(false, t0 + 2, TAKER_LOTS, 0); // asks for the taker
        vm.broadcast(PK_TAKER);
        ob.placeMarketOrder(true, TAKER_LOTS, t0 + 10, TAKER_LOTS, false); // 25,000 MON long; MM short 25,000
        vm.startBroadcast(PK_MM);
        ob.placeLimitOrder(true, t0, 200, 0); // bid wall at the index
        ob.placeLimitOrder(false, t0 + 2, 10, 0); // ask 2 ticks up
        sob.placeLimitOrder(false, 11_200, 3, 0); // swap: MM short 3 lots at 12.00% APR
        vm.stopBroadcast();
        vm.broadcast(PK_SWAP_TAKER);
        sob.placeMarketOrder(true, 3, 11_300, 3, false); // swap long 3,000 MON at 12%
        vm.startBroadcast(PK_DEPOSITOR);
        ausd.approve(address(vault), VAULT_DEPOSIT);
        IERC4626(address(vault)).deposit(VAULT_DEPOSIT, vm.addr(PK_DEPOSITOR));
        vm.stopBroadcast();

        _assertEndState(ifBefore);
    }

    /// @notice CR-007 on the fork (hardening P4.4), after `run()`: a trader opens a small short into the MM's bid
    ///         wall (the MM reduces: Filled), the owner stand-in pauses the CH, and a reduce-only buy crosses the MM's
    ///         ask, which would INCREASE the MM's short. Expected: `MakerFillSkipped(orderId, MM)`, nothing filled,
    ///         no eviction, the MM's ask still resting with the same lots; then unpause. Assertions run in forge's
    ///         simulation (logs recorded there); re-check the broadcast receipt with `cast receipt`.
    ///   forge script script/fork/SmokeFork143.s.sol --sig "skipDemo()" --rpc-url http://127.0.0.1:8545 --broadcast --slow
    function skipDemo() external {
        _load();
        require(Ownable(address(ch)).owner() == vm.addr(PK_OWNER_STANDIN), "CH owner is not the fork stand-in (#9)");
        (bool fresh,,) = oracle.tryGetIndexPrice();
        require(fresh, "SmokeFork143: oracle stale - start fork-pyth-relay first");
        address trader = vm.addr(PK_SKIP_TRADER);
        address mm = vm.addr(PK_MM);
        uint32 bid = ob.bestBid();
        uint32 ask = ob.bestAsk();
        require(bid != 0 && ask != type(uint32).max, "run() first: the MM's bid wall and ask must rest");

        _deposit(PK_SKIP_TRADER, 300e6, 0);
        vm.broadcast(PK_SKIP_TRADER);
        ob.placeMarketOrder(false, 5, bid, 5, false); // short 500 MON into the bid wall: the MM reduces (Filled)
        require(ch.getAccount(trader).size == -500e18, "trader short 500 MON");
        (uint64 askLots,) = ob.getLevel(ask);
        uint256 mmOrders = ob.openOrderCount(mm);

        vm.broadcast(PK_OWNER_STANDIN);
        ch.setPaused(true);
        vm.recordLogs();
        vm.broadcast(PK_SKIP_TRADER);
        (uint64 filled,) = ob.placeMarketOrder(true, 5, ask + 10, 0, true); // reduce-only buy into the MM's ask
        Vm.Log[] memory logs = vm.getRecordedLogs();
        vm.broadcast(PK_OWNER_STANDIN);
        ch.setPaused(false);

        uint256 skipped;
        uint256 evicted;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(ob)) continue;
            if (logs[i].topics[0] == IOrderBook.MakerFillSkipped.selector) {
                require(address(uint160(uint256(logs[i].topics[2]))) == mm, "skipped maker is the MM");
                console2.log("MakerFillSkipped orderId", uint256(logs[i].topics[1]));
                ++skipped;
            }
            if (logs[i].topics[0] == IOrderBook.OrderEvicted.selector) ++evicted;
        }
        (uint64 askLotsAfter,) = ob.getLevel(ask);
        console2.log("paused reduce-only buy: filled lots / skips / evictions", filled, skipped, evicted);
        console2.log("MM ask level lots before / after", askLots, askLotsAfter);
        require(filled == 0 && skipped == 1 && evicted == 0, "CR-007: one Skip, nothing filled, nothing evicted");
        require(askLotsAfter == askLots && ob.openOrderCount(mm) == mmOrders, "CR-007: the MM's ask still rests");
        require(ch.getAccount(trader).size == -500e18, "trader position unchanged");
        console2.log("SKIP OK (mainnet fork, labelled): paused market refused new risk, MM order kept");
    }

    function _deposit(uint256 pk, uint256 perp, uint256 swp) internal {
        vm.startBroadcast(pk);
        if (perp != 0) {
            ausd.approve(address(ch), perp);
            ch.deposit(perp);
        }
        if (swp != 0) {
            ausd.approve(address(swap), swp);
            swap.deposit(swp);
        }
        vm.stopBroadcast();
    }

    /// @dev Read-only checks of the state the broadcast left (re-run with `--sig "check()"` without --broadcast).
    function check() external {
        _load();
        _assertEndState(type(uint256).max);
    }

    function _assertEndState(uint256 ifBefore) internal view {
        AccountView memory t = ch.getAccount(vm.addr(PK_TAKER));
        AccountView memory m = ch.getAccount(vm.addr(PK_MM));
        (uint256 longOI, uint256 shortOI) = ch.openInterest();
        console2.log("taker size / equity (WAD)", uint256(t.size), uint256(t.equity));
        console2.log("MM size (abs, WAD)", uint256(-m.size));
        console2.log("OI long / short (WAD)", longOI, shortOI);
        require(t.size == 25_000e18, "taker long 25,000 MON");
        require(m.size == -25_000e18, "MM short 25,000 MON");
        require(longOI == shortOI && longOI == 25_000e18, "longOI == shortOI == 25,000 MON");
        uint256 ifBal = fund.balance();
        console2.log("IF balance (AUSD units)", ifBal);
        if (ifBefore != type(uint256).max) require(ifBal == ifBefore + IF_SEED, "IF seeded");
        SwapAccountView memory s = swap.getAccount(vm.addr(PK_SWAP_TAKER));
        (uint256 sLong, uint256 sShort) = swap.openInterest();
        console2.log("swap taker size / avg fixed APR (WAD)", uint256(s.size), uint256(s.avgFixedApr));
        require(s.size == 3000e18 && sLong == sShort, "swap long 3,000 MON at 12%, OI balanced");
        require(s.avgFixedApr == 0.12e18, "swap fixed APR 12%");
        console2.log("swap markApr (WAD)", uint256(swap.markApr()));
        uint256 nav = IERC4626(address(vault)).totalAssets();
        console2.log("vault totalAssets / shortCapacity", nav, vault.shortCapacity());
        require(nav >= VAULT_DEPOSIT, "vault holds the deposit");
        require(vault.shortCapacity() == 0, "vault idle: shortCapacity 0 with takers net long (decision 17)");
        require(uint8(vault.needsRebalance()) == uint8(IPulseVault.RebalanceReason.None), "vault: nothing to do");
        require(!vault.hedgeState().hedged && vault.hedgeState().perpSize == 0, "vault not hedged");
        console2.log("vault maxDeposit left (AUSD units)", IERC4626(address(vault)).maxDeposit(address(1)));
        (,, uint64 obsBlock) = IFundingRateOracle(address(ch)).latestObservation();
        console2.log("block / last funding observation", block.number, obsBlock);
        console2.log("SMOKE OK (mainnet fork, labelled)");
    }
}
