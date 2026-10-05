# Mainnet config audit: `contracts/script/config/143.json`

Phase 3 P1, 5 Oct 2026, branch `ws-00j-mainnet-config-audit` (from `main` @ `a619894`). Auditor: Phase 3 loop session.
Every field is checked against `docs/ARCHITECTURE.md §0` (R#), `docs/MATH_SPEC.md`, `docs/TEAM_PLAN.md §7` and the PHASES decisions (11–19). The invariants are enforced by `contracts/test/script/Config143.t.sol` (11 tests, no RPC needed). That test reads the file with the same parsers `DeployPulse` uses (`DeployBase._riskParams`, `_fundingParams`, `_swapParams`, `_vaultParams`, `_optAddress`), so the test sees the values the deploy will see.

Status: ✅ sourced and matching · ⚠ VERIFY or a stale note · ❌ missing (launch blocker).

## Summary
- **1 ❌**: `owner` (the Safe 2-of-3) is null. It needs a human (HUMAN_CHECKLIST #3). The deploy refuses to run on 143 without it (`"VERIFY: owner missing in config"`), so it can't be forgotten.
- **4 ⚠** (none blocking): `maxStalenessSec` 60 is the no-API-key value, and it changes if a Pyth key arrives (#6). The `kuru.monAusdMarket` book is dead, which is acceptable only because the vault launches idle. Two notes are stale: the `foundry.toml` "VERIFY cancun" comment, and the fork test patching a `maxDeviationWad: null` that no longer exists.
- Every other field is ✅.

## Fields

### Identity and ownership
| Field | Value | Source | Status | Action |
|---|---|---|---|---|
| `chainId` | 143 | R1; `cast chain-id --rpc-url $MONAD_RPC_URL` = 143 (5 Oct) | ✅ | — |
| `owner` | `null` (`_owner`: "VERIFY: Safe 2-of-3 address once created") | HUMAN_CHECKLIST #3 ⏳ | ❌ | **BLOCKED (HUMAN_CHECKLIST #3).** B creates the Safe. Then A checks onchain that `getThreshold()` = 2 and `getOwners()` = the 3 founders, and writes the address. The P2 rehearsal uses a labelled **FORK STAND-IN — not the real Safe**. The test allows null only while `_owner` says VERIFY and `ownerIsDeployer` is absent |
| `ownerIsDeployer` | absent | `DeployPulse` refuses it on 143 | ✅ | test asserts it stays absent |

### Tokens
| Field | Value | Source | Status | Action |
|---|---|---|---|---|
| `tokens.AUSD` | `0x00000000eFE3…9012a` | R9 (onchain + fork permit test) | ✅ | — |
| `tokens.AUSD_decimals` | 6 | R9; CLAUDE.md §2 "6 dp (verified onchain)" | ✅ | — |
| `tokens.WMON` | `0x3bd359C1…5433A` | R10 | ✅ | — |
| `tokens.USDC` / `USDC_decimals` | `0x754704Bc…fb603` / 6 | R10b | ✅ | informational (Kuru quote token); the deploy doesn't read it |

### Oracle sources
| Field | Value | Source | Status | Action |
|---|---|---|---|---|
| `pyth.contract` | `0x2880aB15…17B43` | R12 | ✅ | — |
| `pyth.monUsdFeedId` | `0x31491744…686cd1` | R12 | ✅ | — |
| `pyth.expo` | −8 | R12 | ✅ | — |
| `chainlink.monUsd` | `0xBcD78f76…822fb` | R11 | ✅ | used as the secondary guard |
| `chainlink.ausdUsd`, `chainlink.ethUsd` | `0xE20751C7…a9e13`, `0x1B141478…A0A04` | R11 | ✅ | not read by the deploy (AUSD depeg monitoring, ARCHITECTURE §5) |
| `chainlink.decimals` | 8 | R11 | ✅ | — |

### Kuru and CRE
| Field | Value | Source | Status | Action |
|---|---|---|---|---|
| `kuru.router` / `marginAccount` | `0xd651346d…695CC` / `0x2A68ba18…E90c5` | R16 | ✅ | not read by the deploy |
| `kuru.flowEntrypoint` | `0xb3e67784…813cb` | R16 | ✅ | `KuruHedger` constructor; null is refused on 143 |
| `kuru.flowRouter` | `0x0d3a1BE2…1FFa2` | R16 | ✅ | — |
| `kuru.monUsdcMarket` | `0x065c9d28…c394` | R19b | ✅ | — |
| `kuru.monAusdMarket` | `0x131a2e70…0da9` | R19: the market **exists but is dead** | ⚠ | Accepted for launch **only because the vault is idle** (decision 17, review A-01): with `skewCapacity = 0` no path reaches this market. Before the Safe raises `skewCapacity`, CR-010 must be applied, or a live direct market verified on a fork |
| `cre.keystoneForwarder` / `Sim` | `0x76c9cf54…5E62` / `0x9eF6468C…784d` | R14 | ✅ | CRE was dropped (Phase 4), so `DEPLOY_CRE_RECEIVER` stays off |

### Perp `params.perp` (MON-PERP)
| Field | Value | Source | Status |
|---|---|---|---|
| `symbol` | MON-PERP | ARCHITECTURE §0.1 "Keep MON-PERP" | ✅ |
| `tickSizeWad` | 1e12 (1e-6 AUSD) | ARCHITECTURE §0.1 | ✅ |
| `lotSizeWad` | 100e18 (100 MON) | ARCHITECTURE §0.1 | ✅ |
| `risk.imr` / `mmr` | 0.20 / 0.10 | MATH_SPEC §3.3 (5x, R23) | ✅ |
| `risk.takerFee` / `makerFee` | 5 bps / −1 bp | MATH_SPEC §3.3 | ✅ |
| `risk.liqPenalty` / `keeperShare` | 1% / 50% | MATH_SPEC §3.3 | ✅ |
| `risk.maxOpenInterest` | 250,000 MON per side | MATH_SPEC §3.3, TEAM_PLAN §7 launch cap | ✅ cap > 0 |
| `risk.maxPositionSize` | 25,000 MON | MATH_SPEC §3.3, TEAM_PLAN §7; decision 12 sizes the vault cap from it | ✅ cap > 0, ≤ OI cap |
| `funding.alpha` | 0.002 | MATH_SPEC §1.3 | ✅ |
| `funding.interestRate` | 3,472,222,222 (10.95% APR per s) | MATH_SPEC §1.3, R23 | ✅ |
| `funding.rateCap` | 555,555,555,556 (0.2%/h) | MATH_SPEC §1.3 | ✅ |
| `funding.maxRateChangePerBlock` | 555,555,556 (cap/1000) | MATH_SPEC §1.3 | ✅ |
| `funding.blockTimeMs` | 300 | MATH_SPEC §1.3, R3 (MIP-12) | ✅ |
| `funding.premiumBandWad` | 0.05 | MATH_SPEC §1.3 | ✅ |

### Oracle parameters `params.oracle`
| Field | Value | Source | Status | Action |
|---|---|---|---|---|
| `kind` | `"pyth"` | R11/R12; `DeployPulse` reads it; `keeper-fed` is refused on 143 by `TestnetKeeperOracle`'s constructor | ✅ | — |
| `maxStalenessSec` | 60 | R24 (no Pyth API key ⇒ sponsored pushes); B's 72 h sample: sponsored age p99 50 s, max 66 s (`ws-03j-oracle-params`, `7a8d7ed`) | ⚠ | Correct **for the no-key launch**. If the Pyth key arrives (HUMAN_CHECKLIST #6) and the keeper pushes Hermes updates, B decides whether to drop to 10 s. That change goes through the Safe (`adapter.setOracleParams`) or the config **and** `Config143.t.sol` together, so the test fails until both agree |
| `maxDeviationWad` | 0.03 (3%) | B, 72 h / 8,581 blocks: p99 0.50%, p99.9 1.02%, max 1.42%; constructor bound (0, 10%] (review A-16 closed) | ✅ | — |
| `chainlinkGuardStalenessSec` | 3600 | R11 ("staleness for guard: 1 h") | ✅ | constructor bound ≤ 1 h holds |

### Vault `params.vault` (decisions 12, 17)
| Field | Value | Source | Status |
|---|---|---|---|
| `depositCap` | 1,200,000,000 (1,200 AUSD, 6 dp) | PHASES decision 12 (option C); A-04 fixed, so the 1,000 AUSD fallback isn't needed | ✅ |
| `skewCapacity` | 0 | PHASES decision 17 (A-01 idle launch); `PulseVaultIdleLaunch.t.sol` | ✅ |
| `leverage` | 1.5 | MATH_SPEC §5.1/§5.3 | ✅ |
| `driftBand` | 0.02 | MATH_SPEC §5.3 | ✅ |
| `targetMarginRatio` / `minMarginRatio` | 0.60 / 0.25 | MATH_SPEC §5.3 | ✅ |
| `entryHorizonSec` / `exitHorizonSec` | 604,800 / 259,200 | MATH_SPEC §5.3 (7 d / 3 d) | ✅ |
| `roundTripFee` | 0.0015 | MATH_SPEC §5.3 (c ≈ 0.15%) | ✅ |
| `maxSlippage` | 0.005 | MATH_SPEC §5.3 | ✅ |
| `idleBuffer` | 0.05 | MATH_SPEC §5.3 | ✅ |
| `maxSliceAssets` | 2,500,000,000 (2,500 AUSD) | MATH_SPEC §5.3 | ✅ |

The keeper and skew-provider addresses are **not in the config**. `DeployPulse` takes them from `KEEPER_ADDRESS` / `MM_ADDRESS`, refuses either missing on 143 or equal to the deployer, and registers the MM as a skew provider (decision 11). P2 checks this on the fork.

### Funding swaps `params.swap` (decision 18)
| Field | Value | Source | Status |
|---|---|---|---|
| `maturity` | null | MATH_SPEC §6.1: set at deploy | ✅ |
| `maturityInSec` | 2,592,000 (30 d) | MATH_SPEC §6.1; `DeployPulse` computes listing block time + 30 d | ✅ |
| `tickSizeWad` / `lotSizeWad` | 1e14 (1 bp APR) / 1,000 MON | MATH_SPEC §6.1, ARCHITECTURE §7 step 11 | ✅ |
| `params.aprMoveBuffer` | 0.05 | MATH_SPEC §6.4 | ✅ |
| `params.liqHorizonSec` | 86,400 | MATH_SPEC §6.4 (24 h) | ✅ |
| `params.imMultiplier` | 1.5 | MATH_SPEC §6.4 (IM 7.87% / MM 5.24%) | ✅ |
| `params.takerFeeApr` / `makerFeeApr` | 0.2% / −0.05% APR | MATH_SPEC §6.5 | ✅ |
| `params.liqPenalty` / `keeperShare` | 0.2 of MM / 0.5 | MATH_SPEC §6.4, INTERFACES `SwapParams` (e.g. 0.2e18) | ✅ |
| `params.maxOpenInterest` | 2,000,000 MON per side | TEAM_PLAN §7 launch caps | ✅ cap > 0 |
| `params.maxPositionSize` | 200,000 MON | A's choice, noted in the file (10% of the OI cap, same ratio as the perp) | ✅ cap > 0, ≤ OI cap |
| Mark bound (code, not config) | `MARK_MAX_STEP_PER_BLOCK` 0.005e18, `MARK_MAX_ELAPSED_BLOCKS` 20 | PHASES decision 18, MATH_SPEC §6.3 | ✅ pinned by `test_swapMarkBound_decision18` |
| Mark poke (keeper env, not config) | `SWAP_MARK_POKE_EVERY_BLOCKS` default 20 | decision 18 / CR-011, `be3a5e0` | ✅ default in `keepers/ts-fallback/src/main.ts`; P4 runs it on the fork |

## Adjacent items (outside the JSON, found during the audit)
| Item | Status | Action |
|---|---|---|
| `foundry.toml` `evm_version = "cancun"` comment "VERIFY before mainnet deploy" | ⚠ stale | R8 records "Cancun opcodes supported (we compile cancun)" ✅, so the VERIFY is satisfied by R8. The comment and the README row (`⏳`) can be updated by the owner. No change here: `foundry.toml` is outside this loop's paths |
| `test/fork/DeployPulseMainnet.t.sol` patches `"maxDeviationWad": null` | ⚠ stale, harmless | The value is now the decided 3%, so `vm.replace` matches nothing and the fork test deploys with 3%. No action needed. If touched in P2, drop the line |
| Keeper/MM hot keys (`KEEPER_ADDRESS`, `MM_ADDRESS` at deploy) | ❌ human | HUMAN_CHECKLIST #4. Three keys exist in `.env` but hold 0 MON on 143, and no one has confirmed they're the mainnet hot keys |
| `chainlink.ausdUsd` depeg alert (ARCHITECTURE §5, "pause deposits if < 0.99") | — | monitoring, not config. P4/P5 check that the watcher has it |

## Evidence
```
cd contracts && forge test --match-path test/script/Config143.t.sol
  → 11 passed, 0 failed
Negative check (temporary edits, file restored, `git diff` empty):
  skewCapacity 0.8e18, depositCap 10,000 AUSD, maxStalenessSec 10
  → FAIL test_vault_idleLaunch (10000000000 != 1200000000), FAIL test_oracle_asDecided (10 != 60)
```
