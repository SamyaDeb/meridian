# Security findings: status after Phase 1 (Mon 5 Oct 2026)

Branch `ws-00i-phase1-merge` (nothing pushed). Reviews: [review-A.md](review-A.md) (A on B's contracts), [review-B.md](review-B.md) (B on A's contracts).

## Highs (and B-02)

| ID | Sev | Status | Fix (commit) | Tests proving it |
|---|---|---|---|---|
| **A-01** vault withdraw / forced-exit route | High | **Mitigated at launch, not closed.** Idle launch (`skewCapacity = 0` in `config/143.json`): the hedge target is 0, so no keeper call can hedge and every redemption is served from idle AUSD up to the 1,200 AUSD cap. CR-010 is **not applied** (estimate 1–1.5 days, frozen interface, freeze Thu 8 Oct 18:00). PHASES decision 17. | `62e7c12` | `test/unit/PulseVaultIdleLaunch.t.sol`: `test_idle_noCapacityNoHedgeTarget`, `test_idle_keeperCannotHedge`, `test_idle_depositsToCapAreFullyRedeemable`, `test_idle_maxWithdrawServedFromIdle`, `test_idle_safeCanEnableHedgeLater`; fuzz `test/fuzz/PulseVaultIdleLaunch.fuzz.t.sol: testFuzz_idle_everyClaimCoveredByIdle`. The original failure (`SlippageExceeded` on a hedged vault with a route-only hedger) is kept as `test_A01_redeemBeyondIdle_worksWithRouteOnlyHedger` and `test_A01_forcedExit_worksWithRouteOnlyHedger` in `test/review/ReviewA.t.sol`, skipped unless `REVIEW_A01_OPEN=true` (they still fail with it, which is the finding). They are CR-010's acceptance tests. |
| **B-01** swap `markApr` atomic manipulation | High | **Closed.** Per-block bound on the mark (first touch fixes the mark for the block, ≤ 0.5 APR pt per elapsed block capped at 20 blocks, a same-block trade is not an input). PHASES decision 18, MATH_SPEC §6.3. Keeper poke so a genuine move still converges in a quiet market: `be3a5e0`. | `3d5b898` | PoC `test/security/ReviewB.t.sol: test_B01_swapMarkAtomicManipulationLiquidatesHealthyAccount`: **before** the fix (`REVIEW_B_POC=true`, unfixed code) it fails: markApr +10.94% → −38.00% in one transaction, alice equity 299.4 → 182.7 AUSD < MM 187.0 (liquidatable). **After**: passes, markApr and equity unchanged, MM 152.0. It now runs always (no gate). Bound tests `test/unit/FundingSwapMark.t.sol` (`test_mark_fixedWithinBlock`, `test_mark_nextBlockMovesAtMostOneStep`, `test_mark_idleMoveCapped`, `test_mark_oneRefreshDoesNotLiquidateHealthyAccount`, `test_mark_touchStoresBoundedMark`), fuzz `test/fuzz/FundingSwapMark.fuzz.t.sol: testFuzz_markMoveBoundedByElapsedBlocks`. |
| **B-02** swap reduction can grow \|K\| | Medium | **Closed.** A voluntary reduction needs equity ≥ 0 and `slack_after ≥ min(0, slack_before)` (slack = equity − MM). PHASES decision 19, MATH_SPEC §6.4. | `bbe16b5` | PoC `test_B02_swapReductionAtOffMarketAprLeavesAccountBelowMM`: **before** (`REVIEW_B_POC=true`, fix stashed) it fails: alice closes at −99.99% APR and is left with equity 34.5 < MM 79.4 AUSD, and −18.4 AUSD (bad debt) after a +20% index move. **After**: the close is refused; it runs always. Unit `test/unit/FundingSwapReduction.t.sol` (`test_reduction_offMarketCloseCreatingShortfallReverts` = the new revert path, `test_reduction_closeAtMarketAllowed`, `test_reduction_partialCloseAtMarketAllowed`, `test_reduction_shortfallAccountCanReduceWhenItImproves`), fuzz `test/fuzz/FundingSwapReduction.fuzz.t.sol: testFuzz_reductionNeverCreatesOrWorsensShortfall` (any close price −99.99%…+200%, any size). |

## Other findings touched in Phase 1

| ID | Sev | Status | Commit | Test |
|---|---|---|---|---|
| A-02 stray spot bricks the rule path | Medium | Fixed | `7dd2bd5` | `test_A02_wmonDonation_doesNotBlockRuleBasedEntry`, `test_A02_wmonDonation_exitHedgeClearsSpot` (PulseVault.t.sol, ReviewA.t.sol) |
| A-03 MarginLow with dust idle | Medium | Fixed | `7dd2bd5` | `test_A03_dustIdle_marginLowStillMakesProgress` |
| A-04 target ignores `maxPositionSize` | Medium | Fixed (clamp is in, so `depositCap` stays 1,200 AUSD) | `7dd2bd5` | `test_A04_launchCaps_vaultDeploysUpToPositionCap` |
| A-05 / A-06 signed perp collateral, deposits closed when insolvent | Low | Fixed | `7dd2bd5` | `test_A05_A06_negativePerpCollateral_navAndDepositsClosed` |
| A-10 testnet oracle far-future publish time | Low | Fixed | `7dd2bd5` | `OracleTestnetKeeper.t.sol: test_push_rejectsFarFuturePublishTime` |
| A-16 `maxDeviationWad` unset | Info | Closed: 3% (+ `maxStalenessSec` 60 s) in `config/143.json` | `7a8d7ed`, `62e7c12` | `OracleAdapterFork.t.sol: test_fork_chosenParams_worstObservedDeviation` (needs RPC), `DeployPulseMainnet.t.sol` |
| A-17 unused bool parameter | Info | Fixed | `7dd2bd5` | compile |

## Still open

| ID | Sev | Note |
|---|---|---|
| A-01 (hedged mode) | High for a hedged mainnet vault | Needs CR-010 (interface v1.6) or a verified live direct market; post-launch |
| A-07 … A-09, A-11 … A-13 | Low / Info | As in review-A.md (A-09 cooldown and A-11 are vault-hedging items, moot while idle) |
| B-03 … B-15 | Low / Info | As in review-B.md (not re-triaged in Phase 1) |
