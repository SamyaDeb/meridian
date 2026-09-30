# PHASES: the build, phase by phase (supersedes the day grid in TEAM_PLAN §4)

The team finished Phase 1 in one day, so the plan now runs on **phases with exit gates** instead of fixed days. A phase ends when its gate passes, not when the calendar says so. The dates are **latest** dates; finishing early pulls everything forward. The checkpoint dates stay as hard backstops: CP1 Sat 3 Oct, CP2 Wed 7 Oct, CP3 Sat 10 Oct, submit Tue 13 Oct 18:00.

Rules for every phase:
- A gate is **demoed live** (terminal or screen share) and recorded in `docs/standup/<A|B|C>.md`. No gate is passed on "should work".
- Scope freeze at the end of Phase 4. Contract code freeze at 18:00 on mainnet day (Phase 5).
- Merges go to `main` only through A's WS-00 session (Meridian checkout), after cross-review (A ⇄ B for contracts).

| Phase | Name | Latest end | Status |
|---|---|---|---|
| 0 | Plan, interfaces, mocks | Tue 29 Sep | ✅ done |
| 1 | Core modules in isolation | Tue 29 Sep | ✅ done (not merged) |
| 2 | Integrate the perp core on anvil | Thu 1 Oct | ✅ G2 met except human items (live indexer/Docker, login decision) |
| 3 | Testnet perp + yield layers built | Sun 4 Oct (CP1 Sat 3 Oct inside) | ✅ on testnet except the 1 h unattended run + B7 ≤ 3 (MON / paid RPC); see G3 |
| **4** | **Full stack on testnet, scope freeze** | **Wed 7 Oct (CP2)** | **✅ scope frozen 30 Sep 2026**; G4 below (⚠️ items are MON / RPC / human bound) |
| 5 | Mainnet readiness and launch | Sat 10 Oct (CP3) | ▶ started 30 Sep (remote `github.com/SamyaDeb/pulse`, decisions 12–13) |
| 6 | Proof and submission | Tue 13 Oct 18:00 | — |

---

## Phase 0: Plan, interfaces, mocks ✅
Specs, frozen interfaces (v1.1 → v1.2), mocks, CI, DeployLocal (mocks), ABI export, prompts.

## Phase 1: Core modules in isolation ✅ (all on branches, none merged)
| Lane | Delivered |
|---|---|
| A `ws-01-orderbook` | TickBitmap, place/cancel/replace, bounded matching + eviction, gas bench (place+cancel 63.7k), I6/I7 handler, 56 tests |
| A `ws-02-clearinghouse` | FundingLib, MarkPriceLib, MarginLib, ClearingHouse (F, G, oracle ring, hooks, caps, fees, liquidation), InsuranceFund, MarketFactory, I1–I5/I11 handler, 135 tests; CR-006 filed |
| B `ws-03-oracle-keepers-mm` | PythChainlinkOracleAdapter + unit/fuzz/fork tests; keeper started (uncommitted) |
| C `ws-06/07/08` | Envio indexer (53 tests), PWA shell + mock data (27 tests), √τ chart, invariant skeletons I1–I11 on mocks |

Decisions recorded at the end of Phase 1 (lead):
1. Funding first-touch gas target is < 30k normally and **< 40k on checkpoint blocks** (1 in 200). The 2-slot checkpoint stays; 1-slot packing would overflow for BTC-priced markets.
2. The mark is cached once per block at first touch: approved.
3. markBand (5%) and lastTradeMaxAge (100 blocks) stay library constants.
4. Voluntary reductions must leave equity ≥ 0: approved.
5. Uncovered bad debt stays as negative collateral, and future deposits repay it first: approved.
6. Reservation release saturates at 0: approved (I7 tolerance ≤ 1 wei per fill).
7. **MATH_SPEC I1 gets a −Σpending term**: `AUSD.balanceOf(CH)·1e12 ≥ ΣC − ΣON − Σpending + accruedFees`.
8. MockOrderBook must call maker fills before the single taker fill and evict on `false`.
9. **MATH_SPEC §6.2:** swap `net` uses one floor division `floor((q·ΔF·YEAR − K·ΔG)/(1e18·YEAR))`; `kDelta = Δq·A/1e18` is computed once per fill and applied as +kDelta / −kDelta to the two sides (ΣK = 0 exactly).
10. Testnet (verified 29 Sep): Pyth MON/USD at `0x2880aB155794e7179c9eE2e38200202908C17B43` exists but is ~75 min stale (no sponsored push), so **the keeper must push Hermes updates and the Pyth API key is a CP1 blocker**. No Chainlink feeds listed on testnet, so the guard runs with secondary = address(0). No AUSD on testnet: deploy a 6-dp MockERC20 `tAUSD`. Testnet WMON `0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541`.
11. *(Phase 3, lead)* **MATH_SPEC §5.2 skew rule amended**: the literal form is degenerate under Σq = 0 (it caps the vault at 0.8 × its own short); capacity = skewCapacity · takers' net long = skewCapacity·max(0, −(vaultSize + Σ registered-provider sizes)). The MM bot addresses are registered as skew providers at deploy. Also: at the launch caps (maxPositionSize 25k MON ≈ $725) the vault can deploy ≈ $1.2k of its 10k AUSD deposit cap; Phase 4/5 must choose between a higher perp position cap, a vault-specific cap, or a lower vault deposit cap (open).
12. *(Phase 5, owner, 30 Sep)* **Vault cap: option C.** Mainnet `vault.depositCap` = **1,200 AUSD** (`"1200000000"`, 6 dp) in `contracts/script/config/143.json`; config only, no code. It supersedes the 10,000 AUSD launch cap in TEAM_PLAN §7 / MATH_SPEC §5.3 for launch. Raise it (Safe, `setVaultParams`) together with the perp `maxPositionSize` after launch.
13. *(Phase 5, owner, 30 Sep)* **CR-007 deferred** to post-hackathon; the runbook mitigation (MM re-quotes after `OrderEvicted` / stale→fresh) stays. No interface change: interfaces stay `v1.5` unless a security finding rated High reopens it before the 10 Oct 18:00 freeze.

---

## Phase 2: Integrate the perp core on anvil (▶ next; latest end Thu 1 Oct)
**Goal:** one `main` that contains every Phase 1 module, and the full perp loop running end to end on a local chain (contracts, keeper, market maker, indexer, app), before touching testnet.

| Session | Worktree | Phase 2 job |
|---|---|---|
| A0 | `Meridian` (`ws-00-foundations`) | CR-006 → v1.3, mock fixes, spec amendments 7 + 9, merges in order, DeployLocal on real contracts, `SmokeLocal` script |
| A1 | `pulse-a` | CP1 integration test on real contracts, reference-model fuzz, real-engine gas |
| A2 | `pulse-a3` (new, `ws-05-swaps`) | Funding swaps core, tests first (started early) |
| B | `pulse-b` | Commit keeper, review A's contracts, testnet oracle path, keeper + MM against anvil, vault on mocks |
| C1 | `pulse-c` (`ws-08-qa`) | Invariants on the real contracts |
| C2 | `pulse-c2` (`ws-06-indexer`) | Indexer end to end on anvil |
| C3 | `pulse-c3` (`ws-07-frontend`) | Login decision + Trade/Positions wired to anvil |

**Merge order (A0):** ws-00 fixes (tag v1.3) → ws-03 (A reviews) → ws-01 (B reviews) → ws-02 (B reviews; delete the local `InvalidParams` declarations, now in the interface) → ws-06 → ws-07 → ws-08. After each merge: `forge fmt --check && forge test && python3 tools/gen_interfaces_md.py --check`. Conflicts in `docs/standup/A.md` (append-only) keep both sides. Conflicts in `abis/` are resolved by re-running `bash tools/export_abis.sh`.

**Gate G2 ("CP1 on anvil"), all demoed live:**
- [x] `main` has OB + CH + IF + MarketFactory + oracle adapter; `interfaces-v1.3`; fmt, tests and the INTERFACES check are green *(30 Sep: 271 contract tests)*
- [x] `Integration.t.sol` passes *(9/9)*: deposit → limit → cross → positions → 12,000 blocks of per-block funding → `averageFundingApr` = ΔF·1e18/ΔG·YEAR from events → −15% oracle move liquidates a 5x long → IF and keeper paid → Σq = 0, longOI = shortOI, I1 (with −Σpending) holds
- [x] `anvil` + `DeployLocal` (real contracts) + `SmokeLocal`: the keeper pokes funding (≤ 20-block gaps) and liquidates within ≤ 3 blocks; the MM keeps a two-sided book *(max gap 20; 3 liquidations at 1 block; MM 5.86 bps)*
- [~] The indexer ingests every event type from the smoke run; realized APR 1h/8h/24h equals the contract's `averageFundingApr` *(recorded-log replay: all perp event types, 1 h APR equal to the wei; live Envio run, 8 h/24 h and lag pending Docker)*
- [~] The app shows the live per-block funding ticker, a position with pending funding and liq price, from anvil, with the chosen login *(done with injected + anvil dev login; Privy-vs-Mera not decided)*
- [x] Invariants I1–I7 and I11 green on the real OB + CH (256×128) *(and 512×256, fail_on_revert)*
- [ ] Human: shared git remote exists; Pyth API key in hand; Privy-vs-Mera decided; bounty criteria pasted; Envio token; Docker *(all open on 30 Sep)*

In parallel (tracked, not gating): swaps core (A2) tests-first on mocks; vault started on mocks (B).

---

## Phase 3: Testnet perp + yield layers built (latest end Sun 4 Oct; CP1 on Sat 3 Oct)
**Goal:** the perp runs on Monad testnet with real oracle pushes, a keeper and an MM. Swaps and vault are complete as contracts.
- A0: `DeployPulse` for 10143 (tAUSD, Pyth pushed by keeper, no Chainlink), `deployments/10143.json`, deploy the perp market.
- A1: hardening from invariant and indexer findings; review B's vault/hedger PRs.
- A2: FundingSwapMarket complete (liquidation, maturity, I9 handler) + integration on the real CH; merge.
- B: keeper + MM live on testnet; vault + KuruHedger on real CH/OB (mainnet-fork tests for Kuru and Kuru Flow); merge.
- C: indexer on hosted testnet; app Earn + Fix screens on mocks → testnet; benchmark harness B1/B2 on testnet; user outreach starts.
**Gate G3 = CP1 (testnet):** real trades on testnet with per-block funding, a live liquidation, keeper + MM running unattended 1 h, the indexer and app showing it; swaps and vault merged with green unit + integration tests.

**G3 status (30 Sep, lead, single session; evidence in docs/standup/A.md, B.md, C.md):**
| Item | Status | Evidence |
|---|---|---|
| Real trades on **Monad testnet**, per-block funding (≤ 20-block gaps) | ❌ blocked (no `DEPLOYER_PK`/`KEEPER_PK`/`MM_PK`, no testnet MON) · ⚠️ rehearsed | `DeployPulse` fork dry-run at testnet block 66,793,749 OK (29.7 M gas perp+demo; 48.1 M with vault+swaps); testnet code limit measured 128 KB; broadcast rehearsal on a local chain id 10143: after the keeper fix **max FundingUpdated gap 19 blocks, 0 > 20** (1,243 blocks) |
| **Live liquidation** (demo market), keeper latency | ❌ on testnet · ⚠️ rehearsed | MON-PERP-DEMO crash (factor 0.85): liquidated **1 block after eligibility, 3 blocks / 3.95 s after the oracle push** (1 s anvil blocks) |
| Keeper + MM **unattended ≥ 1 h** | ❌ on testnet · ⚠️ rehearsed | 3 h 29 min, 4 bots, 0 errors, books two-sided 208/210 & 209/210 samples ≤ 11.1 bps; bug found + fixed (56-block gap from a stalled price read) and re-verified 20 min |
| Indexer and app show the testnet market | ❌ pending deployment · ⚠️ ready | `testMarket` label (indexer + app badge), recorder with 100-block chunks verified on the 10143-shaped chain (4,653 events); live Envio needs Docker + token |
| **Swaps and vault merged**, green unit + integration (+ I9, I8/I10) | ✅ | contracts **380/380**: swaps 26 unit + fuzz + 4 integration on the real CH + 2nd OB + I9 (256×128 and 512×256, 35 liquidations/771 runs); vault 20 unit + 11 hedger + fork (live Kuru: 10 USDC → 370.49 MON) + fuzz + I8 (1,224 unwind withdrawals); tags `interfaces-v1.4`, `interfaces-v1.5` |
| Gas targets | ✅ Foundry · ⏳ testnet | place+cancel 96,478 (< 100k), CH-own first touch 29,273 (< 30k), checkpoint 29,984 (< 40k); MIP-8 receipts need the testnet run (`bench/gas_onchain.ts`) |
| Human: remote, Pyth key, login decision, bounty criteria, Envio token, Docker, testnet MON, paid RPC | ❌ all open | — |
Lead decisions this phase: 11 (skew rule amended, above); CR-007 proposed (maker-fill Skip vs Evict), CR-008/CR-009 applied.

**G3 close-out (Phase 4, 30 Sep; docs/standup/A.md "Phase 4"):**
| Item | Status | Evidence |
|---|---|---|
| Real trades + per-block funding on testnet, gaps ≤ 20 | ✅ | lag 6 keeper: 66 gaps over 1,201 blocks (66,932,691–66,933,892), max 20, 0 > 20 (chunked logs) |
| Live liquidation on testnet | ✅ | demo market, tx `0xac7d67c8…f23f` (block 66,933,023), IF credited |
| B7 ≤ 3 blocks | ❌ | 8 blocks after eligibility on the free public RPC (send path ≈ 3.2 s); 1 block locally. Needs the keeper on a paid RPC |
| Keeper + MM unattended ≥ 1 h on testnet | ❌ | not affordable: keeper ≈ 9.2 MON/h at lag 6, MM ≈ 24 MON/h; wallets held 6.39 MON. Rehearsed locally (3 h 29 min, Phase 3; 20 min A/B, Phase 4) |
| Indexer + app show testnet | ⚠️ | app reads testnet on all tabs (read-only dry-run screenshots); indexer live run pending Docker, replay tests green |

## Phase 4: Full stack on testnet, scope freeze (latest end Wed 7 Oct = CP2)
- Swap market + vault deployed on testnet; MM quotes the swap book; keeper does swap liquidations and `settleMaturity` (1-hour test maturity).
- CRE only if deploy access was granted (else dropped, recorded).
- Invariants I1–I11 green on real contracts; benchmark runs B1–B4 and B7 on testnet; app complete (all 5 tabs).
- Demo dry-run end to end.
**Gate G4 = CP2 + scope freeze:** everything in the demo script works on testnet; after this, fixes/UX/ops only.

**G4 status (30 Sep, lead, single session; evidence in docs/standup/A.md "Phase 4"):**
| Item | Status | Evidence |
|---|---|---|
| Vault: deposit → keeper rebalance → hedged within θ | ✅ testnet (forced entry) · ✅ local (entry rule) | testnet: keeper `enterHedge()` tx `0x59a0ed8c…6040` ⇒ spot 400 = short 400 MON, netDelta 0. The 8 h entry rule on testnet would need ≈ 72 MON of pokes, so it ran locally: realized 8 h APR 43.86% ⇒ EnterHedge ⇒ hedged 20,000/20,000 |
| Skew cap enforced | ✅ testnet + local | testnet `rebalance()` (SkewCap) tx `0x551e7306…363a`: 400 → 100 ≤ capacity 160; local 20,000 → 16,000 = 0.8 × 20,000 |
| NAV rises with funding | ✅ testnet + local | testnet share price +5.0e10 wei over 82 blocks; local up every block |
| Swaps: long/short fill on the swap book | ✅ testnet | MM two-sided 10.92/10.98%; long at 10.98% tx `0x977de75c…8355`, short at 10.92% tx `0x8ccb451d…a498` |
| Accrual = MATH_SPEC §6.2 within 1 wei | ✅ testnet + local | diff 0 wei on both sides (testnet block 66,932,382/390; local block 146) |
| Maturity snapshot on the 1-hour test maturity; keeper `settleMaturity` | ✅ testnet | keeper tx `0x839985ea…31f9` 1 s after maturity; accrual frozen; `Matured` on increases |
| Swap liquidation | ⚠️ local only | a 1-hour maturity can't be liquidated by a price shock (MM horizon = min(liqHorizon, τ)); rehearsed on a 30-day market (1 block) |
| Invariants I1–I11 on real contracts (256×128 and 512×256), `forge test` 100% | ✅ | `forge test` 379/379 (twice after the flaky-check fix); `FOUNDRY_PROFILE=ci` invariant suites 29/29 at 512×256 |
| Keeper + MM (perp + swap) running; G3 closed | ⚠️ | all bots ran on testnet in budgeted windows; 1 h unattended + B7 ≤ 3 open (MON, paid RPC) |
| App: all 5 tabs live on testnet, Earn + Fix write paths, login per decision | ⚠️ | 5 tabs read testnet (dry-run screenshots `app/e2e/screenshots/demo-*.png`); Earn/Fix writes pass Playwright on the local full stack; **login undecided** ⇒ injected + dev |
| Indexer live (or replay + pending note) | ⚠️ replay | full-stack replay 8/8 vs contract views; live Envio pending Docker; hosted needs the git remote |
| B1–B4 + B7 in `docs/outputs/BENCHMARKS.md` | ⚠️ | B1/B2 testnet + Foundry, B6, B7 in; B3/B4 placeholders (no paid RPC / MON) |
| Demo dry-run | ✅ with gaps | read-only testnet walk-through 4/4 + crash on a local fork (liquidated at offset 1, NAV flat, markApr flat). Gaps: login segment (decision), metrics dashboard (indexer), a fresh 30-day swap market for the video, mainnet |

Decisions this phase: CRE **dropped** (no deploy access; PRD §8 cut order). CR-007 stays **Proposed** (unapplied). **Vault cap (decision 11): open, the owner picks one** (numbers at MON = 0.0272, L = 1.5, launch caps maxPositionSize 25k / OI 250k MON):
- **A. Raise the perp `maxPositionSize` for everyone** (e.g. to the 250k OI cap): the vault's reach becomes 0.8 × takers' net long, at most 200k MON ≈ $5.4k notional ⇒ ≈ $9.1k deployed (spot + margin). Config only, but one trader could then hold the whole OI.
- **B. Vault-specific position cap** (a per-account cap override in the CH): same reach for the vault only. Needs an IClearingHouse CR (interfaces-v1.6) and CH code, which conflicts with this scope freeze.
- **C. Lower the vault `depositCap` to ≈ 1,200 AUSD at launch** (`setVaultParams`, no code): at the 25k cap the vault can deploy ≈ $1.13k (25k MON spot ≈ $680 + margin ≈ $453) of 10k today. Raise it together with the perp caps later. **Lead's recommendation: C for launch** (honest, no code after the freeze).

**Scope frozen: Wed 30 Sep 2026** (lead). From here: fixes, UX, ops only.

## Phase 5: Mainnet readiness and launch (latest end Sat 10 Oct = CP3)
- Security review of all contracts (cross-review + WS-08 checklist), fixes.
- Mainnet-fork rehearsal of `DeployPulse` (owner = Safe 2-of-3) + crash demo on the fork (per-block CSV).
- Monitoring + `keepers/RUNBOOK.md`; mobile polish (Lighthouse ≥ 80, iOS/Android checklist).
- **Mainnet day:** deploy with caps, seed IF + MM inventory + vault, keeper/MM live, indexer on mainnet, first external users. Contract code freeze 18:00.
**Gate G5 = CP3:** live on mainnet, ≥ 5 external users, first fees onchain.

## Phase 6: Proof and submission (Tue 13 Oct 18:00)
- Benchmarks final (`docs/outputs/BENCHMARKS.md`), metrics dashboard, √τ chart.
- Crash demo recording (mainnet fork, labelled), demo video per DEMO_SCRIPT, `docs/outputs/WRITEUP.md` using only PRD §7.1 claims, project profile, bounty forms.
**Gate G6:** submitted before 18:00, with every hard acceptance criterion linked to evidence.

Prompts for the current phase live in `docs/prompts/phase-N/`.
