// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IClearingHouse} from "../src/interfaces/IClearingHouse.sol";
import {IOracleAdapter} from "../src/interfaces/IOracleAdapter.sol";
import {IOrderBook} from "../src/interfaces/IOrderBook.sol";
import {IInsuranceFund} from "../src/interfaces/IInsuranceFund.sol";
import {IPulseVault} from "../src/interfaces/IPulseVault.sol";
import {IFundingSwapMarket} from "../src/interfaces/IFundingSwapMarket.sol";
import {AccountView, HedgeState} from "../src/interfaces/PulseTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice DEMO_SCRIPT 2:25–2:50 crash segment, as a FORK SIMULATION (never broadcast): a fresh trader opens a ≈ 4.9x
///         long, the vault is (or gets) hedged, the swap book is read, then MON drops 15% in one oracle update. For 20
///         blocks it records index, mark, vault NAV + share price, swap markApr, IF balance and the trader's position
///         to `bench-out/crash_demo_<chainid>.csv`; the keeper's liquidation is simulated at the first eligible block.
///   Local rehearsal (fork of the step-4 anvil, labelled "local fork"):
///     DEPLOYMENTS_OUT=anvil-10143.json forge script script/CrashDemo.s.sol --fork-url http://127.0.0.1:8546
///   Phase 5 (mainnet fork, disclosed on screen): same command with --fork-url $MONAD_RPC_URL and deployments/143.json.
/// @dev Price move: a keeper-fed test oracle (testnet/local) is pushed by its owner (a feeder) inside the simulation;
///      any other oracle (mainnet Pyth adapter; the CH's oracle is immutable) is overridden with vm.mockCall ON THE
///      FORK ONLY. Refuses to run as a broadcast on any chain, so nothing here can ever reach 143.
contract CrashDemo is Script, StdCheats {
    using stdJson for string;

    uint256 internal constant BLOCKS = 20;
    uint256 internal constant DROP_BPS = 1500;

    IClearingHouse ch;
    IOrderBook ob;
    IOracleAdapter oracle;
    IInsuranceFund fund;
    IPulseVault vault;
    IFundingSwapMarket swap;
    IERC20 ausd;
    address owner;
    address keeper;
    address mm;

    function run() external {
        require(!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast), "CrashDemo: fork simulation only, never broadcast");
        string memory name = vm.envOr("DEPLOYMENTS_OUT", string.concat(vm.toString(block.chainid), ".json"));
        string memory dep = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/", name));
        ch = IClearingHouse(dep.readAddress(".contracts.ClearingHouse"));
        ob = IOrderBook(dep.readAddress(".contracts.OrderBook"));
        oracle = IOracleAdapter(dep.readAddress(".contracts.OracleAdapter"));
        fund = IInsuranceFund(dep.readAddress(".contracts.InsuranceFund"));
        vault = IPulseVault(dep.readAddress(".contracts.PulseVault"));
        swap = IFundingSwapMarket(dep.readAddress(".contracts.FundingSwapMarket"));
        ausd = IERC20(dep.readAddress(".contracts.AUSD"));
        owner = dep.readAddress(".owner");
        keeper = vm.envOr("CRASH_KEEPER", address(0x70997970C51812dc3A010C7d01b50e0d17dc79C8));
        mm = vm.envOr("CRASH_MM", address(0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC));

        (, uint256 p0,) = oracle.tryGetIndexPrice();
        require(p0 != 0, "CrashDemo: oracle has no price");
        _seedBookIfEmpty(p0);
        address trader = _openTrader(p0);
        _hedgeVault();

        uint256 p1 = p0 * (10_000 - DROP_BPS) / 10_000;
        string memory csv =
            string.concat(vm.projectRoot(), "/bench-out/crash_demo_", vm.toString(block.chainid), ".csv");
        vm.createDir(string.concat(vm.projectRoot(), "/bench-out"), true);
        vm.writeFile(
            csv,
            "block_offset,block,index_wad,mark_wad,vault_nav_token,vault_share_price_wad,swap_mark_apr_wad,if_balance_token,trader_size_wad,trader_liquidatable,liquidated_here\n"
        );
        uint256 b0 = block.number;
        bool pushed;
        bool liquidated;
        for (uint256 i; i <= BLOCKS; ++i) {
            if (i > 0) {
                vm.roll(block.number + 1);
                if (i % 3 == 0) vm.warp(block.timestamp + 1); // ~300 ms blocks
            }
            if (i == 1) {
                _setPrice(p1); // one oracle update: −15%
                _requote(p1); // the MM follows the index (the mark is a median incl. the book mid)
                pushed = true;
            } else if (pushed) {
                _setPrice(p1); // keep a keeper-fed oracle fresh at the new level
            }
            vm.prank(keeper);
            ch.updateFunding();
            bool liq = ch.isLiquidatable(trader);
            bool here;
            if (liq && !liquidated) {
                vm.prank(keeper);
                ch.liquidate(trader, type(uint256).max);
                liquidated = true;
                here = true;
                console2.log("keeper liquidated the trader at block offset", i);
            }
            _row(csv, i, b0, trader, liq, here);
        }
        console2.log("CSV", csv);
    }

    /// @dev A fork taken while no MM runs has an empty book (dry-run finding, 30 Sep): the MM (CRASH_MM) rests one level
    ///      per side 3 ticks around the index inside the simulation, so the trader can open and the mark has a book mid.
    function _seedBookIfEmpty(uint256 p0) internal {
        uint32 t = uint32(p0 / ob.tickSize());
        bool noBid = ob.bestBid() == 0;
        bool noAsk = ob.bestAsk() == type(uint32).max || ob.bestAsk() == 0;
        if (!noBid && !noAsk) return;
        vm.startPrank(mm);
        if (noAsk) ob.placeLimitOrder(false, t + 3, 60, 0);
        if (noBid) ob.placeLimitOrder(true, t - 3, 60, 0);
        vm.stopPrank();
        console2.log("seeded an empty book as the MM (simulation only)");
    }

    /// @dev A fresh trader deposits 30 AUSD and buys ≈ 4.9x notional at the best ask (the imr 20% = 5x cap).
    function _openTrader(uint256 p0) internal returns (address trader) {
        trader = makeAddr("crash-trader");
        uint256 amt = 30e6;
        deal(address(ausd), trader, amt);
        vm.startPrank(trader);
        ausd.approve(address(ch), amt);
        ch.deposit(amt);
        uint256 lot = ob.lotSize();
        uint64 lots = uint64((30e18 * 49 / 10) * 1e18 / p0 / lot); // 4.9 × 30 AUSD of notional
        ob.placeMarketOrder(true, lots, uint32(p0 * 102 / 100 / ob.tickSize()), 0, false);
        vm.stopPrank();
        AccountView memory v = ch.getAccount(trader);
        console2.log(
            "trader size (MON WAD) / equity / liq price", uint256(v.size), uint256(v.equity), v.liquidationPrice
        );
        require(v.size > 0, "CrashDemo: trader got no fill (book empty?)");
    }

    function _hedgeVault() internal {
        for (uint256 i; i < 6 && !vault.hedgeState().hedged; ++i) {
            vm.prank(keeper);
            try vault.rebalance() {} catch {}
            vm.roll(block.number + 1);
        }
        HedgeState memory h = vault.hedgeState();
        console2.log(
            "vault hedged / spot / perp short", h.hedged, h.spotBase, uint256(h.perpSize < 0 ? -h.perpSize : h.perpSize)
        );
    }

    function _setPrice(uint256 p) internal {
        // keeper-fed test oracle: pushPrice(price, publishTime) by a feeder (the owner is one); else mock on the fork
        vm.prank(owner);
        (bool ok,) = address(oracle).call(abi.encodeWithSignature("pushPrice(uint256,uint256)", p, block.timestamp));
        if (!ok) {
            vm.mockCall(
                address(oracle),
                abi.encodeWithSelector(IOracleAdapter.getIndexPrice.selector),
                abi.encode(p, block.timestamp)
            );
            vm.mockCall(
                address(oracle),
                abi.encodeWithSelector(IOracleAdapter.tryGetIndexPrice.selector),
                abi.encode(true, p, block.timestamp)
            );
        }
    }

    function _requote(uint256 p) internal {
        uint32 t = uint32(p / ob.tickSize());
        vm.startPrank(mm);
        try ob.placeLimitOrder(true, t - 1, 5, 0) {} catch {}
        try ob.placeLimitOrder(false, t + 1, 5, 0) {} catch {}
        vm.stopPrank();
    }

    function _row(string memory csv, uint256 i, uint256 b0, address trader, bool liq, bool here) internal {
        (, uint256 idx,) = oracle.tryGetIndexPrice();
        AccountView memory v = ch.getAccount(trader);
        string memory line = string.concat(
            vm.toString(i), ",", vm.toString(b0 + i), ",", vm.toString(idx), ",", vm.toString(ch.markPrice()), ","
        );
        line = string.concat(
            line,
            vm.toString(vault.totalAssets()),
            ",",
            vm.toString(vault.sharePrice()),
            ",",
            vm.toString(swap.markApr()),
            ",",
            vm.toString(fund.balance()),
            ","
        );
        line = string.concat(line, vm.toString(v.size), ",", liq ? "1" : "0", ",", here ? "1" : "0");
        vm.writeLine(csv, line);
    }
}
