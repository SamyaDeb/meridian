// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {FundingSwapMarket} from "../../src/swaps/FundingSwapMarket.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {RiskParams, FundingParams, SwapParams} from "../../src/interfaces/PulseTypes.sol";
import {FundingSwapHandler} from "./handlers/FundingSwapHandler.sol";

/// @notice MATH_SPEC I9 on the REAL stack (perp CH + OB driving F and G; FundingSwapMarket + its own real OrderBook):
///         Σq = 0, ΣK = 0, longOI = shortOI = Σ max(q, 0); settled accrual dust 0 ≤ balance·1e12 − (ΣC + fees)
///         ≤ #settlements wei; no account's accrual changes after the maturity snapshot. Coverage is logged.
/// forge-config: default.invariant.fail-on-revert = true
contract FundingSwapInvariantsTest is StdInvariant, Test {
    FundingSwapHandler handler;
    FundingSwapMarket fs;
    MockERC20 ausd;
    address[] everyone;

    function setUp() public {
        vm.roll(1000);
        vm.warp(1_790_000_000);
        address owner = makeAddr("owner");
        ausd = new MockERC20("Test AUSD", "tAUSD", 6);
        MockOracleAdapter oracle = new MockOracleAdapter(0.029e18);
        InsuranceFund fund = new InsuranceFund(address(ausd), owner);
        ClearingHouse ch = new ClearingHouse(
            address(ausd),
            address(oracle),
            address(fund),
            RiskParams(0.2e18, 0.1e18, 0.0005e18, -0.0001e18, 0.01e18, 0.5e18, 250_000e18, 25_000e18),
            FundingParams(0.002e18, 3_472_222_222, 555_555_555_556, 555_555_556, 300, 0.05e18),
            owner
        );
        OrderBook ob = new OrderBook(address(ch), 1e12, 100e18);
        fs = new FundingSwapMarket(
            address(ch),
            address(ausd),
            address(fund),
            uint64(block.timestamp + 2 days),
            SwapParams(0.05e18, 86_400, 1.5e18, 0.002e18, -0.0005e18, 0.2e18, 0.5e18, 2_000_000e18, 1_000_000e18),
            owner
        );
        OrderBook sob = new OrderBook(address(fs), 1e14, 1000e18);
        vm.startPrank(owner);
        ch.setOrderBook(address(ob));
        fs.setOrderBook(address(sob));
        fund.setMarketAuthorized(address(ch), true);
        fund.setMarketAuthorized(address(fs), true);
        vm.stopPrank();
        ausd.mint(address(fund), 5000e6); // bad debt usually covered; the uncovered path is unit-tested

        address perpMm = makeAddr("perpMm");
        _fundPerp(ch, perpMm, 1_000_000e6);
        address keeper = makeAddr("keeper");
        address[] memory actors = new address[](5);
        actors[0] = makeAddr("sam"); // deep liquidity provider
        for (uint256 i = 1; i < 5; ++i) {
            actors[i] = makeAddr(string.concat("t", vm.toString(i)));
        }
        handler = new FundingSwapHandler(ch, ob, fs, sob, ausd, perpMm, actors, keeper);
        handler.setInsuranceFund(fund);
        handler.setOwner(owner);
        vm.prank(owner);
        fund.setMarketAuthorized(address(handler), true); // drainInsurance: bad debt reaches fees, then uncovered
        _fundSwap(actors[0], 200_000e6);
        for (uint256 i = 1; i < 5; ++i) {
            _fundSwap(actors[i], 3000e6); // thin margin: liquidations are reachable (coverage logged)
        }
        _fundSwap(keeper, 1_000_000e6);
        handler.regime(300); // perp book at the index
        everyone = actors;
        everyone.push(keeper);

        bytes4[] memory sel = new bytes4[](18);
        sel[0] = handler.placeLimit.selector;
        sel[1] = handler.placeLimit.selector;
        sel[2] = handler.placeLimit.selector;
        sel[3] = handler.placeMarket.selector;
        sel[4] = handler.placeMarket.selector;
        sel[5] = handler.cancel.selector;
        sel[6] = handler.deposit.selector;
        sel[7] = handler.withdraw.selector;
        sel[8] = handler.settle.selector;
        sel[9] = handler.liquidate.selector;
        sel[10] = handler.liquidate.selector;
        sel[11] = handler.roll.selector;
        sel[12] = handler.roll.selector;
        sel[13] = handler.regime.selector;
        sel[14] = handler.regime.selector;
        sel[15] = handler.goToMaturity.selector;
        sel[16] = handler.drainInsurance.selector;
        sel[17] = handler.setPaused.selector; // CR-007: paused ⇒ increasing makers Skip
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    function _fundPerp(ClearingHouse ch, address who, uint256 amt) internal {
        ausd.mint(who, amt);
        vm.startPrank(who);
        ausd.approve(address(ch), amt);
        ch.deposit(amt);
        vm.stopPrank();
    }

    function _fundSwap(address who, uint256 amt) internal {
        ausd.mint(who, amt);
        vm.startPrank(who);
        ausd.approve(address(fs), amt);
        fs.deposit(amt);
        vm.stopPrank();
    }

    /// I9: Σq = 0, ΣK = 0, longOI = shortOI = Σ max(q, 0).
    function invariant_I9_sumsAndOpenInterest() public view {
        int256 sumQ;
        int256 sumK;
        uint256 longs;
        for (uint256 i; i < everyone.length; ++i) {
            int256 q = fs.getPosition(everyone[i]).size;
            sumQ += q;
            sumK += fs.getPosition(everyone[i]).fixedAprNotional;
            if (q > 0) longs += uint256(q);
        }
        (uint256 lo, uint256 so) = fs.openInterest();
        assertEq(sumQ, 0, "I9: sum q");
        assertEq(sumK, 0, "I9: sum K");
        assertEq(lo, so, "I9: longOI == shortOI");
        assertEq(lo, longs, "I9: longOI == sum of longs");
    }

    /// I9: accrual never creates value and rounds ≤ 1 wei per settlement. Counterparties settle at different
    ///     times, so pending accrual (the preview, one more floor per account) is included: with everyone
    ///     settled this is exactly "Σ net over settled accounts ∈ [−#settlements, 0]". Token flows are exact.
    function invariant_I9_accrualDust() public view {
        int256 sumC;
        for (uint256 i; i < everyone.length; ++i) {
            sumC += fs.collateralOf(everyone[i]) + fs.getAccount(everyone[i]).accruedNet;
        }
        int256 dust = int256(ausd.balanceOf(address(fs)) * 1e12) - (sumC + int256(fs.accruedFees()));
        assertGe(dust, 0, "I9: sum of net <= 0");
        assertLe(dust, int256(handler.settlements() + everyone.length), "I9: >= -(#settlements + #accounts)");
    }

    /// PHASES 36: uncovered bad debt is only ever added once accrued protocol fees are exhausted.
    function invariant_I9_badDebtWaterfall() public view {
        assertFalse(handler.waterfallViolation(), "uncovered bad debt while fees > 0");
    }

    /// I9: after the maturity snapshot no account's accrual changes.
    function invariant_I9_noAccrualAfterMaturity() public view {
        assertFalse(handler.accrualAfterMaturity(), "I9: accrual after maturity");
    }

    /// Coverage per run, appended to bench-out/fs_invariant_coverage.csv (aggregate with the command in the
    /// PR/standup): proves fills, liquidations and the post-maturity freeze were actually exercised.
    function afterInvariant() external {
        vm.createDir("./bench-out", true); // gitignored: absent on a fresh checkout / CI
        vm.writeLine(
            "./bench-out/fs_invariant_coverage.csv",
            string.concat(
                vm.toString(handler.limitOk()),
                ",",
                vm.toString(handler.marketOk()),
                ",",
                vm.toString(handler.fills()),
                ",",
                vm.toString(handler.liquidations()),
                ",",
                vm.toString(handler.settlements()),
                ",",
                vm.toString(handler.maturityFreezeChecks()),
                ",",
                vm.toString(handler.badDebtLiquidations()),
                ",",
                vm.toString(handler.feesAbsorbed()),
                ",",
                vm.toString(handler.uncoveredWithFees()),
                ",",
                vm.toString(handler.skips()),
                ",",
                vm.toString(handler.evictions())
            )
        );
    }
}
