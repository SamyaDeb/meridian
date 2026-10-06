// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {FundingSwapMarket} from "../../src/swaps/FundingSwapMarket.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {MockClearingHouse} from "../../src/mocks/MockClearingHouse.sol";
import {IClearingHouse} from "../../src/interfaces/IClearingHouse.sol";
import {RiskParams, FundingParams, SwapParams} from "../../src/interfaces/PulseTypes.sol";

/// @dev The two harnesses share this test-only surface.
interface IBadDebtHarness {
    function setState(address account, int256 collateral, int256 fees) external;
    function coverBadDebt(address account, uint256 badDebt) external;
    function rawFees() external view returns (int256);
    function rawCollateral(address account) external view returns (int256);
}

/// @dev Exposes the bad-debt step of `liquidate` with the account state `liquidate` leaves just before it.
contract ClearingHouseBadDebtHarness is ClearingHouse {
    constructor(address token, address oracle, address fund, RiskParams memory r, FundingParams memory f, address o)
        ClearingHouse(token, oracle, fund, r, f, o)
    {}

    function setState(address account, int256 collateral, int256 fees) external {
        _accounts[account].collateral = collateral;
        _fees = fees;
    }

    function coverBadDebt(address account, uint256 badDebt) external {
        _coverBadDebt(account, badDebt);
    }

    function rawFees() external view returns (int256) {
        return _fees;
    }

    function rawCollateral(address account) external view returns (int256) {
        return _accounts[account].collateral;
    }
}

contract FundingSwapBadDebtHarness is FundingSwapMarket {
    constructor(address perp, address token, address fund, uint64 maturity_, SwapParams memory p, address o)
        FundingSwapMarket(perp, token, fund, maturity_, p, o)
    {}

    function setState(address account, int256 collateral, int256 fees) external {
        _accounts[account].collateral = collateral;
        _fees = fees;
    }

    function coverBadDebt(address account, uint256 badDebt) external {
        _coverBadDebt(account, badDebt);
    }

    function rawFees() external view returns (int256) {
        return _fees;
    }

    function rawCollateral(address account) external view returns (int256) {
        return _accounts[account].collateral;
    }
}

/// MATH_SPEC §3.3 / §6.4 (PHASES 36): for any (IF balance, fees, debt) the waterfall IF → fees → uncovered splits the
/// debt exactly, takes fees only down to 0, and keeps I1's slack (balance·1e12 − (ΣC + fees)) unchanged.
contract BadDebtFuzzTest is Test {
    uint256 constant TO_WAD = 1e12;
    address owner = makeAddr("owner");
    address victim = makeAddr("victim");
    address other = makeAddr("other");

    MockERC20 ausd;
    InsuranceFund fund;
    ClearingHouseBadDebtHarness ch;
    FundingSwapBadDebtHarness fs;

    struct Split {
        uint256 coveredIF; // ≤ debt (the IF's sub-token excess goes to fees, not to the debt)
        uint256 fromFees;
        uint256 uncovered;
    }

    function setUp() public {
        vm.roll(1000);
        vm.warp(1_790_000_000);
        ausd = new MockERC20("Test AUSD", "tAUSD", 6);
        fund = new InsuranceFund(address(ausd), owner);
        ch = new ClearingHouseBadDebtHarness(
            address(ausd),
            address(new MockOracleAdapter(2e18)),
            address(fund),
            RiskParams(0.2e18, 0.1e18, 0.0005e18, -0.0001e18, 0.01e18, 0.5e18, 250_000e18, 25_000e18),
            FundingParams(2e15, 3_472_222_222, 555_555_555_556, 555_555_556, 300, 0.05e18),
            owner
        );
        MockClearingHouse perp =
            new MockClearingHouse(address(ausd), address(new MockOracleAdapter(0.029e18)), address(fund));
        perp.setFundingParams(FundingParams(2e15, 3_472_222_222, 555_555_555_556, 555_555_556, 300, 0.05e18));
        fs = new FundingSwapBadDebtHarness(
            address(perp),
            address(ausd),
            address(fund),
            uint64(block.timestamp + 30 days),
            SwapParams(0.05e18, 86_400, 1.5e18, 0.002e18, -0.0005e18, 0.2e18, 0.5e18, 2_000_000e18, 2_000_000e18),
            owner
        );
        vm.startPrank(owner);
        fund.setMarketAuthorized(address(ch), true);
        fund.setMarketAuthorized(address(fs), true);
        vm.stopPrank();
    }

    /// Victim at −debt (what `liquidate` stores before `_coverBadDebt`), one healthy depositor, raw fees, and
    /// tokens that back the depositor and the positive fees.
    function _arrange(address market, uint256 ifToken, int256 fees, uint256 debt, uint256 otherC) internal {
        IBadDebtHarness(market).setState(victim, -int256(debt), fees);
        IBadDebtHarness(market).setState(other, int256(otherC), fees);
        uint256 backing = otherC + (fees > 0 ? uint256(fees) : 0);
        ausd.mint(market, backing / TO_WAD + 1);
        ausd.mint(address(fund), ifToken);
    }

    function _slack(address market) internal view returns (int256) {
        IBadDebtHarness m = IBadDebtHarness(market);
        int256 liabilities = m.rawCollateral(victim) + m.rawCollateral(other) + m.rawFees();
        return int256(ausd.balanceOf(market) * TO_WAD) - liabilities;
    }

    function _bounds(uint256 ifToken, int256 fees, uint256 debt, uint256 otherC)
        internal
        pure
        returns (uint256, int256, uint256, uint256)
    {
        return (
            bound(ifToken, 0, 1e15), // ≤ 1e9 AUSD in the IF
            bound(fees, -1e24, 1e33), // negative only inside an order; still handled
            bound(debt, 1, 1e33),
            bound(otherC, 0, 1e33)
        );
    }

    /// Runs the step on `market` and checks the split, the fee floor and I1 (exact: the slack never moves).
    function _check(address market, uint256 ifToken, int256 fees, uint256 debt, uint256 otherC)
        internal
        returns (Split memory s)
    {
        _arrange(market, ifToken, fees, debt, otherC);
        IBadDebtHarness m = IBadDebtHarness(market);
        int256 slack0 = _slack(market);
        uint256 bal0 = ausd.balanceOf(market);
        m.coverBadDebt(victim, debt);
        uint256 coveredWad = (ausd.balanceOf(market) - bal0) * TO_WAD;
        uint256 pulled = (debt + TO_WAD - 1) / TO_WAD;
        assertEq(coveredWad, (ifToken < pulled ? ifToken : pulled) * TO_WAD, "IF pays min(balance, ceil(debt))");

        s.coveredIF = coveredWad < debt ? coveredWad : debt;
        int256 c1 = m.rawCollateral(victim);
        assertLe(c1, 0, "never credited beyond 0");
        s.uncovered = uint256(-c1);
        int256 fees1 = m.rawFees();
        if (coveredWad >= debt) {
            assertEq(fees1, fees + int256(coveredWad - debt), "IF covered: fees only gain the sub-token excess");
        } else {
            assertLe(fees1, fees, "fees never grow on a shortfall");
            s.fromFees = uint256(fees - fees1);
        }
        assertEq(s.coveredIF + s.fromFees + s.uncovered, debt, "coveredIF + fromFees + uncovered == debt");
        assertLe(s.fromFees, fees > 0 ? uint256(fees) : 0, "fromFees <= max(fees, 0)");
        if (s.uncovered != 0) assertLe(fees1, 0, "something uncovered => positive fees exhausted");
        assertEq(_slack(market), slack0, "I1 slack unchanged");
        assertGe(_slack(market), 0, "I1 holds");
    }

    function testFuzz_perpWaterfall(uint256 ifToken, int256 fees, uint256 debt, uint256 otherC) public {
        (ifToken, fees, debt, otherC) = _bounds(ifToken, fees, debt, otherC);
        uint256 total0 = ch.totalBadDebt();
        vm.recordLogs();
        Split memory s = _check(address(ch), ifToken, fees, debt, otherC);
        assertEq(ch.totalBadDebt() - total0, s.uncovered, "totalBadDebt += uncovered only");
        // BadDebtSocialized(requested = debt, coveredByInsurance = IF part, uncovered) iff the IF fell short
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(ch) || logs[i].topics[0] != IClearingHouse.BadDebtSocialized.selector) {
                continue;
            }
            ++n;
            (uint256 requested, uint256 byIF, uint256 unc) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            assertEq(requested, debt);
            assertEq(byIF, s.coveredIF);
            assertEq(unc, s.uncovered);
            assertEq(requested - byIF - unc, s.fromFees, "fee part derivable from the event");
        }
        assertEq(n, s.coveredIF < debt ? 1 : 0, "emitted iff the IF fell short");
    }

    function testFuzz_swapWaterfall(uint256 ifToken, int256 fees, uint256 debt, uint256 otherC) public {
        (ifToken, fees, debt, otherC) = _bounds(ifToken, fees, debt, otherC);
        uint256 total0 = fs.totalBadDebt();
        Split memory s = _check(address(fs), ifToken, fees, debt, otherC);
        assertEq(fs.totalBadDebt() - total0, s.uncovered, "totalBadDebt += uncovered only");
    }
}
