# Security findings: status after Phase 1 (Mon 5 Oct 2026)

Branch `ws-00i-phase1-merge` (nothing pushed). Reviews: [review-A.md](review-A.md) (A on B's contracts), [review-B.md](review-B.md) (B on A's contracts).

## Highs (and B-02)

| ID | Sev | Status | Fix (commit) | Tests proving it |
|---|---|---|---|---|
| **A-01** vault withdraw / forced-exit route | High | **Mitigated at launch, not closed.** Idle launch (`skewCapacity = 0` in `config/143.json`): the hedge target is 0, so no keeper call can hedge and every redemption is served from idle AUSD up to the 1,200 AUSD cap. CR-010 is **not applied** (estimate 1–1.5 days, frozen interface, freeze Thu 8 Oct 18:00). PHASES decision 17. | `62e7c12` | `test/unit/MeridianVaultIdleLaunch.t.sol`: `test_idle_noCapacityNoHedgeTarget`, `test_idle_keeperCannotHedge`, `test_idle_depositsToCapAreFullyRedeemable`, `test_idle_maxWithdrawServedFromIdle`, `test_idle_safeCanEnableHedgeLater`; fuzz `test/fuzz/MeridianVaultIdleLaunch.fuzz.t.sol: testFuzz_idle_everyClaimCoveredByIdle`. The original failure (`SlippageExceeded` on a hedged vault with a route-only hedger) is kept as `test_A01_redeemBeyondIdle_worksWithRouteOnlyHedger` and `test_A01_forcedExit_worksWithRouteOnlyHedger` in `test/review/ReviewA.t.sol`, skipped unless `REVIEW_A01_OPEN=true` (they still fail with it, which is the finding). They are CR-010's acceptance tests. |
| **B-01** swap `markApr` atomic manipulation | High | **Closed.** Per-block bound on the mark (first touch fixes the mark for the block, ≤ 0.5 APR pt per elapsed block capped at 20 blocks, a same-block trade is not an input). PHASES decision 18, MATH_SPEC §6.3. Keeper poke so a genuine move still converges in a quiet market: `be3a5e0`. | `3d5b898` | PoC `test/security/ReviewB.t.sol: test_B01_swapMarkAtomicManipulationLiquidatesHealthyAccount`: **before** the fix (`REVIEW_B_POC=true`, unfixed code) it fails: markApr +10.94% → −38.00% in one transaction, alice equity 299.4 → 182.7 AUSD < MM 187.0 (liquidatable). **After**: passes, markApr and equity unchanged, MM 152.0. It now runs always (no gate). Bound tests `test/unit/FundingSwapMark.t.sol` (`test_mark_fixedWithinBlock`, `test_mark_nextBlockMovesAtMostOneStep`, `test_mark_idleMoveCapped`, `test_mark_oneRefreshDoesNotLiquidateHealthyAccount`, `test_mark_touchStoresBoundedMark`), fuzz `test/fuzz/FundingSwapMark.fuzz.t.sol: testFuzz_markMoveBoundedByElapsedBlocks`. |
| **B-02** swap reduction can grow \|K\| | Medium | **Closed.** A voluntary reduction needs equity ≥ 0 and `slack_after ≥ min(0, slack_before)` (slack = equity − MM). PHASES decision 19, MATH_SPEC §6.4. | `bbe16b5` | PoC `test_B02_swapReductionAtOffMarketAprLeavesAccountBelowMM`: **before** (`REVIEW_B_POC=true`, fix stashed) it fails: alice closes at −99.99% APR and is left with equity 34.5 < MM 79.4 AUSD, and −18.4 AUSD (bad debt) after a +20% index move. **After**: the close is refused; it runs always. Unit `test/unit/FundingSwapReduction.t.sol` (`test_reduction_offMarketCloseCreatingShortfallReverts` = the new revert path, `test_reduction_closeAtMarketAllowed`, `test_reduction_partialCloseAtMarketAllowed`, `test_reduction_shortfallAccountCanReduceWhenItImproves`), fuzz `test/fuzz/FundingSwapReduction.fuzz.t.sol: testFuzz_reductionNeverCreatesOrWorsensShortfall` (any close price −99.99%…+200%, any size). |

## Other findings touched in Phase 1

| ID | Sev | Status | Commit | Test |
|---|---|---|---|---|
| A-02 stray spot bricks the rule path | Medium | Fixed | `7dd2bd5` | `test_A02_wmonDonation_doesNotBlockRuleBasedEntry`, `test_A02_wmonDonation_exitHedgeClearsSpot` (MeridianVault.t.sol, ReviewA.t.sol) |
| A-03 MarginLow with dust idle | Medium | Fixed | `7dd2bd5` | `test_A03_dustIdle_marginLowStillMakesProgress` |
| A-04 target ignores `maxPositionSize` | Medium | Fixed (clamp is in, so `depositCap` stays 1,200 AUSD) | `7dd2bd5` | `test_A04_launchCaps_vaultDeploysUpToPositionCap` |
| A-05 / A-06 signed perp collateral, deposits closed when insolvent | Low | Fixed | `7dd2bd5` | `test_A05_A06_negativePerpCollateral_navAndDepositsClosed` |
| A-10 testnet oracle far-future publish time | Low | Fixed | `7dd2bd5` | `OracleTestnetKeeper.t.sol: test_push_rejectsFarFuturePublishTime` |
| A-16 `maxDeviationWad` unset | Info | Closed: 3% (+ `maxStalenessSec` 60 s) in `config/143.json` | `7a8d7ed`, `62e7c12` | `OracleAdapterFork.t.sol: test_fork_chosenParams_worstObservedDeviation` (needs RPC), `DeployMeridianMainnet.t.sol` |
| A-17 unused bool parameter | Info | Fixed | `7dd2bd5` | compile |

## Vault v2 (CR-014, HARDENING_PLAN P5, 7 Oct 2026; branch `ws-04c-vault-v2`, not pushed)

| ID | Sev | Status | Fix (commit) | Tests proving it |
|---|---|---|---|---|
| **A-01** vault withdraw / forced-exit route | High | **Closed** (hedged mode). Withdrawals beyond idle are a request the keeper fulfils **with a route**; the sync path is idle-only and never unwinds; the keeper has `exitHedgeWithRoute`; the owner/Safe has `emergencyUnwind(maxBase, route)`; the 143 hedger is deployed Flow-only (`kuruMarket = 0`) so an empty route fails loudly. | `fe58160` (CR-014), `f0922a4`, `790f2a4` (DeployVaultV2) | **Fork proof (real Kuru Flow routes, 143 fork @ 111,116,022):** `test/fork/VaultV2Fork.t.sol: test_fork_A01_hedgedVault_requestFulfilClaim_realFlowRoutes` (hedged through a real route; bob's 400 AUSD beyond 241.55 idle fulfilled with a real sell route, paid 399.27) and `test_fork_A01_emergencyUnwind_realFlowRoute` (flat in one call). Ungated acceptance tests `test/review/ReviewA.t.sol`: `test_A01_requestFulfilClaim_beyondIdle_withRoute`, `test_A01_syncRedeemBeyondIdle_isCappedNotReverting`, `test_A01_forcedExit_worksWithRouteOnlyHedger`, `test_A01_emergencyUnwind_flattensHedgedVault` (were red: `NothingToDo` / not capped). |
| A-07 tiny redeem unwinds everything | Low | **Closed.** The sync path can't unwind; `fulfillRedeems` refuses (`SlippageExceeded`) when perp equity ≤ 0 instead of `f = WAD`, and never socializes a cost ≥ the batch payout. | `f0922a4` | `MeridianVaultQueue.t.sol: test_fulfil_perpEquityNonPositive_revertsNoFullUnwind`, `test_fulfil_beyondIdle_unwindsAndChargesBatch`; fuzz `testFuzz_fulfilMovesNonRedeemersWithinSlippage` |
| A-09 compromised keeper repeats forced calls | Low | **Mitigated.** ≥ 10 blocks (`MIN_FORCED_INTERVAL_BLOCKS`) between a rebalance and any forced keeper call; revoke via `setKeeper` (RUNBOOK §9b). A per-hour slippage budget is not implemented. | `f0922a4` | `test_cooldown_forcedPaths`, `test_emergencyUnwind_partialThenFull_noCooldown` |
| A-11 max* may revert | Info | **Closed.** `maxWithdraw` / `maxRedeem` are capped at idleFree and the sync path never unwinds, so they never revert inside the max. | `f0922a4` | `test_sync_hedged_maxCappedAtIdleFree`, `test_A01_syncRedeemBeyondIdle_isCappedNotReverting`, fuzz `testFuzz_syncMaxNeverRevertsNorSpendsClaimable`, invariant `invariant_syncPathIdleOnly` |
| A-13 route amount vs onchain amount | Info | Mitigated for fulfils: `previewFulfill(ids)` gives the exact base the batch sells (the fork test asserts it equals the actual call); the keeper quotes it minus a haircut and re-quotes on failure. | `fe58160`, `3850348` | `test_fork_vaultV2_probeAmounts`, `test_fulfil_beyondIdle_unwindsAndChargesBatch` |

## Still open

| ID | Sev | Note |
|---|---|---|
| A-08, A-12 | Low / Info | As in review-A.md (A-08 skew-rule griefing is keeper-side; A-12 oracle stale / empty book ⇒ only idle is withdrawable, now also the queue waits) |
| B-03 … B-15 | Low / Info | As in review-B.md (not re-triaged in Phase 1) |
