// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AddMarketBase} from "../script/AddMarketBase.t.sol";
import {AccountView, RiskParams} from "../../src/interfaces/MeridianTypes.sol";

/// @notice K7: rounding on ETH-PERP at ETH prices (100 … 100,000 USD, off the tick grid for the index), always against
///         the user (CONTRIBUTING §2): reserve ↑, taker fee ↑, maker rebate ↓, IM/MM ↑, upnl ↓. The market is the one
///         `AddMarket` deploys from config `markets.eth` (tick 0.10, lot 0.001 ETH).
contract EthMarketFuzzTest is AddMarketBase {
    address internal mm = makeAddr("mm");
    address internal taker = makeAddr("taker");

    function setUp() public {
        _baseDeploy("fuzz", vm.addr(PK), false);
        _addEth("fuzz", ETH0);
        _fund(mm, 1_000_000e6);
        _fund(taker, 1_000_000e6);
    }

    function _start(uint256 index) internal returns (uint256 p) {
        p = bound(index, 100e18, 100_000e18);
        _roll(1);
        _push(p);
    }

    /// MATH_SPEC §3.2: reserve(order) = size·price·imr ↑. On the ETH grid size·price = lots·ticks·1e14 (exact).
    function testFuzz_reserveRoundsUp(uint256 index, uint64 lots, uint32 below) public {
        uint256 p = _start(index);
        lots = uint64(bound(lots, 1, 250));
        uint32 tick = _tick(p) - uint32(bound(below, 1, 100));
        uint256 imr = ch.riskParams().imr;
        vm.prank(mm);
        ob.placeLimitOrder(true, tick, lots, 0);
        uint256 size = uint256(lots) * ob.lotSize();
        uint256 price = uint256(tick) * ob.tickSize();
        uint256 reserved = ch.getAccount(mm).reservedOrderMargin;
        assertGe(reserved * 1e36, size * price * imr, "reserve rounds up");
        assertLe(reserved, size * price * imr / 1e36 + 2, "and tight");
        assertEq(reserved, uint256(lots) * tick * 2e13, "exact on the ETH grid (imr 20%)");
    }

    /// MATH_SPEC §3.1: taker fee = notional·takerFee ↑ (taker pays more), maker rebate ↓ (maker gets less).
    function testFuzz_feesRoundAgainstTheUser(uint256 index, uint64 lots, uint32 above) public {
        uint256 p = _start(index);
        lots = uint64(bound(lots, 1, 250));
        uint32 tick = _tick(p) + uint32(bound(above, 0, 50));
        vm.prank(mm);
        ob.placeLimitOrder(false, tick, lots, 0);
        uint256 cTaker = ch.getAccount(taker).collateral;
        uint256 cMaker = ch.getAccount(mm).collateral;
        vm.prank(taker);
        ob.placeMarketOrder(true, lots, tick, lots, false);
        uint256 notional = uint256(lots) * ob.lotSize() * (uint256(tick) * ob.tickSize());
        RiskParams memory r = ch.riskParams();
        uint256 paid = cTaker - ch.getAccount(taker).collateral;
        uint256 rebate = ch.getAccount(mm).collateral - cMaker;
        assertGe(paid * 1e36, notional * r.takerFee, "taker fee rounds up");
        assertLe(rebate * 1e36, notional * uint256(-r.makerFee), "maker rebate rounds down");
        assertLe(paid, notional * r.takerFee / 1e36 + 1);
        assertGe(rebate + 1, notional * uint256(-r.makerFee) / 1e36);
    }

    /// MATH_SPEC §3.2 at an off-grid mark: IM ↑, MM ↑, upnl ↓ for both sides of an ETH fill.
    function testFuzz_marginAtOffGridMark(uint256 index, uint64 lots, uint256 move) public {
        uint256 p = _start(index);
        lots = uint64(bound(lots, 1, 250));
        uint32 tick = _tick(p) + 1;
        vm.prank(mm);
        ob.placeLimitOrder(false, tick, lots, 0);
        vm.prank(taker);
        ob.placeMarketOrder(true, lots, tick, lots, false);
        // the index moves by up to ±4% to a price off the tick grid
        uint256 p2 = p * bound(move, 0.96e18, 1.04e18) / 1e18 + 7;
        _roll(1);
        _push(p2);
        uint256 mark = ch.markPrice();
        RiskParams memory r = ch.riskParams();
        _checkSide(ch.getAccount(taker), mark, r);
        _checkSide(ch.getAccount(mm), mark, r);
    }

    function _checkSide(AccountView memory v, uint256 mark, RiskParams memory r) internal pure {
        uint256 q = v.size >= 0 ? uint256(v.size) : uint256(-v.size);
        assertGe(v.maintenanceMargin * 1e36, q * mark * r.mmr, "MM rounds up");
        assertLe(v.maintenanceMargin, q * mark * r.mmr / 1e36 + 2);
        assertGe((v.initialMargin - v.reservedOrderMargin) * 1e36, q * mark * r.imr, "IM rounds up");
        // upnl = q·mark − ON ↓ ; ON = q·entry (exact on the grid)
        int256 on = v.size * int256(v.entryPrice) / 1e18;
        int256 exact = v.size * int256(mark) - on * 1e18; // ×1e18
        assertLe(v.unrealizedPnl * 1e18, exact, "upnl rounds down");
        assertGt((v.unrealizedPnl + 2) * 1e18, exact, "and tight");
    }
}
