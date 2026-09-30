// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {DeployPulse} from "../../script/DeployPulse.s.sol";
import {PulseVault} from "../../src/vault/PulseVault.sol";
import {KuruHedger} from "../../src/vault/KuruHedger.sol";
import {FundingSwapMarket} from "../../src/swaps/FundingSwapMarket.sol";
import {InsuranceFund} from "../../src/clearing/InsuranceFund.sol";
import {ClearingHouse} from "../../src/clearing/ClearingHouse.sol";

/// @notice `DeployPulse` against a Monad MAINNET fork (chain 143) with the real `script/config/143.json`, patched only
///         where the file is still open (owner = a test Safe stand-in, oracle.maxDeviationWad = a test value). Proves:
///         every Ownable ends with the owner (Safe), the deployer holds no role, the swap maturity is listing + 30 d,
///         the launch vault cap, and the mainnet refusals (no tAUSD, no demo market, no mocks, no keeper-fed oracle,
///         no deployer owner). Runs only with MONAD_RPC_URL (skips otherwise). Nothing is broadcast: forge test.
contract DeployPulseMainnetForkTest is Test {
    string constant TMP = "tmp/143-test.json";
    address constant SAFE = address(0x5AFE00000000000000000000000000000000005A); // stand-in, not the real Safe
    uint256 constant PK = 0xA11CE5AFE;
    address deployer;
    address keeper = makeAddr("keeper");
    address mm = makeAddr("mm");
    address mmEnv = mm;
    string base;
    string root;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 143, "MONAD_RPC_URL must be mainnet");
        deployer = vm.addr(PK);
        vm.deal(deployer, 10_000 ether);
        root = vm.projectRoot();
        base = vm.readFile(string.concat(root, "/script/config/143.json"));
        base = vm.replace(base, '"owner": null,', string.concat('"owner": "', vm.toString(SAFE), '",'));
        base = vm.replace(base, '"maxDeviationWad": null', '"maxDeviationWad": "20000000000000000"');
    }

    function _env(string memory json, bool vault, bool swaps) internal {
        vm.writeFile(string.concat(root, "/script/config/", TMP), json);
        vm.setEnv("DEPLOY_CONFIG", TMP);
        vm.setEnv("DEPLOYER_PK", vm.toString(PK));
        vm.setEnv("DEPLOYMENTS_OUT", "fork-test-143.json");
        vm.setEnv("KEEPER_ADDRESS", vm.toString(keeper));
        vm.setEnv("MM_ADDRESS", vm.toString(mmEnv));
        vm.setEnv("DEPLOY_VAULT", vault ? "true" : "false");
        vm.setEnv("DEPLOY_SWAPS", swaps ? "true" : "false");
        vm.setEnv("SWAP_MATURITY_IN_SEC", "0");
        vm.setEnv("REUSE_DEPLOYMENT", "");
        vm.setEnv("DEPLOY_CRE_RECEIVER", "false");
    }

    function _run(string memory json, bool vault, bool swaps) internal returns (DeployPulse.Deployed memory) {
        _env(json, vault, swaps);
        return new DeployPulse().run();
    }

    /// @dev Asserts the deploy reverts (with `reason` when non-empty), then restores the fork state.
    function _refuses(string memory json, bool vault, string memory reason) internal {
        uint256 snap = vm.snapshotState();
        _env(json, vault, false);
        DeployPulse s = new DeployPulse();
        if (bytes(reason).length != 0) vm.expectRevert(bytes(reason));
        else vm.expectRevert();
        s.run();
        // a refusal inside the broadcast section leaves the broadcast open
        try vm.stopBroadcast() {} catch {}
        vm.revertToState(snap);
    }

    function _owned(address a) internal view {
        assertEq(Ownable(a).owner(), SAFE, "owner = Safe");
        assertTrue(Ownable(a).owner() != deployer);
    }

    function _fullDeploy() internal {
        uint256 t0 = block.timestamp;
        DeployPulse.Deployed memory d = _run(base, true, true);
        address[7] memory owned =
            [d.insuranceFund, d.marketFactory, d.perp.oracle, d.perp.clearingHouse, d.swapMarket, d.vault, d.hedger];
        for (uint256 i; i < owned.length; ++i) {
            assertGt(owned[i].code.length, 0, "deployed");
            _owned(owned[i]);
        }
        assertGt(d.perp.orderBook.code.length, 0);
        assertGt(d.swapOrderBook.code.length, 0);
        assertEq(d.ausd, 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a, "real AUSD (ARCHITECTURE R9)");
        assertEq(d.demo.clearingHouse, address(0), "no demo market on mainnet");
        // roles: keeper + MM are the bots, never the deployer
        PulseVault v = PulseVault(d.vault);
        assertFalse(v.isKeeper(deployer));
        assertTrue(v.isKeeper(keeper));
        assertEq(v.skewProviders(0), mm);
        assertEq(KuruHedger(payable(d.hedger)).vault(), d.vault, "hedger wired once");
        assertEq(v.vaultParams().depositCap, 1200e6, "PHASES decision 12");
        // MATH_SPEC §6.1: one 30-day contract from listing
        assertEq(FundingSwapMarket(d.swapMarket).maturity(), t0 + 30 days);
        // IF authorises both markets; CH is wired to its OB
        assertTrue(InsuranceFund(d.insuranceFund).isAuthorized(d.perp.clearingHouse));
        assertTrue(InsuranceFund(d.insuranceFund).isAuthorized(d.swapMarket));
        assertEq(ClearingHouse(d.perp.clearingHouse).orderBook(), d.perp.orderBook);
        vm.removeFile(string.concat(root, "/../deployments/fork-test-143.json"));
    }

    /// @dev One test function on purpose: `vm.setEnv` and the patched config file are process-global, and forge runs
    ///      test functions in parallel, so the scenarios must not interleave.
    function test_mainnet_deployAndRefusals() public {
        _fullDeploy();
        string memory safeLine = string.concat('"owner": "', vm.toString(SAFE), '",');
        _refuses(
            vm.replace(base, safeLine, '"owner": null, "ownerIsDeployer": true,'),
            false,
            "mainnet owner must be the Safe 2-of-3"
        );
        _refuses(vm.replace(base, safeLine, '"owner": null,'), false, "VERIFY: owner missing in config");
        _refuses(
            vm.replace(base, '"AUSD": "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",', '"AUSD": null,'),
            false,
            "mainnet needs the real AUSD"
        );
        _refuses(
            vm.replace(
                base, '"chainId": 143,', '"chainId": 143, "demoMarket": {"enabled": true, "symbol": "MON-PERP-DEMO"},'
            ),
            false,
            "no test markets on mainnet"
        );
        _refuses(
            vm.replace(
                base, '"flowEntrypoint": "0xb3e6778480b2E488385E8205eA05E20060B813cb",', '"flowEntrypoint": null,'
            ),
            true,
            "VERIFY: kuru.flowEntrypoint for mainnet"
        );
        mmEnv = address(0);
        _refuses(base, true, "mainnet vault: set KEEPER_ADDRESS and MM_ADDRESS");
        mmEnv = mm;
        // TestnetKeeperOracle's constructor refuses every chain but 10143/31337 (InvalidOracleParams)
        _refuses(
            vm.replace(base, '"kind": "pyth",', '"kind": "keeper-fed", "keeperFedMaxStalenessSec": 30,'), false, ""
        );
        vm.setEnv("DEPLOY_CONFIG", "");
    }
}
