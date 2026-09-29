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
| **2** | **Integrate the perp core on anvil** | **Thu 1 Oct** | ▶ next |
| 3 | Testnet perp + yield layers built | Sun 4 Oct (CP1 Sat 3 Oct inside) | — |
| 4 | Full stack on testnet, scope freeze | Wed 7 Oct (CP2) | — |
| 5 | Mainnet readiness and launch | Sat 10 Oct (CP3) | — |
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
- [ ] `main` has OB + CH + IF + MarketFactory + oracle adapter; `interfaces-v1.3`; fmt, tests and the INTERFACES check are green
- [ ] `Integration.t.sol` passes: deposit → limit → cross → positions → 12,000 blocks of per-block funding → `averageFundingApr` = ΔF·1e18/ΔG·YEAR from events → −15% oracle move liquidates a 5x long → IF and keeper paid → Σq = 0, longOI = shortOI, I1 (with −Σpending) holds
- [ ] `anvil` + `DeployLocal` (real contracts) + `SmokeLocal`: the keeper pokes funding (≤ 20-block gaps) and liquidates within ≤ 3 blocks; the MM keeps a two-sided book
- [ ] The indexer ingests every event type from the smoke run; realized APR 1h/8h/24h equals the contract's `averageFundingApr`
- [ ] The app shows the live per-block funding ticker, a position with pending funding and liq price, from anvil, with the chosen login
- [ ] Invariants I1–I7 and I11 green on the real OB + CH (256×128)
- [ ] Human: shared git remote exists; Pyth API key in hand; Privy-vs-Mera decided; bounty criteria pasted; Envio token; Docker

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

## Phase 4: Full stack on testnet, scope freeze (latest end Wed 7 Oct = CP2)
- Swap market + vault deployed on testnet; MM quotes the swap book; keeper does swap liquidations and `settleMaturity` (1-hour test maturity).
- CRE only if deploy access was granted (else dropped, recorded).
- Invariants I1–I11 green on real contracts; benchmark runs B1–B4 and B7 on testnet; app complete (all 5 tabs).
- Demo dry-run end to end.
**Gate G4 = CP2 + scope freeze:** everything in the demo script works on testnet; after this, fixes/UX/ops only.

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
