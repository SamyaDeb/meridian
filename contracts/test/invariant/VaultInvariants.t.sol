// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {PulseVault} from "../../src/vault/PulseVault.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {MockKuruHedger} from "../../src/mocks/MockKuruHedger.sol";
import {RiskParams, FundingParams, VaultParams} from "../../src/interfaces/PulseTypes.sol";
import {VaultHandler} from "./handlers/VaultHandler.sol";

/// @notice MATH_SPEC I8 (vault shares) and I10 (no free money, see also test/fuzz/PulseVault.fuzz.t.sol) on the REAL
///         ClearingHouse + OrderBook with MockKuruHedger. fail_on_revert; coverage appended per run to
///         bench-out/vault_invariant_coverage.csv.
/// forge-config: default.invariant.fail-on-revert = true
contract VaultInvariantsTest is StdInvariant, Test {
    VaultHandler handler;
    PulseVault vault;
    ClearingHouse ch;

    function setUp() public {
        vm.roll(1_000_000);
        vm.warp(1_790_000_000);
        address owner = makeAddr("owner");
        MockERC20 ausd = new MockERC20("Test AUSD", "tAUSD", 6);
        MockERC20 wmon = new MockERC20("WMON", "WMON", 18);
        MockOracleAdapter oracle = new MockOracleAdapter(0.029e18);
        InsuranceFund fund = new InsuranceFund(address(ausd), owner);
        ch = new ClearingHouse(
            address(ausd),
            address(oracle),
            address(fund),
            RiskParams(0.2e18, 0.1e18, 0.0005e18, -0.0001e18, 0.01e18, 0.5e18, 10_000_000e18, 1_000_000e18),
            FundingParams(0.002e18, 3_472_222_222, 555_555_555_556, 555_555_556, 300, 0.05e18),
            owner
        );
        OrderBook ob = new OrderBook(address(ch), 1e12, 100e18);
        vm.startPrank(owner);
        ch.setOrderBook(address(ob));
        fund.setMarketAuthorized(address(ch), true);
        vm.stopPrank();
        MockKuruHedger hedger = new MockKuruHedger(address(wmon), address(ausd), 0.029e18);
        hedger.setSpread(0.001e18);
        vault = new PulseVault(
            ausd,
            address(ch),
            address(ob),
            address(hedger),
            VaultParams(
                1.5e18, 0.02e18, 0.6e18, 0.25e18, 3 days, 0.0015e18, 0.005e18, 0.05e18, 10_000e6, 0.8e18, 7 days, 2500e6
            ),
            owner
        );
        address keeper = makeAddr("keeper");
        address mm = makeAddr("mm");
        address whale = makeAddr("whale");
        vm.startPrank(owner);
        vault.setKeeper(keeper, true);
        vault.setSkewProvider(mm, true);
        vm.stopPrank();
        _perpDeposit(ausd, mm, 5_000_000e6);
        _perpDeposit(ausd, whale, 5_000_000e6);
        address[] memory actors = new address[](3);
        actors[0] = makeAddr("a0");
        actors[1] = makeAddr("a1");
        actors[2] = makeAddr("a2");
        handler = new VaultHandler(vault, ch, ob, oracle, hedger);
        handler.setRoles(keeper, whale, mm, actors);
        handler.requote();
        handler.skew(true, 3000); // takers start net long 300,000 MON
        handler.fundingRegime(70); // +30% APR

        bytes4[] memory sel = new bytes4[](12);
        sel[0] = handler.deposit.selector;
        sel[1] = handler.deposit.selector;
        sel[2] = handler.redeem.selector;
        sel[3] = handler.withdraw.selector;
        sel[4] = handler.rebalance.selector;
        sel[5] = handler.rebalance.selector;
        sel[6] = handler.rebalance.selector;
        sel[7] = handler.fundingRegime.selector;
        sel[8] = handler.movePrice.selector;
        sel[9] = handler.skew.selector;
        sel[10] = handler.roll.selector;
        sel[11] = handler.requote.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    function _perpDeposit(MockERC20 ausd, address who, uint256 amt) internal {
        ausd.mint(who, amt);
        vm.startPrank(who);
        ausd.approve(address(ch), amt);
        ch.deposit(amt);
        vm.stopPrank();
    }

    /// I8: convertToAssets(totalSupply) ≤ totalAssets.
    function invariant_I8_sharesBackedByAssets() public view {
        assertLe(vault.convertToAssets(vault.totalSupply()), vault.totalAssets());
    }

    /// I8: the share price never decreases from a deposit or a withdrawal alone (incl. inline unwinds).
    function invariant_I8_flowsNeverDilute() public view {
        assertFalse(handler.sharePriceFellOnFlow(), "I8: share price fell on a deposit/withdraw");
    }

    /// The vault is never long the perp (MATH_SPEC §5.2).
    function invariant_vaultNeverLong() public view {
        assertLe(ch.getPosition(address(vault)).size, 0);
    }

    function afterInvariant() external {
        vm.createDir("./bench-out", true); // gitignored: absent on a fresh checkout / CI
        vm.writeLine(
            "./bench-out/vault_invariant_coverage.csv",
            string.concat(
                vm.toString(handler.depositsOk()),
                ",",
                vm.toString(handler.withdrawalsOk()),
                ",",
                vm.toString(handler.unwindWithdrawals()),
                ",",
                vm.toString(handler.rebalancesOk()),
                ",",
                vm.toString(handler.priceMoves())
            )
        );
    }
}
