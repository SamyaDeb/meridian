// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PerplFundingSource} from "../../../src/oracle/PerplFundingSource.sol";
import {MockPerplExchange} from "../../../src/mocks/MockPerplExchange.sol";
import {FundingSwapMarket} from "../../../src/swaps/FundingSwapMarket.sol";
import {OrderBook} from "../../../src/orderbook/OrderBook.sol";

/// @notice WS-08 handler for a FundingSwapMarket settling on Perpl funding (CR-017): scripted Perpl funding events
///         (`fundingEvent`), `poke`, `open` (an actor takes a fresh LP quote), `close` (reduce-only against a fresh LP
///         quote) and `settle`. Ghosts track what the invariants need: Perpl's applied sum and every (F, G) poke wrote.
contract PerplSwapHandler is Test {
    uint256 public constant PERP = 64;
    uint256 public constant IB = 8571;
    uint256 public constant IS = 2580;
    uint256 internal constant LOT = 1000e18;

    MockPerplExchange public x;
    PerplFundingSource public src;
    FundingSwapMarket public fs;
    OrderBook public ob;
    address public lp;
    address[] public actors;

    int48 public ghostSum;
    uint256 public ghostFeb;
    uint256 public pricePNS = 2500;
    int256 public lastG;
    bool public gDecreased;
    bool public fMismatch;
    mapping(bytes32 => uint256) public calls;

    constructor(
        MockPerplExchange x_,
        PerplFundingSource src_,
        FundingSwapMarket fs_,
        OrderBook ob_,
        address lp_,
        address[] memory actors_,
        int48 sum0,
        uint256 feb0
    ) {
        (x, src, fs, ob, lp, actors) = (x_, src_, fs_, ob_, lp_, actors_);
        (ghostSum, ghostFeb) = (sum0, feb0);
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    /// A Perpl funding event 1–3 intervals later, rate within the ±10 per 100k clamp, at a price that drifts ±5%.
    function fundingEvent(uint256 rateSeed, uint256 nSeed, uint256 priceSeed) external {
        uint256 n = bound(nSeed, 1, 3);
        int256 rate = int256(bound(rateSeed, 0, 20)) - 10;
        pricePNS = bound(pricePNS * (9500 + priceSeed % 1001) / 10_000, 500, 50_000);
        // Perpl: ppl = trunc0(rate · price · 10^exp / 1e5) per interval (docs/PERPL_SWAPS.md §Units)
        ghostSum += int48(rate * int256(pricePNS) * 1000 / 1e5 * int256(n));
        ghostFeb += n * IB;
        x.pushEvent(PERP, ghostFeb, ghostSum);
        vm.roll(ghostFeb + 10);
        vm.warp(block.timestamp + n * IS);
        x.setPrice(PERP, pricePNS, block.timestamp);
        ++calls["fundingEvent"];
    }

    function poke() external {
        src.poke();
        (int256 f, int256 g,) = src.latestObservation();
        if (g < lastG) gDecreased = true;
        if (f != int256(ghostSum) * 1e10) fMismatch = true;
        lastG = g;
        ++calls["poke"];
    }

    function open(uint256 actorSeed, uint256 lotsSeed, bool isLong, uint256 aprSeed) external {
        address a = actors[actorSeed % actors.length];
        uint64 lots = uint64(bound(lotsSeed, 1, 20));
        uint32 tick = uint32(bound(aprSeed, 10_500, 11_500)); // 5% … 15% APR
        uint64 id;
        vm.prank(lp);
        try ob.placeLimitOrder(!isLong, tick, lots, 0) returns (uint64 oid, uint64) {
            id = oid;
        } catch {
            ++calls["open:lpRejected"];
            return;
        }
        vm.prank(a);
        try ob.placeMarketOrder(isLong, lots, isLong ? type(uint32).max - 1 : 1, lots, false) {
            ++calls["open"];
        } catch {
            ++calls["open:rejected"];
        }
        _cancelLp(id);
    }

    function close(uint256 actorSeed, uint256 aprSeed) external {
        address a = actors[actorSeed % actors.length];
        int256 q = fs.getPosition(a).size;
        if (q == 0) return;
        bool isLong = q > 0;
        uint64 lots = uint64(uint256(isLong ? q : -q) / LOT);
        uint32 tick = uint32(bound(aprSeed, 10_500, 11_500));
        uint64 id;
        vm.prank(lp);
        try ob.placeLimitOrder(isLong, tick, lots, 0) returns (uint64 oid, uint64) {
            id = oid;
        } catch {
            ++calls["close:lpRejected"];
            return;
        }
        vm.prank(a);
        try ob.placeMarketOrder(!isLong, lots, isLong ? 1 : type(uint32).max - 1, lots, true) {
            ++calls["close"];
        } catch {
            ++calls["close:rejected"];
        }
        _cancelLp(id);
    }

    function settle(uint256 actorSeed) external {
        fs.settle(actorSeed % 2 == 0 ? lp : actors[actorSeed % actors.length]);
        ++calls["settle"];
    }

    /// @dev Leave the book empty between actions: cancel what is left of the LP's quote (no-op if fully filled).
    function _cancelLp(uint64 id) internal {
        if (id == 0 || ob.getOrder(id).remainingLots == 0) return;
        vm.prank(lp);
        ob.cancelOrder(id);
    }
}
