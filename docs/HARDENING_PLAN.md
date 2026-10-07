# HARDENING_PLAN: protocol hardening + vault v2 before submission (6 → 13 Oct 2026)

> Paths under `docs/standup/` and `docs/prompts/` cited below are the team's working logs, kept in the private development repository.

Owner: A (lead, WS-00). Written Tue 6 Oct 2026 from the 6 Oct audit. Scope = audit Step 1–3 and Step 5:

| Phase | Item | Audit ref | Contracts touched | Interface change? |
|---|---|---|---|---|
| P0 | Branch, baseline, decisions, CR paperwork | — | none | — |
| P1 | Bad-debt waterfall: IF → protocol fees → uncovered | M-3 | ClearingHouse, FundingSwapMarket | no |
| P2 | Mark premium rate limit (per-block bound on the book-derived basis) | M-1 | MarkPriceLib, ClearingHouse | no |
| P3 | CR-007: maker fill `Filled / Evict / Skip` | M-2 | IMarginEngine, IOrderBook, OrderBook, ClearingHouse, FundingSwapMarket, mocks | **yes** (CR-007, v1.6) |
| P4 | Integration, deep invariants, **mainnet-fork rehearsal (no broadcast)**, **testnet 10143 relaunch** (perp + swaps + demo market), bots, indexer, app, crash demo, onchain gas bench | Found #1, #6 | none (scripts/config, test handlers) | — |
| P5 | Vault v2: async withdrawals + routed exits + emergency unwind + cooldown | A-01, A-07, A-09, A-11 | MeridianVault, IMeridianVault, KuruHedger config | **yes** (CR-014, v1.7) |
| P6 | Vault v2 on testnet + end-to-end demo rehearsal | — | none | — |
| P7 | Docs, benchmarks, write-up, demo video, submission | — | none | — |

> **Revision 6 Oct, night (owner): no mainnet deploy before the hackathon (PHASES 40).** Everything ships to **Monad testnet 10143**; mainnet readiness is shown by a **mainnet-fork rehearsal** of the same scripts (no broadcast) and by the A-01 fork test with a real Kuru Flow route. Consequences: the Thu 8 Oct freeze and go/no-go are gone; the human items for mainnet (Safe, mainnet keys, AUSD capital, ToS, owner "go") are no longer blocking; **testnet MON becomes the main human dependency** (bots ≈ 15 MON/h, RUNBOOK §4). PRD G1 ("live on mainnet") and the §6 mainnet traction metrics can't be met; the write-up says so plainly and reports testnet usage instead. Contracts stay changeable until the **demo freeze (Sat 10 Oct 18:00)**, after which only the demo deployment is used. Decision 35 ("no v1 vault on mainnet day") is superseded: the testnet relaunch ships no vault, vault v2 joins it in P6.

Parallel lanes (not in this plan, but P4 depends on them): **B** keeper unwind after liquidation (H-1), MM re-quote on `OrderEvicted` / `MakerFillSkipped`, MM depth within ±5%; **C** Kryon rewrite + rebase of `ws-07zb` (H-3), app ABI bump, Earn v2 UI (P5.6).

---

## 0. Ground rules (read before every phase)

1. **Non-upgradeable contracts set the order.** CH / OrderBook / swap market changes (P1–P3) go into the **testnet relaunch (P4)**; changing them later means another redeploy, new indexer config and new app addresses. The vault only *consumes* the CH, so vault v2 (P5) joins the same testnet deployment afterwards (P6) without touching the perp.
2. **One phase = one branch = one PR**, stacked: `ws-00p-hardening` (P0) → `ws-02c-bad-debt-waterfall` (P1) → `ws-02d-mark-bound` (P2) → `ws-01c-cr007-skip` (P3) → `ws-00q-launch` (P4) → `ws-04c-vault-v2` (P5). Rebase each on `origin/main` after the previous one merges. Work in a worktree `../pulse-hard`, never in `../Meridian` (owner tree, frontend work in progress).
3. **Tests first** (CONTRIBUTING.md §1.7): write the failing test / PoC, then the fix. Every phase ends green on: `forge build`, `forge test` (non-fork), `forge fmt --check`, the invariant suites at CI depth, the gas ceilings (`test/unit/ClearingHouseGas.t.sol`, `test/bench/RealEngineGas.t.sol`), and TS suites touched by an ABI change.
4. **Interfaces:** P3 and P5 change frozen files. Apply the CR in a **separate WS-00 commit first** (`chore(ws-00): apply CR-0xx, interfaces-v1.x`), regenerate `abis/` and `docs/INTERFACES.md`, then implement. P1/P2 change no interface.
5. **Every formula** gets `// MATH_SPEC §x.y, rounds <up|down|neutral>`; every behaviour change gets a MATH_SPEC amendment line and a PHASES decision (next free number: **35**). Next free CR: **CR-014** (CR-007 is reopened, not renumbered).
6. **Gas budget is tight:** CH-own funding first touch is **29,368 / 30,000**. P2 adds code to that path. Measure before and after; if it busts the ceiling, use the fallback in P2.4 rather than raising the ceiling.
7. **Timeboxes are hard.** If a phase isn't green by its cut-off, record a PHASES decision "cut, post-hackathon" and move on. A launch with P1+P2 and without P3 is acceptable; a broken launch isn't.

## 1. Timeline

| When (IST) | Phase | Gate / cut-off |
|---|---|---|
| Tue 6 Oct, evening | P0 + P1 | P1 PR green by **Wed 09:00** |
| Wed 7 Oct, morning | P2 | P2 PR green by **Wed 15:00** |
| Wed 7 Oct, afternoon → night | P3 | **Cut-off Wed 23:00**: green or cut |
**Actual (revised 6 Oct night):** P0–P3 all finished Tue 6 Oct. P1 merged (#7); P2 and P3 done, awaiting the owner's push.

| When (IST) | Phase | Gate / cut-off |
|---|---|---|
| Wed 7 Oct | **P4** merge P2+P3, verification, swap-handler gap, mainnet-fork rehearsal, testnet relaunch, bots, indexer, crash demo | Testnet live on the new contracts by **Thu 8 Oct 12:00** |
| Thu 8 Oct → Fri 9 Oct 18:00 | **P5** vault v2 (contracts + keeper + fork proof) | Cut-off **Fri 9 Oct 18:00** (else Earn = roadmap, CR-014 implemented and fork-tested) |
| Sat 10 Oct | **P6** vault v2 on testnet, full demo rehearsal | **Demo freeze Sat 10 Oct 18:00** (no contract change after) |
| Sun 11 → Tue 13 Oct | **P7** testnet users, benchmarks, write-up, video, submission | Submit by Tue 13 Oct, well before 18:00 |

**Decision 35** (no v1 vault on mainnet day) is superseded by **PHASES 40**: the testnet relaunch ships no vault; vault v2 is added to it in P6.

---

## P0. Setup and baseline (≈ 1 h)

1. `git fetch origin && git worktree add ../pulse-hard -b ws-00p-hardening origin/main`, then `cd ../pulse-hard/contracts && git submodule update --init --recursive`. Do **not** branch from `ws-07zb-*` (it carries the held-back Kryon commit `de40466`).
2. Use the CI forge (**v1.5.1**; stable 1.8.4 breaks the gas and code-size tests). Check with `forge --version`.
3. Baseline, saved to `docs/standup/HARDENING_LOOP.md`: `forge test --no-match-path 'test/fork/*'` counts (6 Oct: 404/0/2 on the old base; main adds `Config143.t.sol`), `forge snapshot` → `contracts/.gas-snapshot-baseline`, the four gas numbers (funding first touch, checkpoint touch, place+cancel, replace).
4. Paperwork commit (`docs(ws-00): ...`):
   - PHASES 35 (no v1 vault on mainnet day), 36 (bad-debt waterfall), 37 (mark premium bound), 38 (CR-007 reopened, decision 13 reversed), 39 (vault v2 async withdrawals, supersedes CR-010's `redeemWithRoute`/`withdrawWithRoute`).
   - CHANGE_REQUESTS: CR-007 status → "Approved (6 Oct, owner), apply in P3"; new **CR-014** row (vault v2, §P5.1), status Proposed → Approved.
   - Create `docs/standup/HARDENING_LOOP.md` with a checklist of every task id below (P1.1 … P7.4) and an evidence log.

---

## P1. Bad-debt waterfall: IF → protocol fees → uncovered (M-3) · ≈ 3 h

**Problem.** `_coverBadDebt` leaves uncovered debt as negative collateral while `_fees` stays payable, so `collectFees` pays the protocol ahead of users and the last withdrawers absorb the shortfall (`ClearingHouse.sol:578-594`, `:634`; `FundingSwapMarket.sol:457-471`, `:496`).

**Design (standard waterfall).**
```
uncovered₀ = badDebt − coveredByIF                 // unchanged
fromFees   = min(uncovered₀, max(_fees, 0))        // new
_fees     -= fromFees
uncovered  = uncovered₀ − fromFees
collateral = −uncovered ; totalBadDebt += uncovered   // only the truly uncovered part
```
- Why not a "revert `collectFees` while `totalBadDebt > 0`" guard: `totalBadDebt` never decreases, so one event would lock fees forever, and the guard doesn't actually move money to the users. The waterfall makes fees junior to users by construction, with no new error and no ABI change.
- I1 is unchanged: −x on `_fees` and +x on the account's collateral.
- Event: keep `BadDebtSocialized(requested, coveredByInsurance, uncovered)` with `coveredByInsurance` = IF part only; the fee part = `requested − coveredByInsurance − uncovered` (document it in the NatSpec and in `indexer/SCHEMA.md`). Emit it whenever `badDebt != 0 && coveredWad < badDebt` (today it's only emitted when uncovered > 0 *before* fees; keep emitting when the IF falls short, even if fees cover the rest).
- `_fees` can be negative only *inside* an order (maker rebate before the taker fee). Liquidation is never inside an order, but use `max(_fees, 0)` anyway.
- Apply the same change to `FundingSwapMarket._coverBadDebt`, which today doesn't emit the event at all. Add the emit there (the event is on IClearingHouse, not on IFundingSwapMarket; if the swap interface has no such event, **don't add one**: P1 must not touch interfaces. Note it for CR-014's batch instead).

**Tasks.**
- P1.1 Failing unit tests in `test/unit/Liquidation.t.sol` (perp) and `test/unit/FundingSwapMarket.t.sol` (swap): (a) IF empty, fees ≥ debt ⇒ collateral 0, `_fees` reduced by the debt, `totalBadDebt` unchanged; (b) IF empty, fees < debt ⇒ fees 0, uncovered = debt − fees; (c) IF covers all ⇒ fees untouched (regression); (d) `collectFees` after (a) pays only the remainder.
- P1.2 Implement in both contracts (CEI: state writes before the IF call stay as they are; the fee absorption happens after the balance-delta measure, no external call after it).
- P1.3 Fuzz `test/fuzz/` (new `BadDebt.fuzz.t.sol`): any (IF balance, fees, debt) ⇒ `coveredIF + fromFees + uncovered == debt`, `fromFees ≤ max(fees,0)`, token conservation `balance·1e12 ≥ ΣC − ΣON − Σpending + fees` holds before and after.
- P1.4 Invariant handlers: make sure the perp and swap handlers can reach uncovered bad debt with non-zero fees (add an action that drains the IF in the handler if none exists). I1 / I9 stay green at CI depth.
- P1.5 MATH_SPEC §3.3 line: "bad debt: IF first, then accrued protocol fees, then uncovered (negative collateral, `totalBadDebt`)"; same for §6.4. PHASES 36.
- P1.6 PR `[WS-02] Bad-debt waterfall: fees junior to users (M-3)`.

**Acceptance:** all P1 tests green; no gas change on hot paths (liquidation only); `git diff origin/main -- contracts/src/interfaces` empty.

---

## P2. Mark premium rate limit (M-1) · ≈ ½ day

**Problem.** Two of the three mark inputs (book mid, last trade) come from our own book, and the mark is re-derived from scratch on every block's first touch (`ClearingHouse.sol:316`, `MarkPriceLib.sol:36-51`). On a thin launch book, sweeping one side ≈ 10% and printing a wash trade moves next block's mark to index ±5% and liquidates accounts within 5% of their liquidation price.

**Design: bound the *premium*, not the price.**
```
p_prev = mark_prev / index_prev − 1                    // from PriceSlot, no new storage
p_live = clamp(median(A, B, C), I(1±band)) / I − 1      // today's mark, as a premium
k      = min(block.number − lastUpdateBlock, MARK_MAX_ELAPSED_BLOCKS)   // 20
p_used = clamp(p_live, p_prev − k·MARK_MAX_PREMIUM_STEP, p_prev + k·MARK_MAX_PREMIUM_STEP)
M      = I · (1 + p_used)                               // then the ±band clamp again (no-op, defensive)
```
- **Index moves pass through instantly** (M is re-anchored on the live I every block), so liquidations still track a real crash at full speed; only the book-derived *basis* is rate-limited. A bound on the absolute mark (the swap B-01 pattern) would lag a genuine index crash and create bad debt, which is why this is a premium bound.
- Defaults (constants in `MarkPriceLib`, beside `MARK_BAND`; no `MeridianConstants` / interface change): `MARK_MAX_PREMIUM_STEP = 0.001e18` (10 bps per block), `MARK_MAX_ELAPSED_BLOCKS = 20`. Reaching the full ±5% band takes ≥ 50 blocks ≈ 15 s of a *sustained* manipulated book, against an MM that re-quotes every block. One first touch after a long gap moves at most 2%.
- Stale oracle: unchanged (mark stays the last good one). Stale → fresh: `p_prev` comes from the last good mark / last good index.
- Constructor: mark = index ⇒ p_prev = 0.
- Same-block trades: the first touch of a block always runs before that block's first trade settles (every fill touches the CH first), so C never includes a same-block print. Prove it with a test instead of adding code.
- Rounding: neutral (truncate toward 0), one division: `p_prev = (mark·1e18)/index − 1e18` via `fullMulDiv`.

**Tasks.**
- P2.1 PoC first, `test/security/MarkManipulation.t.sol`: thin book (MM 1 level), attacker sweeps the asks to +10% and wash-trades from a second account; a short at ≈ 4% from liquidation. **Before:** the next block's mark = I·1.05 and the short is liquidatable. Commit the PoC failing (`vm.skip` gate like `REVIEW_B_POC`), flip it after the fix.
- P2.2 `MarkPriceLib.markPrice(...)` gains `(uint256 prevMark, uint256 prevIndex, uint256 elapsed)`; the CH passes `px.mark, px.lastIndex, block.number − b.lastUpdateBlock`. Keep the old pure median as `_liveMark` for tests.
- P2.3 Unit (`test/unit/Mark.t.sol`): one-block manipulation moves the premium ≤ 10 bps × k; an index jump of −15% moves the mark −15% in the same block (premium unchanged); a 1,000-block gap is capped at k = 20; stale → fresh; band still holds. Update any existing assertions that assumed the instant median.
- P2.4 Gas: re-run both ceilings. **If CH-own first touch ≥ 30,000:** store the premium instead of the mark (`int96 markPremium` in `PriceSlot` in place of `uint96 mark`, written on the first touch), compute `mark = I·(1+p)` on reads. That removes the division from the hot path. `ClearingHouseLayout.t.sol` must be updated in the same commit. Don't raise the 30k ceiling (PRD §6 metric).
- P2.5 Fuzz (`test/fuzz/Mark.fuzz.t.sol`): for random (prev mark, prev index, index, book, trade, gap): `|p_used − p_prev| ≤ min(gap,20)·step`, `M ∈ I(1±band)`, and with an untouched book, M converges to the median within ⌈|Δp| / step⌉ blocks.
- P2.6 Crash demo: `script/CrashDemo.s.sol` and its test still liquidate within ≤ 3 blocks (the demo moves the index, which passes through). Run the demo dry-run on anvil.
- P2.7 MATH_SPEC §2.1 amendment block (formula above + rationale: "bound the basis, not the price"); PHASES 37; RUNBOOK one line: "mark basis moves ≤ 10 bps/block".
- P2.8 PR `[WS-02] Mark premium rate limit (M-1)`.

**Acceptance:** PoC flipped to passing; funding first touch < 30k and checkpoint touch < 40k; crash demo liquidates ≤ 3 blocks; invariants green.

---

## P3. CR-007: maker fill `Filled / Evict / Skip` (M-2) · ≈ 1 day · cut-off Wed 23:00

**Problem.** While the oracle is stale or the market paused, any taker evicts every *increasing* maker it touches (≤ 32 per tx) because `settleMakerFill` can only return `false`, wiping the MM book exactly when the market recovers.

**Design (CR-007 as approved, with two precisions).**
- `IMarginEngine`: `enum MakerFillResult { Filled, Evict, Skip }`; `settleMakerFill(...) returns (MakerFillResult)`.
- `IOrderBook`: `event MakerFillSkipped(uint64 indexed orderId, address indexed maker);`
- **OrderBook `_match`/`_visit`:** `Skip` ⇒ leave the order untouched (lots, FIFO position, reservation), emit `MakerFillSkipped`, **stop matching** (no further orders or levels: skipping past the head would break price-time priority). The existing post-match rule already drops a crossing remainder (`_place`: `_crosses(...)` ⇒ no rest), so bestBid < bestAsk (I6) holds. A Skip still counts as a visit.
- **ClearingHouse** maps `_checkFill` results: `Paused`, `OracleStale` ⇒ **Skip**; `InsufficientMargin`, `PositionCapExceeded` ⇒ **Evict**; OI cap can't fail a maker (`oiRef = max`). The maker's funding settlement is still written on Skip and Evict (as today).
- **FundingSwapMarket:** `Paused` ⇒ Skip; `Matured` ⇒ **Evict** (permanent: those orders can never fill again, so clearing them is right); margin / caps ⇒ Evict.
- Taker effect: during staleness, a reduce-only taker fills only against makers that are themselves reducing, until the first increasing maker; then it stops. That is the intended "market refuses new risk" behaviour; document it.

**Tasks.**
- P3.1 WS-00 commit: apply CR-007 to `IMarginEngine` + `IOrderBook`, bump the tag to `interfaces-v1.6`, regenerate `abis/` and `docs/INTERFACES.md`, update mocks (`MockClearingHouse`, `MockOrderBook`) so the build is green before any logic change.
- P3.2 Failing tests (`test/unit/OrderBookEngine.t.sol`, `ClearingHouse.t.sol`, `FundingSwapMarket.t.sol`): oracle stale + reduce-only taker ⇒ increasing maker order still resting with the same lots and reservation, `MakerFillSkipped` emitted, taker remainder not resting; paused, same; margin failure still evicts; swap matured ⇒ evict; a Skip at the head stops matching even if deeper levels would fill.
- P3.3 Implement OrderBook 3-way branch, CH + swap mapping.
- P3.4 Invariants: I6 (book integrity) and I7 (Σ reservations) handlers learn that a skipped order keeps its reservation; add a handler action that toggles stale/paused mid-run. Run `MeridianInvariants`, `RealStackInvariants`, `FundingSwapInvariants` at CI depth, then once at 256×128.
- P3.5 Gas: place+cancel < 100k, replace < 100k, per-extra-fill < 30k (`test/bench/*`). The enum return costs the same as a bool; verify.
- P3.6 Offchain ABI fallout (same PR, small): `abis/` consumers compile (`pnpm -r typecheck`); `indexer` handler + `SCHEMA.md` row for `MakerFillSkipped`; `mm-bot` treats `MakerFillSkipped` as "order still live" (no re-quote) and `OrderEvicted` as "re-quote". Hand the app ABI bump to C.
- P3.7 CHANGE_REQUESTS CR-007 → Applied; PHASES 38; INTERFACES §2.2 text (Skip semantics).
- P3.8 PR `[WS-01] CR-007 maker fill Skip (M-2)`.

**Cut rule:** not green by Wed 23:00 ⇒ revert the CR commit, PHASES 38 = "cut", and the RUNBOOK mitigation (MM re-quotes after `OrderEvicted`) stays. P4 proceeds without it.

---

## P4. Integration, mainnet-fork rehearsal, testnet relaunch · Wed 7 Oct (→ Thu 12:00)

**Goal:** the hardened contracts (P1–P3) run end to end on Monad testnet 10143 with keeper, MMs, hosted indexer and app, the crash demo liquidates on chain, and the same deploy is proven against mainnet state on a fork without broadcasting. Branch `ws-00q-testnet-relaunch` from `origin/main` after P2 and P3 merge.

**Human prerequisites (owner, before P4.6):** testnet MON on the deployer, keeper, perp MM, swap MM and flow keys (budget below); `MONAD_RPC_URL` (mainnet, for the fork only) and `MONAD_TESTNET_RPC_URL` in `.env`; Envio Cloud access for the redeploy (#14, done on 5 Oct for the old deployment). P2 and P3 pushed and squash-merged.

**MON budget (RUNBOOK §4, measured 6 Oct on 10143):** keeper ≈ 8 MON/h, perp MM ≈ 5.7 MON/h (1 level), flow ≈ 1.3 MON/h ⇒ **≈ 15 MON/h with all bots**. Deploy (perp + swaps + demo market) ≈ check `--gas-estimate-multiplier 200` dry-run. Run bots only in evidence windows (crash demo, gas bench, demo recording), not continuously. If the keys hold less than one 30-min window plus deploy, stop after P4.5 and report.

| Task | What | Done when |
|---|---|---|
| P4.1 | Rebase/merge: P2 PR, then P3 PR (`git rebase --onto origin/main ws-02d-mark-bound ws-01c-cr007-skip` after P2's squash), push tag `interfaces-v1.6` with P3 | `origin/main` has P1–P3, CI green |
| P4.2 | Full verification on `main`: non-fork `forge test`, invariants at CI depth and once at 256×128 default, gas ceilings, `forge snapshot --diff .gas-snapshot-baseline`, `pnpm -r test`, `pnpm -r typecheck`, `pnpm abis` clean, `gen_interfaces_md.py --check` | all green, numbers in HARDENING_LOOP |
| P4.3 | **Close HARDENING_LOOP Found #1:** swap invariant handler gets a "shock" action (wide book / long roll with keeper pokes, or a short-maturity fixture) so swap liquidations and the bad-debt waterfall actually happen in `FundingSwapInvariants` (I9, `invariant_I9_badDebtWaterfall`). Timebox 3 h | coverage CSV shows swap liquidations > 0 and waterfall hits > 0, invariants green |
| P4.4 | **Mainnet-fork rehearsal, no broadcast:** `contracts/script/fork/rehearse-143.sh` + `VerifyDeployment` + `SmokeFork143` on a 143 fork with the hardened code; add checks for the P2 constants and the CR-007 ABI (enum return, `MakerFillSkipped`); a fork smoke that pauses the market and shows a maker Skip | rehearsal log + Verify N/N in HARDENING_LOOP; this is the "mainnet-ready" evidence |
| P4.5 | **Testnet deploy:** `DeployMeridian` on 10143 with `DEPLOY_SWAPS=true`, vault not deployed (`DEPLOY_VAULT` unset), demo market included; archive the old record as `deployments/10143-v1.json`; new `deployments/10143.json`; `VerifyDeployment` on 10143; explorer verification if the verifier is configured (HUMAN #17, else skip and say so) | addresses in `deployments/10143.json`, Verify green |
| P4.6 | **Offchain repoint:** keeper + perp MM + swap MM + flow bot env to the new addresses (budget settings: MM `LEVELS=1 REQUOTE_BPS=10`, swap MM `REQUOTE_BPS=1000 TICK_EVERY_BLOCKS=33`), indexer config regenerated (`indexer/scripts/gen-config.mjs`) and the hosted Envio deployment updated (new endpoint, `NEXT_PUBLIC_INDEXER_URL`), app bundled testnet record + env, MFI unaffected | `/health` ok, indexer synced from `startBlock`, app shows the new market |
| P4.7 | **Crash demo on testnet with bots up (closes Found #6):** demo market, keeper + demo MM running, ≈ 5x long, −15% keeper-fed push, liquidation within ≤ 3 blocks; plus a **Skip demo**: pause the demo market, send a reduce-only taker, show `MakerFillSkipped` and the MM order still resting, unpause | tx hashes + block numbers + latency in HARDENING_LOOP, screenshots for the video |
| P4.8 | **Onchain gas bench (B1/B2) on testnet** with the hardened contracts, within the MON budget (`bench/gas_onchain.ts`, gas limit with `TOUCH_ALLOWANCE_GAS`) | `bench/out/gas_onchain_10143_<date>.csv`, BENCHMARKS.md B1/B2 refreshed |
| P4.9 | Docs: PHASES 40 (no mainnet before submission; 35 superseded), HARDENING_PLAN revision committed, RUNBOOK testnet section (new addresses, budget windows), README/deployments notes; security self-review "### P4" | HARDENING_LOOP P4 report |

**Lanes:** P4.6 touches B's (keeper/MM) and C's (indexer/app) config. Lead does the repoint commits on the P4 branch unless B/C are online; hand the H-1 keeper unwind (B) and the Kryon rewrite (C) over as before. **H-1 matters for the crash demo:** if the keeper can't absorb the liquidated position (cap / margin), the demo fails. Size the demo trader below the keeper's headroom or fund the keeper's collateral, and record which.

---

## P5. Vault v2: async withdrawals + routed exits (A-01) · Thu evening → Sat 12:00

**Why async.** Today every withdrawal beyond idle unwinds inside the user's transaction with an **empty route** = the dead Kuru MON/AUSD market on 143 (A-01), so a hedged vault locks deposits. CR-010's `redeemWithRoute` would make users carry Flow calldata that goes stale between quote and execution (A-13). Production basis vaults (Ethena, HLP-style vaults, ERC-7540) use: **instant up to idle, a request queue beyond it, served by a keeper with the best route**. Lane note: the vault is WS-04 (B). Either B implements P5 or the owner records the exception in PHASES 39.

### P5.1 CR-014 (IMeridianVault, additive, `interfaces-v1.7`)
```solidity
struct RedeemRequest { address owner; address receiver; uint128 shares; uint64 requestedBlock; uint64 status; } // Pending / Claimable / Claimed / Cancelled
event RedeemRequested(uint256 indexed id, address indexed owner, address receiver, uint256 shares);
event RedeemCancelled(uint256 indexed id);
event RedeemFulfilled(uint256 indexed id, uint256 assets, uint256 unwindCost);
event RedeemClaimed(uint256 indexed id, address indexed receiver, uint256 assets);
event EmergencyUnwind(uint256 baseSold, uint256 perpBought, uint256 navAfter);
error RequestNotFound(); error NotRequestOwner(); error RequestTooLarge(); error CooldownActive();

function requestRedeem(uint256 shares, address receiver, address owner) external returns (uint256 id);
function cancelRedeem(uint256 id) external;                                    // Pending only
function fulfillRedeems(uint256[] calldata ids, bytes calldata spotRoute) external; // onlyKeeper, ids.length ≤ MAX_BATCH
function claimRedeem(uint256 id) external returns (uint256 assets);            // pull, to receiver
function exitHedgeWithRoute(bytes calldata spotRoute) external;                // onlyKeeper, cooldown
function emergencyUnwind(uint256 maxBase, bytes calldata spotRoute) external;  // onlyOwner (Safe), works while entered
function pendingRedeemShares() external view returns (uint256);
function claimableAssets() external view returns (uint256);
function getRedeemRequest(uint256 id) external view returns (RedeemRequest memory);
```
CR-010 items (1) `exitHedgeWithRoute` and (2) `emergencyUnwind` are kept; (3) `redeemWithRoute`/`withdrawWithRoute` are **superseded** by the queue.

### P5.2 Semantics (the parts that are easy to get wrong)
- **Sync `withdraw`/`redeem` are idle-only.** `maxWithdraw`/`maxRedeem` = min(owner's assets, `idleFree`) where `idleFree = idle − claimableAssets`. They never unwind, so they never revert inside the max (fixes A-11) and never use the empty route (A-01's root cause gone). `_ensureIdle`'s unwind path is deleted.
- **Escrow:** `requestRedeem` moves shares from `owner` (allowance rules as ERC-4626) into the vault. Escrowed shares stay in `totalSupply`, so the redeemer keeps NAV exposure until fulfilment (price set at fulfil, ERC-7540 style; no free option against other holders).
- **Claimable AUSD is not NAV:** `totalAssets()` = NAV − `claimableAssets`. Forgetting this inflates the share price for everyone else (I8 violation). Every idle read (`_needs`, deploy budget, `idleBuffer`) uses `idleFree`.
- **Fulfil:** for the batch, assets = Σ previewRedeem(shares) at current NAV; if idleFree < assets, unwind a pro-rata slice of both legs **through `spotRoute`** (perp leg reduce-only, spot minOut = index − maxSlippage, balance-delta check); the NAV cost is charged pro-rata to *this batch* (same rule as today's `_ensureIdle`), the 5 bps fee stays with remaining holders, shares burned (↑), `claimableAssets += assets` (↓). Then status = Claimable.
- **Bounds:** `ids.length ≤ MAX_BATCH`; a single request whose assets > `maxSliceAssets` reverts `RequestTooLarge` at request time (users split; with `depositCap` 1,200 < slice 2,500 this never binds at launch). No loop over the queue anywhere; the keeper finds ids from events.
- **Cooldown (A-09):** `exitHedgeWithRoute`, `enterHedge`, `exitHedge`, forced paths: ≥ `MIN_FORCED_INTERVAL_BLOCKS` (10) since the last forced call (reuse `_lastRebalanceBlock`). Rule-based `rebalanceWithRoute` keeps its own gating. `emergencyUnwind` (Safe) is exempt.
- **A-07:** with the sync path idle-only, the "tiny redeem unwinds everything" case disappears; in fulfil, cap the unwind fraction at what the batch needs (never `f = WAD` because perp equity ≤ 0; revert `SlippageExceeded` instead and let the Safe use `emergencyUnwind`).
- **Hedger on 143:** deploy `KuruHedger` with `kuruMarket = address(0)` (Flow routes only), so an empty route fails loudly instead of hitting the dead market.
- **Rounding:** shares burned ↑, assets paid ↓, claimable tracked in token units, every formula commented.

### P5.3 Tasks
- P5.3a WS-00 commit: apply CR-014, regenerate ABIs, update `MockMeridianVault`.
- P5.3b Rewrite the A-01 acceptance tests (`test/review/ReviewA.t.sol`, ungate `REVIEW_A01_OPEN`) for the new API: route-only hedger, hedged vault ⇒ request → fulfil with a route → claim works; Safe `emergencyUnwind` flattens a hedged vault; empty-route paths revert clearly.
- P5.3c Unit (`test/unit/MeridianVault.t.sol` + new `MeridianVaultQueue.t.sol`): every new function and revert path; idle-only sync withdraw at the max never reverts; totalAssets excludes claimable; cancel returns the shares; double claim reverts; batch of 32; cooldown.
- P5.3d Fuzz: I8 (`convertToAssets(totalSupply) ≤ totalAssets`), I10 (deposit → request → fulfil → claim with no price move returns ≤ deposit), and "fulfil never changes the share price of non-redeemers by more than the slippage bound".
- P5.3e Invariant handler (`test/invariant/VaultInvariants.t.sol`): add request / cancel / fulfil / claim actions.
- P5.3f Fork test (`test/fork/KuruHedgerFork.t.sol` or new `VaultV2Fork.t.sol`, needs `MONAD_RPC_URL`): on a 143 fork, enter one slice and exit it with a **real Flow route** (`pnpm flow-quote`), then request → fulfil → claim. This is the evidence that A-01 is closed.
- P5.3g Keeper (B): fulfil loop: watch `RedeemRequested`, batch ≤ 32, fetch a Flow quote for the exact base the vault will sell (read it from a view, A-13), call `fulfillRedeems`, retry with a fresh quote on `RouteCallFailed`/`SlippageExceeded`, page after 3 failures; `/health` gains `pendingRedeems`, `oldestPendingBlocks`.
- P5.3h Indexer (C): the five events + `SCHEMA.md`. App (C): Earn shows "Instant up to X AUSD" and "Request withdrawal (usually < 1 min)", a pending list, and Claim.
- P5.3i `script/DeployVaultV2.s.sol` + `VerifyDeployment` checks (hedger has no direct market on 143, keeper registered, Safe owner, `skewCapacity` = 0 at deploy).
- P5.3j MATH_SPEC §5.6 "Withdrawals (v2)"; PHASES 39; STATUS.md: A-01 Closed, A-07 Closed, A-09 Mitigated, A-11 Closed.
- P5.3k PR `[WS-04] Vault v2: async withdrawals, routed exits, emergency unwind (A-01)`.

**Cut rule:** not green by **Fri 9 Oct 18:00** ⇒ no vault in the demo deployment, Earn = "roadmap: CR-014 implemented, fork-tested" in the write-up.

**Testnet note (PHASES 40):** 10143 has no live Kuru Flow route for MON/AUSD (`deployments/10143.json` lists `KuruHedger` as a mock; > VERIFY before assuming otherwise). On testnet the vault v2 hedges through the labelled mock hedger; the **real-route proof is the 143 fork test (P5.3f)**, which reads mainnet state and broadcasts nothing. The write-up states both.

---

## P6. Vault v2 on testnet + demo rehearsal · Sat 10 Oct

1. `DeployVaultV2` on 10143 against the P4 perp (`skewCapacity = 0`, `depositCap` 1,200 tAUSD, mock hedger labelled), `VerifyDeployment`, indexer + app repoint for the vault events.
2. Founders deposit; request → fulfil → claim from idle.
3. Owner key (testnet stand-in for the Safe) sets `skewCapacity = 0.8e18`; keeper enters one slice (rule-based if 8 h of funding history pays, else a **labelled** forced `enterHedge()` for the demo); `emergencyUnwind` half; request beyond idle → keeper fulfil → claim.
4. Full demo rehearsal on the frozen deployment: trade → per-block funding ticker → crash + liquidation → fix a rate with a swap → vault request/fulfil → `/rates` MFI. **Demo freeze 18:00.**

## P7. Users, benchmarks, write-up, submission · Sun 11 → Tue 13 Oct
- P7.1 STATUS.md and review-A/B statuses; MATH_SPEC amendments; RUNBOOK (mark bound, Skip semantics, fulfil loop, emergency unwind).
- P7.2 BENCHMARKS: B1/B2 (from P4.8), B4 reduced on testnet within the MON budget, B5/B9 from the hosted indexer if history allows.
- P7.3 Testnet users: invite testers to the testnet app; record only real, consented usage in `USERS.md` (testnet, labelled as such).
- P7.4 Write-up: product + "why only Monad" + Security (two reviews + this hardening, test names as evidence) + **Status: testnet; mainnet-ready (fork-rehearsed deploy, A-01 fork-proven), mainnet after the hackathon**. Demo video. Bounty forms only where the criteria fit a testnet product.
- P7.5 `HARDENING_LOOP.md` final report; submit well before Tue 13 Oct 18:00.

---

## Security self-review checklist (every phase, written into HARDENING_LOOP.md)
- CEI; `nonReentrant` on every function that moves tokens or calls out; `SafeERC20`; no `tx.origin`; no new `delegatecall`.
- Every loop bounded by a `MeridianConstants` constant; no iteration over users/orders/requests.
- Rounding direction per CONTRIBUTING.md §2, with a `// MATH_SPEC` comment on every formula.
- Custom errors and events only from the interfaces; no revert strings.
- Storage layout: `ClearingHouseLayout.t.sol` green; packed slots unchanged unless the phase says so.
- Conservation: I1 (perp), I9 (swap), I8/I10 (vault) at 256×128 before merge.
- Admin powers: nothing new without a bound; Safe-only for emergency paths.
- Gas: ceilings green; `forge snapshot --diff` reviewed and pasted into the PR.
- ABIs regenerated; every TS consumer typechecks.
