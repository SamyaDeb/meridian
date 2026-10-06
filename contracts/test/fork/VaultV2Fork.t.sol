// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {OrderBook} from "../../src/orderbook/OrderBook.sol";
import {MeridianVault} from "../../src/vault/MeridianVault.sol";
import {KuruHedger} from "../../src/vault/KuruHedger.sol";
import {MockOracleAdapter} from "../../src/mocks/MockOracleAdapter.sol";
import {IMeridianVault} from "../../src/interfaces/IMeridianVault.sol";
import {IKuruOrderBook} from "../../src/interfaces/external/IKuruOrderBook.sol";
import {IFundingRateOracle} from "../../src/interfaces/IFundingRateOracle.sol";
import {RiskParams, FundingParams, VaultParams, HedgeState} from "../../src/interfaces/MeridianTypes.sol";

/// @dev Stands in for the hedger for ONE call to read the exact spot amount the vault will send (then the real
///      runtime code is put back). The keeper does the same with a `debug_traceCall` (keepers/ts-fallback/kuruflow.ts).
contract SpotProbe {
    error Probe(uint256 amountIn, uint256 minOut);

    function buySpot(uint256 amountIn, uint256 minOut, bytes calldata) external pure returns (uint256) {
        revert Probe(amountIn, minOut);
    }

    function sellSpot(uint256 amountIn, uint256 minOut, bytes calldata) external pure returns (uint256) {
        revert Probe(amountIn, minOut);
    }
}

/// @notice A-01 FORK PROOF (HARDENING_PLAN P5.3f, CR-014): the vault v2 on a Monad MAINNET fork (chain 143) with the
///         REAL KuruHedger wired Flow-only (`kuruMarket = address(0)`, so an empty route fails loudly instead of hitting
///         the dead Kuru MON/AUSD market, ARCHITECTURE R19), real AUSD (R9), real WMON (R10) and the real
///         KuruFlowEntrypoint (R16), driven by REAL Kuru Flow routes (ws.kuru.io/api/quote calldata, recorded in
///         test/fixtures/vault-v2-fork.json with the pinned fork block; `pnpm flow-quote` in keepers/ts-fallback).
///         The perp leg is our ClearingHouse + OrderBook deployed on the fork with the 143 launch parameters
///         (config/143.json), and the index is a MockOracleAdapter pinned to the Kuru MON/USDC mid (R19b) at the fork
///         block: the oracle is not what is under test; the spot route is. Nothing is broadcast (forge test).
///         Run: MONAD_RPC_URL=… forge test --match-path test/fork/VaultV2Fork.t.sol -vv
///         Without recorded routes, `test_fork_vaultV2_probeAmounts` prints the amounts to quote and the rest skip.
contract VaultV2ForkTest is Test {
    // ARCHITECTURE §Research (config/143.json)
    address constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a; // R9
    address constant WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A; // R10
    address constant FLOW = 0xb3e6778480b2E488385E8205eA05E20060B813cb; // R16 KuruFlowEntrypoint
    address constant MON_USDC = 0x065C9d28E428A0db40191a54d33d5b7c71a9C394; // R19b (index stand-in only)
    /// @dev An AUSD holder on 143 (transfer logs; also used by the P4.4 rehearsal), impersonated ON THE FORK ONLY:
    ///      AUSD's balance slot isn't writable by `deal`.
    address constant AUSD_HOLDER = 0xD5b70d70CBE6C42bCD1aaa662A21673A83f4615b;
    /// @dev Fixed so the recorded quotes (issued for this `userAddress`) stay valid across runs.
    address constant HEDGER = address(uint160(uint256(keccak256("meridian.vault-v2.fork.hedger"))));
    string constant FIXTURE = "test/fixtures/vault-v2-fork.json";
    uint256 constant LOT = 100e18;
    uint256 constant TICK = 1e12;

    address owner = makeAddr("safe-standin");
    address keeper = makeAddr("keeper");
    address mm = makeAddr("mm");
    address whale = makeAddr("whale");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    bool live;
    string fx;
    uint256 index;
    MockOracleAdapter oracle;
    ClearingHouse ch;
    OrderBook ob;
    KuruHedger hedger;
    MeridianVault vault;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true); // no MONAD_RPC_URL: SKIPPED, not a silent PASS
        uint256 forkBlock = vm.envOr("VAULT_FORK_BLOCK", uint256(0));
        if (vm.isFile(FIXTURE)) {
            fx = vm.readFile(FIXTURE);
            if (forkBlock == 0) forkBlock = vm.parseJsonUint(fx, ".forkBlock");
        }
        if (forkBlock == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, forkBlock);
        assertEq(block.chainid, 143, "MONAD_RPC_URL must be mainnet");
        live = true;
        _deploy();
    }

    function _deploy() internal {
        (uint256 bid, uint256 ask) = IKuruOrderBook(MON_USDC).bestBidAsk();
        index = (bid + ask) / 2 / TICK * TICK;
        oracle = new MockOracleAdapter(index);
        InsuranceFund fund = new InsuranceFund(AUSD, owner);
        // config/143.json params.perp (launch caps: maxOpenInterest 250k MON, maxPositionSize 25k MON)
        ch = new ClearingHouse(
            AUSD,
            address(oracle),
            address(fund),
            RiskParams(0.2e18, 0.1e18, 0.0005e18, -0.0001e18, 0.01e18, 0.5e18, 250_000e18, 25_000e18),
            FundingParams(0.002e18, 3_472_222_222, 555_555_555_556, 555_555_556, 300, 0.05e18),
            owner
        );
        ob = new OrderBook(address(ch), TICK, LOT);
        vm.startPrank(owner);
        ch.setOrderBook(address(ob));
        fund.setMarketAuthorized(address(ch), true);
        vm.stopPrank();
        // the 143 hedger shape: Flow routes only
        deployCodeTo("KuruHedger.sol:KuruHedger", abi.encode(owner, WMON, AUSD, FLOW, address(0)), HEDGER);
        hedger = KuruHedger(payable(HEDGER));
        // config/143.json params.vault, with skewCapacity 0.8 (what the Safe sets to enable hedging)
        VaultParams memory p = VaultParams({
            leverage: 1.5e18,
            driftBand: 0.02e18,
            targetMarginRatio: 0.6e18,
            minMarginRatio: 0.25e18,
            exitHorizonSec: 259_200,
            roundTripFee: 0.0015e18,
            maxSlippage: 0.005e18,
            idleBuffer: 0.05e18,
            depositCap: 1200e6,
            skewCapacity: 0.8e18,
            entryHorizonSec: 604_800,
            maxSliceAssets: 2500e6
        });
        vault = new MeridianVault(IERC20(AUSD), address(ch), address(ob), HEDGER, p, owner);
        vm.startPrank(owner);
        hedger.setVault(address(vault));
        vault.setKeeper(keeper, true);
        vault.setSkewProvider(mm, true);
        vm.stopPrank();
        _perpDeposit(mm, 3000e6);
        _perpDeposit(whale, 1500e6);
        _quote();
        // takers net long 25k MON (the per-account cap) ⇒ shortCapacity 20k MON
        uint64 lots = 250;
        vm.prank(whale);
        ob.placeMarketOrder(true, lots, uint32(index / TICK) + 40, lots, false);
        // r̄(8 h) +30% APR: the entry rule passes (the rule itself is unit-tested; the route is what's under test)
        vm.mockCall(
            address(ch),
            abi.encodeWithSelector(IFundingRateOracle.averageFundingRate.selector, uint64(96_000)),
            abi.encode(int256(0.3e18) / 365 days)
        );
        _deposit(alice, 800e6);
        _deposit(bob, 400e6);
    }

    function _fund(address who, uint256 amt) internal {
        vm.prank(AUSD_HOLDER);
        IERC20(AUSD).transfer(who, amt);
    }

    function _perpDeposit(address who, uint256 amt) internal {
        _fund(who, amt);
        vm.startPrank(who);
        IERC20(AUSD).approve(address(ch), amt);
        ch.deposit(amt);
        vm.stopPrank();
    }

    function _deposit(address who, uint256 amt) internal {
        _fund(who, amt);
        vm.startPrank(who);
        IERC20(AUSD).approve(address(vault), amt);
        vault.deposit(amt, who);
        vm.stopPrank();
    }

    /// MM quotes 3 levels × 200 lots each side, 10 ticks apart, around the index.
    function _quote() internal {
        uint32 mid = uint32(index / TICK);
        vm.startPrank(mm);
        for (uint32 i = 1; i <= 3; ++i) {
            ob.placeLimitOrder(true, mid - 10 * i, 200, 0);
            ob.placeLimitOrder(false, mid + 10 * i, 200, 0);
        }
        vm.stopPrank();
    }

    function _route(string memory key) internal view returns (bytes memory r) {
        if (bytes(fx).length == 0 || !vm.keyExistsJson(fx, string.concat(".", key, ".route"))) return r;
        r = vm.parseJsonBytes(fx, string.concat(".", key, ".route"));
    }

    /// The exact spot call the next keeper/owner action would make (amountIn, minOut), via SpotProbe.
    ///      which: 0 = keeper entry (buy), 1 = fulfil of bob's request (sell), 2 = Safe emergencyUnwind (sell).
    function _probe(uint256 which) internal returns (uint256 amountIn, uint256 minOut) {
        bytes memory real = HEDGER.code;
        vm.etch(HEDGER, type(SpotProbe).runtimeCode);
        try this.runProbe(which) {
            revert("probe: no spot call");
        } catch (bytes memory err) {
            vm.etch(HEDGER, real);
            if (bytes4(err) != SpotProbe.Probe.selector) assembly { revert(add(err, 32), mload(err)) }
            assembly {
                amountIn := mload(add(err, 36))
                minOut := mload(add(err, 68))
            }
        }
    }

    function runProbe(uint256 which) external {
        if (which == 0) _enter();
        else if (which == 1) _fulfilDummy();
        else _emergencyDummy();
    }

    function _enter() internal {
        vm.prank(keeper);
        vault.rebalanceWithRoute(hex"00");
    }

    uint256 internal _bobId;

    function _fulfilDummy() internal {
        uint256[] memory ids = new uint256[](1);
        ids[0] = _bobId;
        vm.prank(keeper);
        vault.fulfillRedeems(ids, hex"00");
    }

    function _emergencyDummy() internal {
        vm.prank(owner);
        vault.emergencyUnwind(type(uint256).max, hex"00");
    }

    function _enterWithRoute(bytes memory route) internal {
        vm.prank(keeper);
        IMeridianVault.RebalanceReason r = vault.rebalanceWithRoute(route);
        assertEq(uint8(r), uint8(IMeridianVault.RebalanceReason.EnterHedge));
        vm.roll(block.number + 1);
    }

    function _requestBob() internal {
        uint256 shares = vault.balanceOf(bob);
        vm.prank(bob);
        _bobId = vault.requestRedeem(shares, bob, bob);
    }

    /// Prints what to quote (hedger = HEDGER as the Flow `userAddress`). Always passes.
    function test_fork_vaultV2_probeAmounts() public {
        if (!live) vm.skip(true);
        emit log_named_uint("fork block", block.number);
        emit log_named_address("hedger (Flow userAddress)", HEDGER);
        emit log_named_decimal_uint("index = Kuru MON/USDC mid", index, 18);
        (uint256 buyIn, uint256 buyMin) = _probe(0);
        emit log_named_uint("buy: AUSD in (6 dp)", buyIn);
        emit log_named_uint("buy: min WMON out", buyMin);
        bytes memory buy = _route("buy");
        if (buy.length == 0) return;
        _enterWithRoute(buy);
        uint256 snap = vm.snapshotState();
        _requestBob();
        uint256[] memory ids = new uint256[](1);
        ids[0] = _bobId;
        (, uint256 sell) = vault.previewFulfill(ids);
        (uint256 fIn, uint256 fMin) = _probe(1);
        assertEq(fIn, sell, "previewFulfill reports the exact base the fulfil sells (A-13)");
        emit log_named_uint("fulfil sell: WMON in (wei)", fIn);
        emit log_named_uint("fulfil sell: min AUSD out", fMin);
        vm.revertToState(snap);
        (uint256 eIn, uint256 eMin) = _probe(2);
        emit log_named_uint("emergency sell: WMON in (wei)", eIn);
        emit log_named_uint("emergency sell: min AUSD out", eMin);
    }

    /// A-01 closed: a hedged vault (entered through a real Flow route) serves a redemption beyond idle:
    /// request → keeper `fulfillRedeems` with a real Flow sell route → `claimRedeem` pays the receiver.
    function test_fork_A01_hedgedVault_requestFulfilClaim_realFlowRoutes() public {
        if (!live) vm.skip(true);
        bytes memory buy = _route("buy");
        bytes memory sell = _route("fulfilSell");
        if (buy.length == 0 || sell.length == 0) {
            emit log("no recorded Flow routes: skipped (see test_fork_vaultV2_probeAmounts)");
            vm.skip(true);
        }
        _enterWithRoute(buy);
        HedgeState memory h = vault.hedgeState();
        assertTrue(h.hedged, "entered through the Flow route");
        assertGt(h.spotBase, 0);
        emit log_named_decimal_uint("entered: spot WMON", h.spotBase, 18);
        emit log_named_decimal_int("entered: perp size", h.perpSize, 18);
        emit log_named_decimal_uint("idle AUSD", h.idleAssets, 6);
        assertEq(IERC20(AUSD).allowance(HEDGER, FLOW), 0, "approval reset");
        vm.roll(block.number + 10);
        _requestBob();
        uint256 owed = vault.previewRedeem(vault.getRedeemRequest(_bobId).shares);
        assertGt(owed, vault.hedgeState().idleAssets, "bob's claim exceeds idle");
        uint256[] memory ids = new uint256[](1);
        ids[0] = _bobId;
        // empty route ⇒ hedger without a direct market ⇒ RouteCallFailed (fails loudly, locks nothing)
        vm.prank(keeper);
        vm.expectRevert();
        vault.fulfillRedeems(ids, "");
        vm.prank(keeper);
        vault.fulfillRedeems(ids, sell);
        IMeridianVault.RedeemRequest memory r = vault.getRedeemRequest(_bobId);
        assertEq(uint8(r.status), uint8(IMeridianVault.RedeemStatus.Claimable));
        emit log_named_decimal_uint("fulfilled: bob's payout", r.assets, 6);
        emit log_named_decimal_uint("unwind cost charged to the batch", owed - r.assets, 6);
        uint256 out = vault.claimRedeem(_bobId);
        assertEq(IERC20(AUSD).balanceOf(bob), out, "paid to the receiver");
        assertGt(out, h.idleAssets, "paid beyond idle");
        assertApproxEqRel(out, 400e6, 0.01e18, "within the fee + slippage bound");
        assertEq(vault.claimableAssets(), 0);
        (uint256 lo, uint256 so) = ch.openInterest();
        assertEq(lo, so);
    }

    /// A-01 closed: the Safe can force a hedged vault flat with a real Flow route, while entered.
    function test_fork_A01_emergencyUnwind_realFlowRoute() public {
        if (!live) vm.skip(true);
        bytes memory buy = _route("buy");
        bytes memory sell = _route("emergencySell");
        if (buy.length == 0 || sell.length == 0) {
            emit log("no recorded Flow routes: skipped (see test_fork_vaultV2_probeAmounts)");
            vm.skip(true);
        }
        _enterWithRoute(buy);
        assertTrue(vault.entered());
        uint256 nav0 = vault.totalAssets();
        vm.prank(owner);
        vault.emergencyUnwind(type(uint256).max, sell);
        HedgeState memory h = vault.hedgeState();
        emit log_named_decimal_uint("after emergencyUnwind: spot WMON (route leftover)", h.spotBase, 18);
        emit log_named_decimal_uint("NAV before", nav0, 6);
        emit log_named_decimal_uint("NAV after", vault.totalAssets(), 6);
        assertEq(h.perpSize, 0, "perp flat");
        assertLt(h.spotBase, LOT, "spot sold (< 1 lot left)");
        assertLt(ch.getAccount(address(vault)).collateral, 1e12, "collateral back in the vault");
        assertFalse(vault.entered());
        assertApproxEqRel(vault.totalAssets(), nav0, 0.01e18, "NAV kept within the slippage bound");
        uint256 shares = vault.balanceOf(alice);
        assertEq(vault.maxRedeem(alice), shares, "everyone can leave through the sync path");
        vm.prank(alice);
        vault.redeem(shares, alice, alice);
    }
}
