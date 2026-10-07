# TEAM_PLAN: 3 founders, 15 days, one product

> Paths under `docs/standup/` and `docs/prompts/` cited below are the team's working logs, kept in the private development repository.

**Meridian = Monad's funding-rate layer.** Per-block funding perp → public funding-rate oracle → floating yield (basis vault) → fixed yield (funding swaps).
**Track:** 01 Onchain Finance & Trading (+ Grand Champion, automatic). **Deadline:** Tue 13 Oct, submit by 18:00.
Specs: PRD · ARCHITECTURE · MATH_SPEC · INTERFACES · MILESTONES. This file covers who does what, when, and how you work together.

## 1. Lanes (one founder = one lane; each runs 2–3 Claude Code sessions)

| | **Founder A: Samya** | **Founder B** | **Founder C** |
|---|---|---|---|
| Lane | Core protocol | Liquidity & automation | Product & growth |
| Workstreams | WS-01 order book · WS-02 clearinghouse + funding + oracle · WS-05 funding swaps · WS-00 (interfaces, CRs, merges) | WS-03 oracle adapter + TS keeper + MM bot (+ CRE) · WS-04 vault + Kuru hedger · mainnet ops | WS-06 indexer · WS-07 PWA · WS-08 benchmarks/demo/write-up · users & bounties |
| Parallel sessions | D1–4: WS-01 + WS-02 · D5–9: WS-05 + fixes | D1–4: WS-03 · D4–9: WS-04 + WS-03 · D10+: ops | D1–4: WS-06 + WS-07 · D8+: WS-08 bench + demo |
| Cross-reviews | B's contracts (vault, hedger, oracle, receiver) | A's contracts (OB, CH, swaps) | Frontend math vs MATH_SPEC; runs every benchmark |
| Owns decisions on | math, interfaces, risk params | keeper/MM behaviour, mainnet keys, capital deployment | UX, copy, what goes in the demo, bounty choices |
| If blocked, hands off | WS-05 → B after CP1 if WS-01/02 slip | CRE → dropped | Envio bounty polish → dropped |

Skills swap: if B is the stronger frontend engineer and C the stronger Solidity engineer, swap WS-04 ↔ WS-07 and keep everything else.

**Lane D: WS-09 MFI (Meridian Funding Index), added 4–5 Oct (CR-013, owner decision D8).** Owned paths: `mfi/` (`@meridian/mfi`: Perpl client + index service, in `pnpm-workspace.yaml`), `docs/MFI.md`, `docs/mfi/`, `docs/outputs/MFI_HOSTING.md`. Offchain only, read-only; it never touches `contracts/src`. Consumers: the app's `/rates` page (`NEXT_PUBLIC_MFI_URL`, WS-07).

## 2. Critical path (what blocks whom)

```
D1  WS-00 tag interfaces-v1.1 ─┬─> WS-01 OB ──┐
                               ├─> WS-02 CH ──┼─> CP1 (D5): trade → per-block funding → liquidation (testnet)
                               ├─> WS-03 oracle ┘            │
                               ├─> WS-06/07 on mocks          ├─> WS-05 swaps (A) ──┐
                               └─> WS-08 √τ chart             └─> WS-04 vault (B) ──┼─> CP2 (D9): full stack testnet
                                                                                     └─> CP3 (D12): mainnet + users
```
The critical path is **WS-01 + WS-02 (Founder A)**. Everything else builds on mocks until CP1. A does not take meetings on Days 1–4.

## 3. Operating rhythm

| When | What | Who | Output |
|---|---|---|---|
| Daily 09:30, 15 min | Standup: yesterday / today / blocked, against MILESTONES targets | all | 3 lines each in `docs/standup/<A|B|C>.md` (append) |
| Daily 10:00 + 18:00 | CR triage; merge window (rebased, green PRs only) | A | merged PRs, updated tag if CR applied |
| Within 4 h of PR open | Cross-review (§1 matrix). Nobody merges their own contract PR | reviewer | approve / request changes |
| Daily 21:00 | Deploy `main` to testnet (script), run the smoke script | B | `deployments/10143.json` updated |
| Checkpoint days 5 / 9 / 12 | Gate review: every exit criterion demoed live, else a fix-only day | all | go / no-go in docs/standup/<you>.md |
| From Day 5, daily | User pipeline update (contacts, onboarded, active) | C | `docs/outputs/USERS.md` |

Rules:
- **Scope freeze at CP2 (Day 9).** After it: bug fixes, UX, ops only. No new features.
- **Code freeze Day 12 18:00** for contracts on mainnet. After it: frontend, indexer, docs only.
- Any change to `contracts/src/interfaces/**` → CR (see CHANGE_REQUESTS.md). A applies it the same day.
- A red `main` stops merges until it's fixed (whoever broke it fixes it first).

## 4. Day-by-day per founder

| Day | A: Samya (protocol) | B (liquidity & automation) | C (product & growth) |
|---|---|---|---|
| 1 Tue 29 Sep | WS-00: commit, tag, CI. Launch WS-01 + WS-02 sessions | Day-1 accounts (§6). WS-03 oracle adapter tests-first | Read bounty criteria logged in. WS-06 schema + WS-07 shell (Privy) |
| 2 Wed 30 Sep | OB bitmap, place/cancel · FundingLib + MarkPriceLib | Oracle adapter + fork tests (Pyth, Chainlink) | Indexer handlers on mock events; trade screen (mock) |
| 3 Thu 1 Oct | OB matching + hooks · CH accounts, funding touch, G index, oracle buffer | TS keeper: funding poke, liquidation scan, Pyth push | Positions + per-block funding ticker |
| 4 Fri 2 Oct | OB gas pass · liquidation + IF + factory | MM bot (A–S) on anvil; WS-04 starts on mocks | Vault screen (mock); ToS + geoblock page |
| **5 Sat 3 Oct** | **CP1 gate** · integration fixes | Deploy to testnet; MM + keeper running | App on testnet reading indexer; start user outreach |
| 6 Sun 4 Oct | WS-05 swaps: accrual + margin (tests first) | Vault on real CH/OB; skew rule; Kuru hedger direct route | Swap "Fix" screen (mock); benchmark harness B1/B2 |
| 7 Mon 5 Oct | Swaps: book integration, mark, liquidation | Kuru Flow route (CR-002) fork test; CRE receiver if access granted | Wire indexer for vault/swap entities |
| 8 Tue 6 Oct | Swaps: maturity; handlers for invariants | Vault withdraw path; MM quotes swap book | Invariant harness with A/B handlers; B4 load-test script |
| **9 Wed 7 Oct** | **CP2 gate: scope freeze** | Full stack on testnet, keeper-driven | Demo dry-run on testnet |
| 10 Thu 8 Oct | Invariants I1–I11 green; review B's contracts | Mainnet config, Safe, keys, capital; CRE workflows live on testnet | Mobile polish, PWA install, copy |
| 11 Fri 9 Oct | Mainnet-fork rehearsal (deploy + crash demo) | Monitoring + incident runbook | Benchmarks on testnet; onboarding kit for users |
| **12 Sat 10 Oct** | **CP3: mainnet deploy (caps)** · code freeze 18:00 | Seed IF + MM inventory; bots live; vault seeded | Onboard first users; indexer on mainnet |
| 13 Sun 11 Oct | Bug fixes only; √τ + benchmark numbers review | Ops, liquidity, keep funding healthy | Benchmark report, metrics dashboard |
| 14 Mon 12 Oct | Write-up (technical sections) | Record crash demo on fork, live metrics | Video edit, project profile, bounty forms |
| 15 Tue 13 Oct | Final review | Final review | **Submit by 18:00** |

## 5. Definition of done (every PR)
- [ ] Only owned paths touched; interfaces unchanged (or CR applied)
- [ ] Tests listed in the WS doc exist and pass; rounding direction asserted in fuzz tests
- [ ] No unbounded loop; CEI + nonReentrant on value flows; custom errors; events per interface
- [ ] Gas snapshot updated for hot paths (OB, CH)
- [ ] Cross-reviewed by the matrix reviewer
- [ ] Docs touched if behaviour changed (MATH_SPEC section referenced in code comments)

## 6. Day-1 external checklist (only humans can do these)

| # | Task | Owner | Why |
|---|---|---|---|
| 1 | Log in to hackathon.monad.xyz; paste **verbatim** criteria for Track 01, Agora mobile, Mera, Envio, Chainlink, Kuru into `docs/BOUNTY_MAP.md` | C | Our judging weights come from a third-party repo (unverified); Agora may require Mera/native |
| 2 | Paid Monad RPC (Alchemy or QuickNode) for bots + app | B | Public RPC: 25 rps, `eth_getLogs` capped at 100 blocks |
| 3 | **Pyth API key** (Hermes requires one since 26 Aug) | B | Keeper price pushes. Fallback: sponsored push every 10–30 s |
| 4 | Request **Chainlink CRE deploy access** | B | Deploy is gated; if not granted by Day 7, drop CRE |
| 5 | Envio API token (HyperSync) | C | Indexer |
| 6 | Privy app (Monad 143 + 10143) | C | Login |
| 7 | **Safe 2-of-3** on Monad (canonical Safe `0x69f4…2938`) as protocol owner; separate hot keys for deployer, keeper, MM | B | Real product: no single-founder key controls funds |
| 8 | Capital plan: gas MON; IF seed 1–2k AUSD; MM inventory 5–10k (AUSD + MON); vault seed | all | Liquidity is what makes it "real" |
| 9 | Ask Kuru whether a vault swapping via Kuru Flow counts for "Consumer Trading App on Kuru" | C | Decides whether we claim that bounty |
| 10 | Draft ToS + restricted-jurisdiction geoblock (perps are regulated in many places) | C | Market-grade launch |

## 7. Mainnet operations (Founder B owns)
- Owner = Safe 2-of-3. Pause = Safe (fast path: any 2 founders).
- Launch caps: perp OI 250k MON/side, position 25k MON; vault 10k AUSD; swaps 2M MON notional/side.
- Monitoring (alert to all 3): oracle staleness > 30 s; funding not updated > 100 blocks; IF balance drop > 20%; vault margin ratio < 30%; keeper balance < 5 MON; indexer lag > 30 s.
- Incident runbook (`keepers/RUNBOOK.md`): pause → reduce-only → communicate → post-mortem.

## 8. Kickoff
**Use the lane prompts in `docs/prompts/`** (one session per founder, one worktree each; setup in `docs/prompts/README.md`). The per-WS kickoff prompts inside each WS doc are for extra parallel sessions within a lane.

Order:
- **Day 1, Founder A:** WS-00 → (after tag) WS-01 and WS-02 in two sessions.
- **Day 1, Founder B:** WS-03.
- **Day 1, Founder C:** WS-06 and WS-07 in two sessions; WS-08 √τ chart (short session).
- **Day 4, Founder B:** WS-04.
- **Day 6, Founder A:** WS-05 (swaps).
