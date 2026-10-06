// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IPythMinimal} from "../../src/interfaces/external/IPythMinimal.sol";
import {AggregatorV3Interface} from "../../src/interfaces/external/AggregatorV3Interface.sol";
import {PythChainlinkOracleAdapter} from "../../src/oracle/PythChainlinkOracleAdapter.sol";

/// @notice Read-only fork test against the real Monad mainnet feeds (ARCHITECTURE R11, R12).
/// Runs only with MONAD_RPC_URL set. Uses maxStaleness 60 s (sponsored-push fallback, R24).
contract OracleAdapterForkTest is Test {
    IPythMinimal constant PYTH = IPythMinimal(0x2880aB155794e7179c9eE2e38200202908C17B43);
    bytes32 constant MON_USD = 0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1;
    AggregatorV3Interface constant CL_MON_USD = AggregatorV3Interface(0xBcD78f76005B7515837af6b50c7C52BCf73822fb);

    function test_fork_realFeeds() public {
        string memory rpc = vm.envOr("MONAD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true); // no MONAD_RPC_URL: SKIPPED, not a silent PASS
        vm.createSelectFork(rpc);

        assertEq(CL_MON_USD.decimals(), 8, "chainlink decimals");
        PythChainlinkOracleAdapter o =
            new PythChainlinkOracleAdapter(address(this), PYTH, MON_USD, CL_MON_USD, 60, 0.02e18, 1 hours, "MON / USD");
        assertEq(o.secondaryScale(), 1e10);

        IPythMinimal.Price memory px = PYTH.getPriceUnsafe(MON_USD);
        (, int256 answer,, uint256 clUpdatedAt,) = CL_MON_USD.latestRoundData();
        emit log_named_int("pyth price", px.price);
        emit log_named_int("pyth expo", px.expo);
        emit log_named_uint("pyth age s", block.timestamp - px.publishTime);
        emit log_named_int("chainlink answer (8dp)", answer);
        emit log_named_uint("chainlink age s", block.timestamp - clUpdatedAt);

        (bool ok, uint256 p, uint256 t) = o.tryGetIndexPrice();
        emit log_named_uint("index WAD", p);
        if (block.timestamp - px.publishTime <= 60) {
            assertTrue(ok, "fresh sponsored price should pass the adapter");
            assertEq(t, px.publishTime);
            assertGt(p, 0.001e18);
            assertLt(p, 10e18);
        }
    }

    // ─── Phase 5 B3: the chosen mainnet parameters (docs/standup/B.md, keepers/ts-fallback/evidence/) ────────────
    /// maxStalenessSec = 60 (no Pyth API key ⇒ sponsored pushes, R24; 72 h sample: sponsored age p99 50 s, max 66 s)
    uint256 constant STALENESS_143 = 60;
    /// maxDeviationWad = 3% (72 h sample of 8,581 blocks: p99 0.50%, p99.9 1.02%, max 1.42% with BOTH feeds fresh)
    uint256 constant DEVIATION_143 = 0.03e18;
    /// Worst sampled block: Pyth 0.02935634 (1 s old) vs Chainlink 0.0289459 (4 s old) = 1.418% apart.
    uint256 constant WORST_BLOCK = 108_753_387;

    function _adapter(uint256 staleness, uint256 dev) internal returns (PythChainlinkOracleAdapter) {
        return
            new PythChainlinkOracleAdapter(
                address(this), PYTH, MON_USD, CL_MON_USD, staleness, dev, 1 hours, "MON / USD"
            );
    }

    /// The chosen guard keeps the worst real disagreement of the window usable; a 1% guard would have frozen the
    /// market (stale ⇒ reduce-only) at that block although neither feed was broken.
    function test_fork_chosenParams_worstObservedDeviation() public {
        string memory rpc = vm.envOr("MONAD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true); // no MONAD_RPC_URL: SKIPPED, not a silent PASS
        vm.createSelectFork(rpc, WORST_BLOCK);
        PythChainlinkOracleAdapter o = _adapter(STALENESS_143, DEVIATION_143);
        (bool ok, uint256 p,) = o.tryGetIndexPrice();
        assertTrue(ok, "3% guard accepts the worst observed disagreement");
        assertEq(p, 0.02935634e18, "Pyth primary, expo -8 scaled to WAD");
        (bool ok1,,) = _adapter(STALENESS_143, 0.01e18).tryGetIndexPrice();
        assertFalse(ok1, "a 1% guard trips on healthy feeds");
    }

    /// Live head with the chosen parameters: usable whenever the sponsored price is ≤ 60 s old.
    function test_fork_chosenParams_head() public {
        string memory rpc = vm.envOr("MONAD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true); // no MONAD_RPC_URL: SKIPPED, not a silent PASS
        vm.createSelectFork(rpc);
        PythChainlinkOracleAdapter o = _adapter(STALENESS_143, DEVIATION_143);
        IPythMinimal.Price memory px = PYTH.getPriceUnsafe(MON_USD);
        (bool ok,,) = o.tryGetIndexPrice();
        emit log_named_uint("pyth age s", block.timestamp - px.publishTime);
        assertEq(ok, block.timestamp - px.publishTime <= STALENESS_143);
        assertEq(o.maxStaleness(), 60);
        assertEq(o.maxDeviation(), 0.03e18);
    }
}
