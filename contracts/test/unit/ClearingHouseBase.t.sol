// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {MockOrderBook} from "../../src/mocks/MockOrderBook.sol";
import {IClearingHouse} from "../../src/interfaces/IClearingHouse.sol";
import {RiskParams, FundingParams, AccountView} from "../../src/interfaces/MeridianTypes.sol";

/// @dev Shared fixture: I = 2 AUSD, tick 1e-4, lot 1 base, MATH_SPEC §1.3/§3.3 defaults.
abstract contract ClearingHouseBase is Test {
    uint256 constant I0 = 2e18;
    uint256 constant TICK = 1e14;
    uint256 constant LOT = 1e18;
    int256 constant INTEREST = 3_472_222_222;
    uint256 constant CAP = 555_555_555_556;
    uint256 constant DELTA = 555_555_556;

    MockERC20 ausd;
    MockOracleAdapter oracle;
    InsuranceFund fund;
    ClearingHouse ch;
    MockOrderBook ob;

    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address keeper = makeAddr("keeper");

    function _risk() internal pure returns (RiskParams memory) {
        return RiskParams({
            imr: 0.2e18,
            mmr: 0.1e18,
            takerFee: 0.0005e18,
            makerFee: -0.0001e18,
            liqPenalty: 0.01e18,
            keeperShare: 0.5e18,
            maxOpenInterest: 250_000e18,
            maxPositionSize: 25_000e18
        });
    }

    function _funding() internal pure returns (FundingParams memory) {
        return FundingParams({
            alpha: 2e15,
            interestRate: INTEREST,
            rateCap: CAP,
            maxRateChangePerBlock: DELTA,
            blockTimeMs: 300,
            premiumBandWad: 0.05e18
        });
    }

    function setUp() public virtual {
        vm.roll(1000);
        ausd = new MockERC20("Agora Dollar", "AUSD", 6);
        oracle = new MockOracleAdapter(I0);
        fund = new InsuranceFund(address(ausd), owner);
        ch = new ClearingHouse(address(ausd), address(oracle), address(fund), _risk(), _funding(), owner);
        ob = new MockOrderBook(address(ch), TICK, LOT);
        vm.startPrank(owner);
        ch.setOrderBook(address(ob));
        fund.setMarketAuthorized(address(ch), true);
        vm.stopPrank();
    }

    // ─── helpers ──────────────────────────────────────────────────────────────
    function _deposit(address who, uint256 amountToken) internal {
        ausd.mint(who, amountToken);
        vm.startPrank(who);
        ausd.approve(address(ch), amountToken);
        ch.deposit(amountToken);
        vm.stopPrank();
    }

    /// Taker `who` trades `lots` against maker `maker` at `price` through the mock book.
    function _trade(address who, address maker, bool isBid, uint64 lots, uint256 price) internal {
        ob.mockSetMaker(maker);
        ob.mockSetFillPrice(price);
        vm.prank(who);
        ob.placeMarketOrder(isBid, lots, 0, 0, false);
    }

    function _roll(uint256 blocks) internal {
        vm.roll(block.number + blocks);
    }

    function _acct(address who) internal view returns (AccountView memory) {
        return ch.getAccount(who);
    }

    function _countFundingUpdated(Vm.Log[] memory logs) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IClearingHouse.FundingUpdated.selector) ++n;
        }
    }
}
