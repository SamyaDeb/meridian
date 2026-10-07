# PROOF: every Meridian claim with its evidence

*7 Oct 2026, branch `ws-00s-submission`. Network for every onchain item: **Monad testnet 10143** unless it says "mainnet fork" (an anvil fork of chain 143, nothing broadcast to 143). Commands run from `contracts/` unless noted. Claims are limited to PRD §7.1 ✅; anything without evidence below is not claimed.*

**Run the evidence yourself:** `forge test --no-match-path 'test/fork/*'` → **499 passed / 0 failed / 0 skipped** (66 suites). Fork suite: `set -a; source ../.env; set +a; forge test --match-path 'test/fork/*'` → **10 passed / 0 failed / 1 skipped** (`test_fork_flowRoute` needs a `KURU_FLOW_ROUTE`; without `MONAD_RPC_URL` every fork test reports SKIPPED, never a silent pass). TypeScript (`pnpm -r test`): app 374, keepers/ts-fallback 157, mm-bot 84, indexer 83, mfi 62, bench 24, keepers/rpc 16, all passed.

## 1. Per-block funding on a fully onchain order book
| Claim | Evidence |
|---|---|
| Funding accrues for every block through O(1) cumulative indices; a touch catches up all elapsed blocks in one step | MATH_SPEC §1; `test/unit/Funding.t.sol` (worked examples A/B, clamps, sign), `test/fuzz/Funding.fuzz.t.sol`; `test/unit/ClearingHouseGas.t.sol` (touch cost flat in the number of positions) |
| The per-block update is cheap: CH-own first touch **29,452** gas (< 30,000), **29,867** with the mark bound active, checkpoint block **30,168** (< 40,000), later touch same tx **1,528** | `forge test --match-contract RealEngineGasBench` → `contracts/bench-out/real_engine_gas.csv` (asserted ceilings); `docs/outputs/BENCHMARKS.md` B2 |
| Matching is onchain: place + cancel **96,484**, replace **69,174** (Foundry, Cancun schedule; < 100,000 target) | same bench; on 10143 the billed limit for the same ops is in BENCHMARKS.md B1 (Monad bills the limit; see §8) |
| On testnet, funding is updated at least every 20 blocks with no traffic (keeper poke) and on every trade | keeper `src/decide.ts shouldPokeFunding` + `test/decide.test.ts`; testnet: `FundingUpdated` logs of CH `0x1F90…a6eA`, e.g. 25 updates in blocks 68,785,172–68,785,571 during the P7 bench window |
| The app shows the rate as it moves | `app/src/components/FundingTicker.tsx` reads the CH (`pnpm --filter @meridian/app test`, 374) |

## 2. Monad's first public funding-rate oracle
| Claim | Evidence |
|---|---|
| Any contract can read the realized funding rate over any window: `averageFundingRate(blocksAgo)` = ΔF / ΔG, plus `averageFundingApr`, `observe`, `latestObservation` (IFundingRateOracle, implemented by the ClearingHouse) | `contracts/src/interfaces/IFundingRateOracle.sol`; `test/unit/ClearingHouse.t.sol`: `test_averageFundingApr_matchesEvents`, `test_averageFundingRate_zeroWindowIsCurrentRate`, `test_observe_fastPathAndSearch`, `test_observe_afterWrap`, `test_checkpoint_oncePerBucket`, `test_latestObservation_previewsAccrual` |
| It is live on testnet | `cast call 0x1F90B5Eb6D59adAe2be147b3903c7aCb4c16a6eA "averageFundingApr(uint64)(int256)" 200 --rpc-url https://testnet-rpc.monad.xyz` (returned −0.5699e18 = −57.0% APR at block ≈ 68,785,830, 7 Oct; testnet MM inventory, not a market signal) |
| The funding swap's floating leg reads the same index | `FundingSwapMarket` settles against the perp CH's F (MATH_SPEC §6); `test/unit/FundingSwapIntegration.t.sol::test_accrual_equalsFormulaFromPerpIndices` |

## 3. Mark manipulation is bounded (audit M-1, P2)
| Claim | Evidence |
|---|---|
| A one-block book manipulation can no longer liquidate a healthy account: the book-derived premium moves ≤ 10 bps per block (≤ 20 blocks of catch-up); index moves pass through | PoC `test/security/MarkManipulation.t.sol::test_M1_oneBlockManipulationDoesNotLiquidate`. **Before** (pre-P2 code): mark 0.030600 → **0.032130** (+5%, the band edge) in one block, victim liquidatable. **After:** 0.030600 → **0.030631** (+10 bps), victim not liquidatable; `test_M1_heldManipulation_needsAbout40Blocks` |
| Bound unit + fuzz | `test/unit/MarkBound.t.sol` (16), `test/fuzz/Mark.fuzz.t.sol` (8 × 50,000 runs), invariant `RealStackInvariants::invariant_markBand` |
| Same bound on the deployed contracts | `VerifyDeployment` behaviour check: mark 0.030000 → 0.030030 after one block of a +10% book, → 0.030600 after a 1,000-block gap (mainnet fork @ 111,084,897 and testnet, HARDENING_LOOP P4.4 / P4.5) |

## 4. Paused or stale markets keep makers' orders: Skip (audit M-2, CR-007)
| Claim | Evidence |
|---|---|
| A maker fill the engine can't take *right now* (paused / stale oracle) is **Skipped**: the order rests, matching stops; only a maker who can't carry the fill (margin, cap, matured) is evicted | `test/unit/MakerFillSkip.t.sol` (8, real stacks), `OrderBook.t.sol` (5 Skip tests), `FundingSwapMarket.t.sol` (`pausedSkips`, `maturedEvicts`, `marginEvicts`); invariants with skips produced: RealStack 12,467 skips / FundingSwap 4,225 / OrderBook 2,182 at 512 × 256 (HARDENING_LOOP P3) |
| On testnet | demo CH paused, reduce-only buy into the demo MM's ask ⇒ `MakerFillSkipped`, order kept: **`0x1b8cf02397610129320601d985b80014001931afd04e3309b6836bda6e62092d`** (block 68,741,854, P4) and `0x9089cab9ea1687b4da6d8ebd80406575d51082e6ade57a3fdd0fc5d715db4d47` (P6) |

## 5. Bad debt: insurance fund → protocol fees → uncovered (audit M-3, P1)
| Claim | Evidence |
|---|---|
| Fees are junior to users: bad debt draws on the IF, then accrued fees, only then stays uncovered | `test/unit/Liquidation.t.sol`: `test_liquidate_badDebt_feesAbsorbWhenInsuranceEmpty`, `test_liquidate_insuranceEmpty_feesThenSocializes`, `test_liquidate_badDebt_insurancePartialFeesCoverRest`, `test_liquidate_badDebt_collectFeesPaysOnlyRemainder`; swap cases in `FundingSwapMarket.t.sol`; fuzz `test/fuzz/BadDebt.fuzz.t.sol` (2 × 1,000; both fail against the old code) |
| Exercised by the invariant suites | `RealStackInvariants::invariant_I1_badDebtWaterfall`: 372 liquidations, 133 IF shortfalls, **128 uncovered after fees** over 4,617 run-ends (512 × 256). `FundingSwapInvariants::invariant_I9_badDebtWaterfall`: **2,719 liquidations, 139 with bad debt, 112 fee absorptions** (512 × 256, P4.3 price shocks) |

## 6. Liquidations land within blocks, and the keeper doesn't keep the risk (audit H-1, P7)
| Claim | Evidence |
|---|---|
| Testnet crash: −15% oracle update ⇒ leveraged long liquidated **4–5 blocks** after eligibility on a free-tier RPC (target ≤ 3 needs a paid RPC; locally 1 block) | `bench/out/b7_liquidation_latency.csv`: `0x565dadfd386342176e2170f9bf7e797ba2ff8778354d6ecc0e25e0053e22736b` (4 blocks, P4), `0xe1e9d13fcabaab3e2834968a302601468b3ddb14fbbd7498328fb17791b89461` (5, P6), `0x125631b20e5ca680f796ab0a177bdaaafd429cff1583780f98f501bcd89345ef` (5, P7) |
| The keeper sizes each liquidation to what it can absorb (position cap + IM) and never sends one that would revert on its own limits | `keepers/ts-fallback/src/unwind.ts liquidationHeadroom`; `test/unwind.test.ts` (20 tests, incl. a grid property against the contract's own check) |
| The keeper closes what it inherited with a reduce-only IOC within 1% of the index | P7 window, demo market: the keeper's 10,000 MON long from earlier demos unwound in **`0x67399d47f4014a23be24ba150bcbe3d556857369b2d4412e2a2b4606260a9742`** (60 lots, block 68,784,250) + **`0x684ebf9d4f6e503b7d658b5107185ea271876e2d5fa467804097c67b9a823f50`** (40 lots, 68,784,265); crash ⇒ liquidation `0x1256…45ef` (68,784,435) ⇒ automatic unwind of all 49 lots **`0x78cc42aa848669e2de60684fb5eca0fce3f8d94f9d071bf5f14cba7df77eaef6`** (68,784,442), keeper flat |

## 7. Basis vault v2 and A-01 on a mainnet fork with live Kuru Flow routes (P5–P6)
| Claim | Evidence |
|---|---|
| Withdrawals beyond idle are queued, fulfilled by the keeper **with a route**, and the batch pays its own unwind; the sync path is idle-only and never unwinds; the owner can `emergencyUnwind` | `test/unit/MeridianVaultQueue.t.sol` (19), `test/fuzz/MeridianVaultQueue.fuzz.t.sol` (4 × 1,000), `test/review/ReviewA.t.sol` A-01 acceptance tests (were red), `VaultInvariants` 6/6 at 512 × 256, 0 reverts (3,568 fulfils with an unwind over 3,078 run-ends) |
| **A-01 on a mainnet fork, exact scope:** the spot leg is real (KuruHedger, live Kuru Flow API routes, the Flow entrypoint, AUSD, WMON on mainnet state @ 111,116,022); the perp leg is our CH/OB deployed on the fork with our MM quotes; the index is pinned to the Kuru MON/USDC mid (0.028762), not Pyth; funding r̄ is mocked to pass the entry rule | `test/fork/VaultV2Fork.t.sol`: `test_fork_A01_hedgedVault_requestFulfilClaim_realFlowRoutes` (bob's 400 AUSD beyond 241.55 idle fulfilled with a real sell route, paid **399.27**, unwind cost 0.187 to the batch; 2,531,742 gas), `test_fork_A01_emergencyUnwind_realFlowRoute` (flat in one call, NAV 1,198.98 → 1,197.51), `test_fork_vaultV2_probeAmounts`; quotes in `test/fixtures/vault-v2-fork.json` |
| On testnet (labelled MockKuruHedger: no Kuru market on 10143) | vault `0xe8b38d1115F51Fb036a566C290b6b7d8Ae5692E6`: request → fulfil beyond idle → claim `0xea96c42969c646649f6e8f993bb25af32f85c8fb0e5fe0d56bbab2aabb99106b` (paid 1,149.351152, unwind cost 0.020898), `emergencyUnwind` `0xe9ccbaebc5af3c0e6a7f3cf039964a5f250ee9a7a751df4945c94fea148265db`; full table in HARDENING_LOOP P6.3. The hedge entry there was a **forced, labelled** `enterHedge()` (no 8 h funding history yet) |

## 8. Mainnet-ready by rehearsal, live on testnet
| Claim | Evidence |
|---|---|
| The mainnet deploy scripts run end to end on a mainnet fork and pass every check | `script/fork/rehearse-143.sh` @ 111,084,897: `VerifyDeployment` **52 / 52** (P4.4); perp + swaps + vault v2 @ 111,118,192: **56 / 56** incl. "hedger has no direct Kuru market (Flow only)" (P5.3i); `test/fork/DeployMeridianMainnet.t.sol::test_mainnet_deployAndRefusals` |
| Testnet deployment (frozen since 7 Oct 02:00 IST, tag `demo-freeze-10143`) | `deployments/10143.json`: CH `0x1F90B5Eb6D59adAe2be147b3903c7aCb4c16a6eA`, OB `0xCFB0169FF1957C347285Bb10Ab83E33F3C2bb207`, FundingSwapMarket `0xACFc9b2aEfD546AEd1FB21B2D82C5433c1d3Fe33`, swap OB `0xb7D732a5ac88c159B3CA553c672182D2Be51E6Db`, IF `0xCcd97285dD2fca8D028D880Ed754039118437b48`, vault `0xe8b38d1115F51Fb036a566C290b6b7d8Ae5692E6`, tAUSD (mock) `0x9739682300022676FF867Ad289d20A8fC08566A1`, demo market CH `0xB2D4DacC56DA8EFA248abcccB196f73c69ABdC01`; `VerifyDeployment` **55 / 55** at deploy (P4.5) |
| Gas on Monad, billed vs executed | `bench/out/gas_onchain_10143_2026-10-06-p7.csv` (blocks 68,785,334–68,785,397): every receipt's `gasUsed` = ⌈`eth_estimateGas` × 1.2⌉ + 70,000 (the bots' touch allowance); e.g. cancel estimate 117,266 → billed 210,720. BENCHMARKS.md B1 |

## 9. Invariants and test depth
| Suite | Depth | Result | Coverage that proves the paths ran |
|---|---|---|---|
| `RealStackInvariants` (I1–I7, I11, waterfall, mark band) | 512 × 256 (`FOUNDRY_PROFILE=ci`) | 11/11, 0 reverts | 372 liquidations, 128 uncovered-after-fees; 12,467 skips |
| `FundingSwapInvariants` (I9 + waterfall) | 512 × 256 | 4/4, 0 reverts | 2,719 liquidations, 112 waterfall hits |
| `VaultInvariants` (I8, I10, queue) | 512 × 256 | 6/6, 0 reverts | 12,282 requests, 390 fulfils with an unwind (P6 run) |
| `MeridianInvariants` (mock stack) | 512 × 256 | 14/14 | — |
| `OrderBookInvariant` (I6, I7) | 512 × 256 | 2/2 | 2,182 skips / 979 evictions |
All suites also run at 256 × 128 inside the 499-test default run. Coverage CSVs: `contracts/bench-out/*invariant_coverage.csv`.

## 10. Privy onboarding: first trade in 4 taps with 0 MON (K1)
| Claim | Evidence |
|---|---|
| Landing → first filled market order in **4 taps** (Start trading, ToS checkbox, "Get 10,000 test AUSD & deposit 1,000", Market long), **19.6 s** | `app/e2e/onboarding-anvil.spec.ts` on a local anvil (DeployLocal + SmokeLocal, fresh dev account, Privy off): the spec counts trusted clicks and asserts ≤ 4 (7 Oct run: 4 taps, 19.6 s). With Privy the dev-account tap is Privy's login (email Submit + code entry inside the modal) |
| Sponsored path routes only embedded wallets on 10143, gas limit = estimate × 1.2 on both paths, both check the receipt, a refused sponsorship never falls back to charging the user | `app/src/lib/{sponsor,tx}.test.ts` (unit, fake Privy sender + fake wallet) |
| Retry is idempotent (no double mint / approve) | `app/src/lib/onboard.test.ts` |
| Testnet run, fresh email, embedded wallet with **0 MON before and after** | ⏳ owner's manual run (or `app/e2e/onboarding-privy.spec.ts` with a Privy test account): mint `…`, approve `…`, deposit `…`, order `…`, taps …, time to first fill … s, explorer page of the wallet showing 0 MON |

**Security reviews:** two internal cross-reviews (`docs/outputs/security/review-A.md`, `review-B.md`) plus the 6 Oct audit hardening; status per finding in `docs/outputs/security/STATUS.md`.

**Not claimed (no evidence yet):** mainnet deployment, external users, fees, volume; B4 parallel-market load, B5 funding granularity from the indexer, B9 vault economics; the funding-swap demo on testnet (no swap market maker funded); liquidation ≤ 3 blocks on testnet.
