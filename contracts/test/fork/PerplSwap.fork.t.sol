// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PerplFundingSource} from "../../src/oracle/PerplFundingSource.sol";
import {IPerplExchange} from "../../src/interfaces/external/IPerplExchange.sol";
import {FundingSwapMarket} from "../../src/swaps/FundingSwapMarket.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {SwapParams, MeridianConstants} from "../../src/interfaces/MeridianTypes.sol";

/// @notice PS Phase 1: the adapter against the REAL Perpl exchange on a Monad testnet fork, then a real
///         FundingSwapMarket + OrderBook on top of it, held across a real Perpl funding event.
///         Pinned blocks reproduce docs/PERPL_SWAPS.md §Units: feb 70,419,336 (sum −21,375) → feb 70,427,907
///         (sum −21,400, rate −1 per 100k: longs RECEIVE). Needs an archive RPC (the public testnet RPC is one,
///         ARCHITECTURE R29):
///           MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz forge test --match-path test/fork/PerplSwap.fork.t.sol
///         Unset ⇒ SKIPPED, not a silent PASS.
contract PerplSwapForkTest is Test {
    // deployments/perpl.json (chains.10143)
    address constant PERPL = 0x1964C32f0bE608E7D29302AFF5E61268E72080cc;
    uint256 constant PERP = 64;
    uint256 constant IS = 2580;
    // docs/PERPL_SWAPS.md §Units, read with getFundingSumAtBlock
    uint256 constant FEB_A = 70_419_336;
    int48 constant SUM_A = -21_375;
    uint256 constant FEB_B = 70_427_907;
    int48 constant SUM_B = -21_400;
    uint256 constant FORK_A = FEB_A + 200;
    uint256 constant FORK_B = FEB_B + 200;
    // deployments/10143.json: contracts.FundingSwapMarket and the demo-MM operator that quotes it (_operators)
    address constant LIVE_SWAP = 0xACFc9b2aEfD546AEd1FB21B2D82C5433c1d3Fe33;
    address constant LIVE_SWAP_ACCOUNT = 0xB1a78a9cB3FE3aB4f0c49ad0dBC080EF18305bd1; // K ≠ 0 at FORK_B

    int256 constant YEAR = int256(MeridianConstants.SECONDS_PER_YEAR);
    uint256 constant TICK = 1e14; // 1 bp APR (script/config/10143.json params.swap)
    uint256 constant LOT = 1000e18; // 1,000 MON
    uint64 constant LOTS = 100; // 100,000 MON notional

    PerplFundingSource src;
    FundingSwapMarket fs;
    OrderBook ob;
    MockERC20 ausd;
    InsuranceFund fund;
    address alice = makeAddr("alice"); // swap long: receives F rises (what a Perpl long pays), pays fixed
    address bob = makeAddr("bob"); // short
    address owner = makeAddr("owner");
    uint256 forkId;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true); // SKIPPED, not a silent PASS
        forkId = vm.createSelectFork(rpc, FORK_A);
    }

    function _params() internal pure returns (SwapParams memory) {
        // script/config/10143.json params.swap.params
        return SwapParams({
            aprMoveBuffer: 0.05e18,
            liqHorizonSec: 86_400,
            imMultiplier: 1.5e18,
            takerFeeApr: 0.002e18,
            makerFeeApr: -0.0005e18,
            liqPenalty: 0.2e18,
            keeperShare: 0.5e18,
            maxOpenInterest: 2_000_000e18,
            maxPositionSize: 200_000e18
        });
    }

    function test_fork_adapterReproducesPhase0() public {
        (int48 s, uint256 feb) = IPerplExchange(PERPL).getFundingSumAtBlock(PERP, block.number);
        assertEq(s, SUM_A);
        assertEq(feb, FEB_A);
        src = new PerplFundingSource(PERPL, PERP, IS);
        assertEq(src.sumScale(), 1e10);
        assertEq(src.priceScale(), 1e13);
        assertEq(src.fundingIntervalBlocks(), 8571);
        (int256 f, int256 g, uint64 b) = src.latestObservation();
        assertEq(f, int256(SUM_A) * 1e10);
        assertEq(g, 0);
        assertEq(b, FEB_A);
        assertGt(src.indexPrice(), 0);
        assertFalse(src.poke()); // no new event yet
    }

    // snapshot before the funding event (storage: keeps the test under the stack limit)
    int256 f0;
    int256 g0;
    int256 cA;
    int256 cB;

    function test_fork_swapAcrossRealFundingEvent() public {
        // ── at FORK_A: the adapter, a real swap market and its book; alice long / bob short 100 lots at 10.00% ──
        _deployStack();
        _fund(alice);
        _fund(bob);
        // alice bids 100 lots at 10.00% APR (price 1.10 ⇒ tick 11,000), bob sells into it
        vm.prank(alice);
        ob.placeLimitOrder(true, 11_000, LOTS, 0);
        vm.prank(bob);
        ob.placeMarketOrder(false, LOTS, 1, LOTS, false);
        int256 qA = fs.getPosition(alice).size;
        int256 kA = fs.getPosition(alice).fixedAprNotional;
        assertEq(qA, int256(uint256(LOTS) * LOT));
        assertEq(fs.getPosition(bob).size, -qA);
        assertEq(kA, qA / 10);
        (f0, g0,) = src.latestObservation();
        (cA, cB) = (fs.collateralOf(alice), fs.collateralOf(bob));

        // ── cross a real Perpl funding event ──
        vm.rollFork(forkId, FORK_B);
        (int48 s, uint256 feb) = IPerplExchange(PERPL).getFundingSumAtBlock(PERP, block.number);
        assertEq(s, SUM_B);
        assertEq(feb, FEB_B);
        uint256 price = IPerplExchange(PERPL).getPerpetualInfoV2(PERP).oraclePNS * 1e13;
        assertTrue(src.poke());
        (int256 f1, int256 g1, uint64 b1) = src.latestObservation();
        assertEq(f1, int256(SUM_B) * 1e10);
        assertEq(b1, FEB_B);
        assertEq(g1 - g0, int256(price * (FEB_B - FEB_A) * IS / 8571)); // = I·2,580 s
        assertLt(f1 - f0, 0); // rate −1: Perpl longs receive

        fs.settle(alice);
        fs.settle(bob);
        _checkSettlement(qA, kA, f1 - f0, g1 - g0, fs.collateralOf(alice) - cA, fs.collateralOf(bob) - cB);
    }

    function _deployStack() internal {
        src = new PerplFundingSource(PERPL, PERP, IS);
        ausd = new MockERC20("tAUSD", "tAUSD", 6);
        fund = new InsuranceFund(address(ausd), owner);
        fs = new FundingSwapMarket(
            address(src), address(ausd), address(fund), uint64(block.timestamp + 30 days), _params(), owner
        );
        ob = new OrderBook(address(fs), TICK, LOT);
        vm.startPrank(owner);
        fs.setOrderBook(address(ob));
        fund.setMarketAuthorized(address(fs), true);
        vm.stopPrank();
        // locally deployed contracts and accounts survive vm.rollFork
        vm.makePersistent(address(src), address(fs), address(ob));
        vm.makePersistent(address(ausd), address(fund), owner);
        vm.makePersistent(alice, bob);
    }

    function _checkSettlement(int256 qA, int256 kA, int256 dF, int256 dG, int256 netA, int256 netB) internal {
        // MATH_SPEC §6.2: net = q·ΔF/1e18 − K·ΔG/(1e18·YEAR), one floor division ⇒ within 1 wei of the two legs
        int256 fixedA = kA * dG / (1e18 * YEAR);
        assertApproxEqAbs(netA, qA * dF / 1e18 - fixedA, 1);
        assertApproxEqAbs(netB, -qA * dF / 1e18 + fixedA, 1);
        // conservation: the two sides sum to −dust, 0 ≤ dust ≤ #settlements (2)
        int256 dust = -(netA + netB);
        assertGe(dust, 0);
        assertLe(dust, 2);
        // The hedge: a swap long pays what a Perpl long of the same size receives (rate −1 ⇒ Perpl longs receive), so
        // Perpl long + swap long = exactly the fixed leg, 10% APR on I·Δt (within 1 wei of rounding).
        int256 perplLongReceives = -qA * dF / 1e18;
        assertGt(perplLongReceives, 0);
        assertLt(netA, 0);
        assertApproxEqAbs(netA + perplLongReceives, -fixedA, 1);
        emit log_named_int("alice net (WAD)", netA);
        emit log_named_int("bob net (WAD)", netB);
        emit log_named_int("floating per 1 MON dF (WAD)", dF);
        emit log_named_int("dG (WAD s)", dG);
    }

    /// Gas (run with --isolate so every call is its own transaction): poke against the real exchange (advance and
    /// no-op) and a swap `settle` with a position, on this market vs the live Meridian swap market at the same block.
    function test_fork_gas() public {
        _deployStack();
        _fund(alice);
        _fund(bob);
        vm.prank(alice);
        ob.placeLimitOrder(true, 11_000, LOTS, 0);
        vm.prank(bob);
        ob.placeMarketOrder(false, LOTS, 1, LOTS, false);
        vm.rollFork(forkId, FORK_B);
        src.poke();
        emit log_named_uint("gas poke (advance, real Perpl)", _lastGas());
        src.poke();
        emit log_named_uint("gas poke (no-op)", _lastGas());
        fs.settle(alice);
        emit log_named_uint("gas settle (Perpl market, position, new F/G)", _lastGas());
        fs.settle(alice);
        emit log_named_uint("gas settle (Perpl market, same block again)", _lastGas());
        // the live Meridian swap market (deployments/10143.json contracts.FundingSwapMarket), same block
        FundingSwapMarket live = FundingSwapMarket(LIVE_SWAP);
        live.settle(LIVE_SWAP_ACCOUNT);
        emit log_named_uint("gas settle (live Meridian market)", _lastGas());
    }

    /// @dev gasTotalUsed of the last call, read raw: this forge binary returns a 5-word Vm.Gas while the vendored
    ///      forge-std declares a longer struct, so the typed `vm.lastCallGas()` decode reverts.
    function _lastGas() internal view returns (uint256 used) {
        (bool ok, bytes memory r) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok && r.length >= 64, "lastCallGas");
        assembly ("memory-safe") {
            used := mload(add(r, 64))
        }
    }

    function _fund(address who) internal {
        ausd.mint(who, 1000e6);
        vm.startPrank(who);
        ausd.approve(address(fs), type(uint256).max);
        fs.deposit(1000e6);
        vm.stopPrank();
    }
}
