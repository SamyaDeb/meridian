// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {PerplFundingSource} from "../../src/oracle/PerplFundingSource.sol";
import {MockPerplExchange} from "../../src/mocks/MockPerplExchange.sol";
import {FundingSwapMarket} from "../../src/swaps/FundingSwapMarket.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {SwapParams} from "../../src/interfaces/MeridianTypes.sol";
import {PerplSwapHandler} from "./handlers/PerplSwapHandler.sol";

/// @notice CR-017: a real FundingSwapMarket + OrderBook on PerplFundingSource (scripted Perpl). Σq = 0, ΣK = 0,
///         longOI = shortOI = Σ max(q, 0), the market stays solvent (balance·1e12 ≥ Σ(C + pending accrual) + fees), G never decreases
///         and F always equals Perpl's applied sum × 1e10 after a poke. Coverage is logged.
contract PerplSwapInvariantsTest is StdInvariant, Test {
    PerplSwapHandler handler;
    FundingSwapMarket fs;
    MockERC20 ausd;
    address[] everyone;

    function setUp() public {
        vm.roll(10_000);
        vm.warp(1_791_800_000);
        address owner = makeAddr("owner");
        MockPerplExchange x = new MockPerplExchange(64, 5, 3);
        x.pushEvent(64, 9000, -21_000);
        x.setPrice(64, 2500, block.timestamp);
        x.setRate(64, -1, 10);
        PerplFundingSource src = new PerplFundingSource(address(x), 64, 2580);
        ausd = new MockERC20("Test AUSD", "tAUSD", 6);
        InsuranceFund fund = new InsuranceFund(address(ausd), owner);
        fs = new FundingSwapMarket(
            address(src),
            address(ausd),
            address(fund),
            uint64(block.timestamp + 30 days),
            SwapParams(0.05e18, 86_400, 1.5e18, 0.002e18, -0.0005e18, 0.2e18, 0.5e18, 2_000_000e18, 200_000e18),
            owner
        );
        OrderBook ob = new OrderBook(address(fs), 1e14, 1000e18);
        vm.startPrank(owner);
        fs.setOrderBook(address(ob));
        fund.setMarketAuthorized(address(fs), true);
        vm.stopPrank();

        address lp = makeAddr("lp");
        address[] memory actors = new address[](4);
        for (uint256 i; i < 4; ++i) {
            actors[i] = makeAddr(string.concat("t", vm.toString(i)));
            _fund(actors[i], 2000e6);
        }
        _fund(lp, 1_000_000e6);
        handler = new PerplSwapHandler(x, src, fs, ob, lp, actors, -21_000, 9000);
        everyone = actors;
        everyone.push(lp);
        targetContract(address(handler));
    }

    function _fund(address who, uint256 amt) internal {
        ausd.mint(who, amt);
        vm.startPrank(who);
        ausd.approve(address(fs), type(uint256).max);
        fs.deposit(amt);
        vm.stopPrank();
    }

    function invariant_sumQAndKZero() public view {
        int256 q;
        int256 k;
        uint256 longs;
        for (uint256 i; i < everyone.length; ++i) {
            q += fs.getPosition(everyone[i]).size;
            k += fs.getPosition(everyone[i]).fixedAprNotional;
            int256 s = fs.getPosition(everyone[i]).size;
            if (s > 0) longs += uint256(s);
        }
        assertEq(q, 0, "sum q");
        assertEq(k, 0, "sum K");
        (uint256 lo, uint256 so) = fs.openInterest();
        assertEq(lo, longs, "long OI");
        assertEq(so, longs, "short OI");
    }

    function invariant_solvent() public view {
        int256 c;
        for (uint256 i; i < everyone.length; ++i) {
            // settled collateral + accrual not yet settled (lazy settlement: one side may be settled before the other)
            c += fs.collateralOf(everyone[i]) + fs.getAccount(everyone[i]).accruedNet;
        }
        int256 held = int256(ausd.balanceOf(address(fs)) * 1e12);
        assertGe(held, c + int256(fs.accruedFees()), "solvent");
    }

    function invariant_sourceMonotoneAndExact() public view {
        assertFalse(handler.gDecreased(), "G decreased");
        assertFalse(handler.fMismatch(), "F != sum * 1e10");
    }

    function afterInvariant() external view {
        string[7] memory k = ["fundingEvent", "poke", "open", "open:rejected", "close", "close:rejected", "settle"];
        for (uint256 i; i < k.length; ++i) {
            console.log(k[i], handler.calls(bytes32(bytes(k[i]))));
        }
    }
}
