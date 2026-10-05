// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {DeployBase} from "../../script/DeployBase.s.sol";
import {RiskParams, FundingParams, SwapParams, VaultParams} from "../../src/interfaces/PulseTypes.sol";
import {FundingSwapMarket} from "../../src/swaps/FundingSwapMarket.sol";

/// @dev Exposes DeployBase's own parsers, so the test reads `143.json` exactly as DeployPulse does.
contract Config143Reader is DeployBase {
    /// @dev Same file and chain-id check as `_loadConfig`, without `DEPLOY_CONFIG`: env vars are process-global and
    ///      the fork test sets that one while suites run in parallel.
    function load() external {
        cfg = vm.readFile(string.concat(vm.projectRoot(), "/script/config/143.json"));
        require(stdJson.readUint(cfg, ".chainId") == 143, "config chainId mismatch");
    }

    function raw() external view returns (string memory) {
        return cfg;
    }

    function optAddress(string memory key) external view returns (address) {
        return _optAddress(key);
    }

    function optUint(string memory key) external view returns (uint256) {
        return _optUint(key);
    }

    function risk() external view returns (RiskParams memory) {
        return _riskParams();
    }

    function funding() external view returns (FundingParams memory) {
        return _fundingParams();
    }

    function swap() external view returns (SwapParams memory) {
        return _swapParams();
    }

    function vault() external view returns (VaultParams memory) {
        return _vaultParams();
    }
}

/// @notice Launch invariants of `script/config/143.json` (Phase 3 P1, docs/outputs/MAINNET_CONFIG_AUDIT.md).
///         Every expected value cites its source: ARCHITECTURE §0 (R#), MATH_SPEC §, TEAM_PLAN §7, PHASES decision #.
///         The only field allowed to be empty is `owner` (the Safe 2-of-3, HUMAN_CHECKLIST #3), and only while its
///         `_owner` note still says VERIFY. No RPC needed: this reads the file, not the chain.
contract Config143Test is Test {
    using stdJson for string;

    Config143Reader r;
    string cfg;

    function setUp() public {
        r = new Config143Reader();
        r.load();
        cfg = r.raw();
    }

    // ---------------------------------------------------------------- addresses

    function test_tokens_matchResearch() public view {
        assertEq(r.optAddress(".tokens.AUSD"), 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a, "AUSD (R9)");
        assertEq(cfg.readUint(".tokens.AUSD_decimals"), 6, "AUSD 6 dp (R9)");
        assertEq(r.optAddress(".tokens.WMON"), 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A, "WMON (R10)");
        assertEq(r.optAddress(".tokens.USDC"), 0x754704Bc059F8C67012fEd69BC8A327a5aafb603, "USDC (R10b)");
        assertEq(cfg.readUint(".tokens.USDC_decimals"), 6, "USDC 6 dp (R10b)");
    }

    function test_oracleSources_matchResearch() public view {
        assertEq(r.optAddress(".pyth.contract"), 0x2880aB155794e7179c9eE2e38200202908C17B43, "Pyth (R12)");
        assertEq(
            cfg.readBytes32(".pyth.monUsdFeedId"),
            0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1,
            "Pyth MON/USD id (R12)"
        );
        assertEq(cfg.readInt(".pyth.expo"), -8, "Pyth expo (R12)");
        assertEq(r.optAddress(".chainlink.monUsd"), 0xBcD78f76005B7515837af6b50c7C52BCf73822fb, "CL MON/USD (R11)");
        assertEq(r.optAddress(".chainlink.ausdUsd"), 0xE20751C7B5867bCBef815ffc1b284c3f412a9e13, "CL AUSD/USD (R11)");
        assertEq(r.optAddress(".chainlink.ethUsd"), 0x1B1414782B859871781bA3E4B0979b9ca57A0A04, "CL ETH/USD (R11)");
        assertEq(cfg.readUint(".chainlink.decimals"), 8, "CL 8 dp (R11)");
    }

    function test_kuruAndCre_matchResearch() public view {
        assertEq(r.optAddress(".kuru.router"), 0xd651346d7c789536ebf06dc72aE3C8502cd695CC, "router (R16)");
        assertEq(r.optAddress(".kuru.marginAccount"), 0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5, "margin (R16)");
        assertEq(r.optAddress(".kuru.flowEntrypoint"), 0xb3e6778480b2E488385E8205eA05E20060B813cb, "flow entry (R16)");
        assertEq(r.optAddress(".kuru.flowRouter"), 0x0d3a1BE29E9dEd63c7a5678b31e847D68F71FFa2, "flow router (R16)");
        assertEq(r.optAddress(".kuru.monUsdcMarket"), 0x065C9d28E428A0db40191a54d33d5b7c71a9C394, "MON/USDC (R19b)");
        assertEq(r.optAddress(".kuru.monAusdMarket"), 0x131A2e70A5b31a517A74b8c567149bc294470Da9, "MON/AUSD (R19)");
        assertEq(r.optAddress(".cre.keystoneForwarder"), 0x76c9cf548b4179F8901cda1f8623568b58215E62, "CRE fwd (R14)");
        assertEq(r.optAddress(".cre.keystoneForwarderSim"), 0x9eF6468C5f37b976E57d52054c693269479A784d, "CRE sim (R14)");
    }

    /// @dev "No zero addresses except fields explicitly marked as pending a human input."
    function test_noZeroAddress_exceptPendingOwner() public view {
        string[15] memory keys = [
            ".tokens.AUSD",
            ".tokens.WMON",
            ".tokens.USDC",
            ".pyth.contract",
            ".chainlink.monUsd",
            ".chainlink.ausdUsd",
            ".chainlink.ethUsd",
            ".kuru.router",
            ".kuru.marginAccount",
            ".kuru.flowEntrypoint",
            ".kuru.flowRouter",
            ".kuru.monUsdcMarket",
            ".kuru.monAusdMarket",
            ".cre.keystoneForwarder",
            ".cre.keystoneForwarderSim"
        ];
        for (uint256 i; i < keys.length; ++i) {
            assertTrue(r.optAddress(keys[i]) != address(0), keys[i]);
        }
        // owner: the Safe 2-of-3 (HUMAN_CHECKLIST #3). Null is allowed only while it is explicitly marked pending.
        address owner = r.optAddress(".owner");
        if (owner == address(0)) {
            assertTrue(vm.contains(cfg.readString("._owner"), "VERIFY"), "owner null but not marked VERIFY");
            assertFalse(cfg.readBoolOr(".ownerIsDeployer", false), "mainnet must never fall back to the deployer");
        } else {
            // set: never the deployer fallback; the Safe itself (threshold 2, 3 owners) is checked onchain by P5 preflight
            assertFalse(cfg.readBoolOr(".ownerIsDeployer", false));
        }
    }

    function test_noTestOnlyKeys() public view {
        assertEq(cfg.readUint(".chainId"), 143);
        assertFalse(cfg.readBoolOr(".demoMarket.enabled", false), "no demo market on 143");
        assertFalse(vm.keyExistsJson(cfg, ".params.oracle.keeperFedMaxStalenessSec"), "no keeper-fed oracle on 143");
    }

    // ---------------------------------------------------------------- perp

    function test_perp_riskAndCaps() public view {
        RiskParams memory p = r.risk();
        // MATH_SPEC §3.3
        assertEq(p.imr, 0.2e18, "imr 20%");
        assertEq(p.mmr, 0.1e18, "mmr 10%");
        assertLe(p.mmr, p.imr, "mmr <= imr");
        assertEq(p.takerFee, 0.0005e18, "taker 5 bps");
        assertEq(p.makerFee, -0.0001e18, "maker -1 bp");
        assertLt(uint256(-p.makerFee), p.takerFee, "rebate < taker fee");
        assertEq(p.liqPenalty, 0.01e18, "liqPenalty 1%");
        assertEq(p.keeperShare, 0.5e18, "keeperShare 50%");
        // launch caps: MATH_SPEC §3.3 + TEAM_PLAN §7 (250k MON/side OI, 25k MON position)
        assertGt(p.maxOpenInterest, 0);
        assertGt(p.maxPositionSize, 0);
        assertEq(p.maxOpenInterest, 250_000e18, "OI cap 250k MON");
        assertEq(p.maxPositionSize, 25_000e18, "position cap 25k MON");
        assertLe(p.maxPositionSize, p.maxOpenInterest);
        // ARCHITECTURE §0.1: tick 1e-6 AUSD, lot 100 MON
        assertEq(vm.parseUint(cfg.readString(".params.perp.tickSizeWad")), 1e12, "tick 1e-6");
        assertEq(vm.parseUint(cfg.readString(".params.perp.lotSizeWad")), 100e18, "lot 100 MON");
    }

    function test_perp_funding() public view {
        FundingParams memory f = r.funding();
        // MATH_SPEC §1.3
        assertEq(f.alpha, 0.002e18, "alpha");
        assertEq(f.interestRate, 3_472_222_222, "i = 10.95% APR per s");
        assertEq(f.rateCap, 555_555_555_556, "cap 0.2%/h per s");
        assertEq(f.maxRateChangePerBlock, 555_555_556, "delta = cap/1000");
        assertEq(f.blockTimeMs, 300, "300 ms (R3, MIP-12)");
        assertEq(f.premiumBandWad, 0.05e18, "premium band 5%");
        assertLe(uint256(f.interestRate), f.rateCap);
    }

    // ---------------------------------------------------------------- oracle

    function test_oracle_asDecided() public view {
        assertEq(cfg.readString(".params.oracle.kind"), "pyth", "PythChainlinkOracleAdapter (R11/R12)");
        uint256 stale = cfg.readUint(".params.oracle.maxStalenessSec");
        uint256 dev = vm.parseUint(cfg.readString(".params.oracle.maxDeviationWad"));
        uint256 guard = cfg.readUint(".params.oracle.chainlinkGuardStalenessSec");
        // decided: 60 s (no Pyth API key, R24) and 3% (B, 72 h sample) — ws-03j-oracle-params, review A-16
        assertEq(stale, 60, "maxStalenessSec 60");
        assertEq(dev, 0.03e18, "maxDeviationWad 3%");
        assertEq(guard, 3600, "Chainlink guard 1 h (R11)");
        // the adapter's constructor bounds, so the deploy cannot revert on them
        assertGe(stale, 1); // PythChainlinkOracleAdapter.MIN_STALENESS
        assertLe(stale, 1 hours); // MAX_STALENESS
        assertGt(dev, 0);
        assertLe(dev, 0.1e18); // MAX_DEVIATION
    }

    // ---------------------------------------------------------------- vault

    function test_vault_idleLaunch() public view {
        VaultParams memory v = r.vault();
        assertEq(v.depositCap, 1200e6, "1,200 AUSD (PHASES decision 12)");
        assertEq(v.skewCapacity, 0, "idle launch: skewCapacity 0 (PHASES decision 17, A-01)");
        // MATH_SPEC §5.3 defaults
        assertEq(v.leverage, 1.5e18, "L 1.5");
        assertEq(v.driftBand, 0.02e18, "theta 2%");
        assertEq(v.targetMarginRatio, 0.6e18, "target margin 60%");
        assertEq(v.minMarginRatio, 0.25e18, "min margin 25%");
        assertLt(v.minMarginRatio, v.targetMarginRatio);
        assertEq(v.entryHorizonSec, 7 days, "entry horizon 7 d");
        assertEq(v.exitHorizonSec, 3 days, "exit horizon 3 d");
        assertEq(v.roundTripFee, 0.0015e18, "c = 0.15%");
        assertEq(v.maxSlippage, 0.005e18, "max slippage 0.5%");
        assertEq(v.idleBuffer, 0.05e18, "idle buffer 5%");
        assertEq(v.maxSliceAssets, 2500e6, "slice 2,500 AUSD");
    }

    // ---------------------------------------------------------------- swaps

    function test_swap_paramsAndMaturity() public view {
        SwapParams memory s = r.swap();
        // MATH_SPEC §6.4 / §6.5
        assertEq(s.aprMoveBuffer, 0.05e18, "aprMoveBuffer 5 pts");
        assertEq(s.liqHorizonSec, 86_400, "liqHorizon 24 h");
        assertEq(s.imMultiplier, 1.5e18, "IM = 1.5 MM");
        assertEq(s.takerFeeApr, 0.002e18, "taker 0.2% APR");
        assertEq(s.makerFeeApr, -0.0005e18, "maker -0.05% APR");
        assertEq(s.liqPenalty, 0.2e18, "liqPenalty 20% of MM (INTERFACES SwapParams)");
        assertEq(s.keeperShare, 0.5e18);
        // TEAM_PLAN §7: swaps 2M MON notional/side; position cap = 10% of it (A's choice, noted in the config)
        assertGt(s.maxOpenInterest, 0);
        assertGt(s.maxPositionSize, 0);
        assertEq(s.maxOpenInterest, 2_000_000e18, "swap OI cap 2M MON");
        assertEq(s.maxPositionSize, 200_000e18, "swap position cap 200k MON");
        assertLe(s.maxPositionSize, s.maxOpenInterest);
        // MATH_SPEC §6.1: maturity = listing + 30 d, computed by DeployPulse (so `maturity` stays null)
        assertEq(r.optUint(".params.swap.maturity"), 0, "maturity set at deploy");
        assertEq(r.optUint(".params.swap.maturityInSec"), 30 days, "30-day contract");
        assertEq(vm.parseUint(cfg.readString(".params.swap.tickSizeWad")), 1e14, "1 bp APR");
        assertEq(vm.parseUint(cfg.readString(".params.swap.lotSizeWad")), 1000e18, "1,000 MON");
    }

    /// @dev Decision 18 (B-01): the mark bound lives in code, not in the config. Pinned here so a config audit sees a
    ///      change. The constant getters read neither storage nor immutables, so the etched runtime code is enough.
    ///      The keeper's poke cadence (`SWAP_MARK_POKE_EVERY_BLOCKS`, default 20) is covered by keepers/ vitest.
    function test_swapMarkBound_decision18() public {
        address probe = makeAddr("fundingSwapMarketCode");
        vm.etch(probe, vm.getDeployedCode("FundingSwapMarket.sol:FundingSwapMarket"));
        FundingSwapMarket m = FundingSwapMarket(probe);
        assertEq(m.MARK_MAX_STEP_PER_BLOCK(), 0.005e18, "0.5 APR points per elapsed block (MATH_SPEC 6.3)");
        assertEq(m.MARK_MAX_ELAPSED_BLOCKS(), 20, "cap 20 blocks (MATH_SPEC 6.3)");
    }
}
