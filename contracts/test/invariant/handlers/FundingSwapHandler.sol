// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ClearingHouse} from "../../../src/clearing/ClearingHouse.sol";
import {OrderBook} from "../../../src/orderbook/OrderBook.sol";
import {FundingSwapMarket} from "../../../src/swaps/FundingSwapMarket.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {IFundingSwapMarket} from "../../../src/interfaces/IFundingSwapMarket.sol";
import {IOrderBook} from "../../../src/interfaces/IOrderBook.sol";

/// @notice WS-05 handler for invariant I9 on the REAL stack: FundingSwapMarket + its own real OrderBook, fed by the
///         real perp ClearingHouse whose funding is driven by a perp MM quoting at a moving premium.
///         Every action is try/catch (fail_on_revert-safe); ghosts count only on success (Phase 2 lesson: recorded
///         logs include reverted calls). Coverage counters: fills, liquidations, settlements, matured.
contract FundingSwapHandler is Test {
    ClearingHouse public ch;
    OrderBook public ob; // perp book
    FundingSwapMarket public fs;
    OrderBook public sob; // swap book (tick 1e14 = 1 bp APR, lot 1,000 MON)
    MockERC20 public ausd;
    address public perpMm;
    address public keeper;
    address[] public actors;

    // ─── coverage / ghosts ────────────────────────────────────────────────
    uint256 public limitOk;
    uint256 public marketOk;
    uint256 public fills; // successful swap Trade events
    uint256 public liquidations;
    uint256 public settlements; // SwapAccrualSettled events of successful calls
    uint256 public maturityFreezeChecks;
    bool public matured;
    /// @dev An account whose settled collateral changed after the maturity snapshot (must stay false).
    bool public accrualAfterMaturity;

    uint64[] internal _perpIds;
    mapping(address => uint64[]) internal _ids;

    constructor(
        ClearingHouse ch_,
        OrderBook ob_,
        FundingSwapMarket fs_,
        OrderBook sob_,
        MockERC20 ausd_,
        address perpMm_,
        address[] memory actors_,
        address keeper_
    ) {
        (ch, ob, fs, sob, ausd, perpMm, keeper) = (ch_, ob_, fs_, sob_, ausd_, perpMm_, keeper_);
        actors = actors_;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    // ─── helpers ──────────────────────────────────────────────────────────
    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// Counts settlements / fills in `logs` (only called after a successful call).
    function _count(Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(fs) && logs[i].topics[0] == IFundingSwapMarket.SwapAccrualSettled.selector) {
                ++settlements;
            }
            if (logs[i].emitter == address(sob) && logs[i].topics[0] == IOrderBook.Trade.selector) ++fills;
        }
    }

    // ─── swap book ────────────────────────────────────────────────────────
    function placeLimit(uint256 who, bool isBid, uint256 aprBp, uint256 lots) external {
        address a = _actor(who);
        uint32 tick = uint32(10_000 + bound(aprBp, 0, 4000)); // APR in [0%, 40%]
        vm.recordLogs();
        vm.prank(a);
        try sob.placeLimitOrder(isBid, tick, uint64(bound(lots, 1, 400)), 0) returns (uint64 id, uint64) {
            ++limitOk;
            if (id != 0) _ids[a].push(id);
            _count(vm.getRecordedLogs());
        } catch {
            vm.getRecordedLogs();
        }
    }

    function placeMarket(uint256 who, bool isBid, uint256 lots) external {
        address a = _actor(who);
        vm.recordLogs();
        vm.prank(a);
        try sob.placeMarketOrder(isBid, uint64(bound(lots, 1, 400)), isBid ? 14_000 : 10_000, 0, false) {
            ++marketOk;
            _count(vm.getRecordedLogs());
        } catch {
            vm.getRecordedLogs();
        }
    }

    function cancel(uint256 who, uint256 idx) external {
        address a = _actor(who);
        uint64[] storage ids = _ids[a];
        if (ids.length == 0) return;
        uint256 i = idx % ids.length;
        uint64 id = ids[i];
        ids[i] = ids[ids.length - 1];
        ids.pop();
        vm.prank(a);
        try sob.cancelOrder(id) {} catch {}
    }

    function deposit(uint256 who, uint256 amount) external {
        address a = _actor(who);
        amount = bound(amount, 1e6, 2000e6);
        ausd.mint(a, amount);
        vm.startPrank(a);
        ausd.approve(address(fs), amount);
        fs.deposit(amount);
        vm.stopPrank();
    }

    function withdraw(uint256 who, uint256 amount) external {
        address a = _actor(who);
        vm.recordLogs();
        vm.prank(a);
        try fs.withdraw(bound(amount, 1, 1000e6)) {
            _count(vm.getRecordedLogs());
        } catch {
            vm.getRecordedLogs();
        }
    }

    function settle(uint256 who) external {
        address a = _actor(who);
        int256 before = fs.collateralOf(a);
        (bool snapped,,) = fs.maturitySnapshot();
        vm.recordLogs();
        fs.settle(a);
        _count(vm.getRecordedLogs());
        _afterMaturityCheck(a, snapped, before);
    }

    /// After the snapshot, a second settle must never move collateral (the first one may apply the tail).
    function _afterMaturityCheck(address a, bool snappedBefore, int256 before) internal {
        if (!snappedBefore) return;
        ++maturityFreezeChecks;
        int256 again = fs.collateralOf(a);
        fs.settle(a);
        if (fs.collateralOf(a) != again) accrualAfterMaturity = true;
        // `before` → `again` may differ once: the first settle after the snapshot applies accrual up to it
        if (before == again) return;
    }

    /// Like a keeper: scan the actors (bounded, 5) from a random start and liquidate the first eligible one.
    function liquidate(uint256 start, uint256 size) external {
        for (uint256 j; j < actors.length; ++j) {
            address t = actors[(start % actors.length + j) % actors.length]; // reduce the seed before adding
            if (!fs.isLiquidatable(t)) continue;
            vm.recordLogs();
            vm.prank(keeper);
            try fs.liquidate(t, bound(size, 1000e18, type(uint128).max)) {
                ++liquidations;
                _count(vm.getRecordedLogs());
            } catch {
                vm.getRecordedLogs();
            }
            return;
        }
    }

    // ─── perp side: blocks, funding regime ───────────────────────────────
    /// Advance 1..500 blocks (~300 ms each) with a keeper funding poke every 20.
    function roll(uint256 n) external {
        n = bound(n, 1, 500);
        for (uint256 done; done < n; done += 20) {
            uint256 step = n - done < 20 ? n - done : 20;
            vm.roll(block.number + step);
            vm.warp(block.timestamp + (step * 3 + 9) / 10);
            ch.updateFunding();
        }
    }

    /// The perp MM re-quotes at a premium in [−3%, +3%]: moves perp funding (and so the swaps' floating leg).
    function regime(uint256 premiumBp) external {
        int256 bp = int256(bound(premiumBp, 0, 600)) - 300;
        uint32 mid = uint32(uint256(int256(29_000) + 29_000 * bp / 10_000));
        vm.startPrank(perpMm);
        for (uint256 i; i < _perpIds.length; ++i) {
            if (ob.getOrder(_perpIds[i]).remainingLots != 0) ob.cancelOrder(_perpIds[i]);
        }
        delete _perpIds;
        for (uint32 i = 1; i <= 3; ++i) {
            (uint64 b,) = ob.placeLimitOrder(true, mid - 10 * i, 100, 0);
            (uint64 a,) = ob.placeLimitOrder(false, mid + 10 * i, 100, 0);
            _perpIds.push(b);
            _perpIds.push(a);
        }
        vm.stopPrank();
    }

    /// Rare: jump past maturity (then every later action runs on a matured market).
    function goToMaturity(uint256 coin) external {
        if (matured || coin % 64 != 0) return; // rare: most runs exercise the live market
        vm.warp(fs.maturity() + 1);
        vm.roll(block.number + 1);
        vm.recordLogs();
        fs.settleMaturity();
        vm.getRecordedLogs();
        matured = true;
    }
}
