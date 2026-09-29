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
        if (bytes(rpc).length == 0) return;
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
}
