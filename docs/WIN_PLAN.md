# WIN_PLAN: the last 9 days (Sun 4 Oct → Tue 13 Oct 18:00)

Owner: A (lead). Written Sun 4 Oct 2026. Supersedes the task order in PHASES "Phase 5 plan update" where they differ; PHASES gates (G5, G6) and the hard rules in CLAUDE.md still apply.

**Goal:** win Track 01 (top 3) and contend for Grand Champion, with a product story an investor would fund.
**Strategy in one line:** ship mainnet **early (Thu 8 Oct)** so traction compounds for 5 days, and present Meridian as **the reference rate for Monad perps**, not as another perp.

---

## 1. Product vision (the story every artifact tells)

> **Perpl is where Monad trades perps. Meridian is where Monad trades the funding rate.**

A meridian is a reference line. Meridian is the reference **rate** for onchain perps: generated every block on a fully onchain order book, published as a public oracle, earned by a vault, fixed by swaps.

| Layer | What it is | Status 4 Oct |
|---|---|---|
| **Rate** | Per-block funding on an onchain CLOB (MON-PERP, AUSD) | ✅ built, testnet |
| **Oracle** | Public onchain realized funding APR (1h/8h/24h), any contract can read it | ✅ built, testnet |
| **Earn** | Basis vault: spot long + perp short, earns funding delta-neutral | ✅ built; A-01 route open |
| **Fix** | Funding swaps: lock a fixed funding rate for 30 days | ✅ built; B-01 open |
| **Index** | **Meridian Funding Index (MFI)**: per-block Meridian funding + Perpl's funding, one Monad rate | 🆕 this plan (offchain v0) |
| **Integrate** | Lending, structured products and other perps settle on MFI | Roadmap (Q1 2027) |

"Trade it, earn it, fix it: one rate, one engine" (PRD §7.1) stays the tagline. The index is the bridge from hackathon project to company: it makes Perpl a data source and partner, not a rival.

**Why only on Monad:** ~300 ms blocks make per-block funding cheap (O(1) funding first touch 29.3k gas, place+cancel 96.5k), so the rate is continuous and the swaps' floating leg settles every block from a rate generated onchain.

**Prior art we name honestly** (PRD §7.1 claims only): Perpl (hourly funding; PRD says ~43 min, > VERIFY), Pendle Boros and Rho (trade CEX funding imported via oracle), Kimia on Solana (perp + vault + PT/YT, hourly funding, devnet, raised $727k). Our difference: per-block funding generated onchain, a native public rate, swaps priced directly on that rate, live on mainnet.

**Business model (for the pitch, not built now):** perp taker fees, vault performance fee, swap fees; MFI free onchain, premium data/API later.

---

## 2. What wins (and what we optimise for)

The Track 01 rubric isn't pasted yet (HUMAN #9). Until it is, optimise for what every DeFi track judges: **working product on mainnet, technical depth, originality, real usage, demo quality.** Bounties are scored 40% on "adherence to the published bounty requirements" (per another team's reading of Rules §5.2), so we claim only what we meet.

| Prize | Amount | Claim? | What earns it |
|---|---|---|---|
| Track 01 Onchain Finance & Trading | $10k (top 3) | **Primary** | Both of the track's example ideas (onchain CLOB + per-block funding) + oracle + vault + swaps, live on mainnet |
| Grand Champion | $25k | **Contend** | Above + real users/fees + benchmarks + vision |
| Privy | $5k | **Yes** (decision 15) | Email login + embedded wallet; permit deposit = 1 signature |
| Perpl: Best use of Perpl's API | $5k | **Yes, via MFI** | Perpl funding read through their API, combined into MFI, shown and served by our API |
| Perpl: Best Analytics / Risk Tool | $3k | **Yes, via Rates & Risk page** | Cross-venue funding + liquidation-distance view + crash-demo data |
| Envio: Best Use of Envio | $1k | **Yes** | HyperIndex powers ticker history, oracle APR, vault NAV, swap book, MFI |
| Kuru: Consumer Trading App | $5k | Only if Kuru confirms (HUMAN #15) | Vault spot leg via Kuru Flow |
| Agora mobile, Chainlink CRE, Mera | — | **No** | Decisions 14/15; CRE dropped in Phase 4 |

Perpl claims are justified by the product (the index is core to the vision), not built only for the bounty. They change the BOUNTY_MAP rows for Perpl from "Not targeted" once a founder pastes Perpl's criteria and they fit.

---

## 3. The real bottleneck is people, not code

Claude sessions can write and test all of the code in parallel. They **cannot** fund wallets, create the Safe, buy an RPC, sign legal text, record a voice-over, or bring users. These gate everything; each has a hard deadline.

| # (HUMAN_CHECKLIST) | Item | Owner | **Hard deadline** |
|---|---|---|---|
| 9 | Paste Track 01, Privy, Envio, Kuru, **Perpl ×2** criteria into BOUNTY_MAP; confirm the official Agora text | C | **Mon 5 Oct 12:00** |
| 10 | Login decision (Privy recommended) + Privy app ID | owner, C | **Mon 5 Oct 12:00** |
| 2 | B and C added as GitHub collaborators | A | Mon 5 Oct |
| 5, 6 | Paid Monad RPC (mainnet + testnet), Pyth API key | B | **Mon 5 Oct** |
| 3, 4 | Safe 2-of-3 on 143; separate deployer/keeper/MM hot keys | B, all | **Tue 6 Oct** |
| 8 | Capital: MON for gas, IF seed 1–2k AUSD, MM 5–10k AUSD + MON, vault ≤ 1,200 AUSD, swap collateral | founders | **Wed 7 Oct** |
| 13, 14 | Docker on + Envio token (hosted indexer) | C | Tue 6 Oct |
| 16 | ToS + jurisdiction list signed by all three | all | **Wed 7 Oct** |
| 17 | Explorer verifier config | A | Wed 7 Oct |
| 18 | Owner's "go" for the mainnet broadcast | owner | **Thu 8 Oct 10:00** |
| — | Outreach list: each founder names 15 real people to onboard Thu–Sat | all | Wed 7 Oct |

If #3/#5/#8 slip past Wed, mainnet moves to Sat 10 Oct (the CP3 backstop) and the traction targets shrink. That's the single biggest risk to winning.

---

## 4. Day-by-day (lanes run as parallel Claude sessions in separate worktrees)

Rule: every day ends with a **demoed gate** written to `docs/standup/<A|B|C>.md`. Contract code freeze **Thu 8 Oct 18:00**; after that, only offchain code, ops and content.

### Mon 5 Oct: merge + fix the Highs
- **A:** merge B's 5 branches (`ws-04b-sec-fixes`, `ws-03i-review-b`, `ws-03j-oracle-params`, `ws-03i-kuru-flow`, `ws-03k-paging`) + `ws-00h-review-a`; full `forge test` + invariants. Decide **A-01**: CR-010 route fix vs launch the vault idle with `NEXT_PUBLIC_VAULT_ROUTE_PENDING` (lead leans CR-010 if it's ≤ 1 day, else idle launch).
- **B:** fix **B-01** (swap `markApr` atomic manipulation: TWAP/last-block mark or a per-block bound), PoC must flip to failing-exploit.
- **C:** Pulse → **Meridian** rename across app (header, manifest, title, terms, OG image); start Privy login.
- **New lane D (Claude session, offchain only):** MFI v0 design note `docs/MFI.md` + Perpl API client (read funding, mark, OI) with vitest against recorded fixtures. > VERIFY: Perpl API base URL and endpoints from Perpl's official docs; never guessed.
- **Gate:** main green with all branches merged; B-01 PoC fails; app says Meridian.

### Tue 6 Oct: A-01 + login + index
- **A:** A-01 fix merged (or idle-launch decision recorded), cross-reviewed by B; update `143.json` (oracle 3%/60 s, caps).
- **B:** keeper/MM against paid RPC; B7 ≤ 3 and the 1 h unattended run on testnet (closes G3).
- **C:** Privy live on testnet (email → embedded wallet → permit deposit, 1 signature); **desktop layout** (≥ 1024 px: book + order form side by side, top nav; phone layout unchanged).
- **D:** MFI v0 service: computes Meridian per-block rate + Perpl rate → index (weights by OI, documented in MFI.md); public read-only JSON API; Envio entity for MFI history.
- **Gate:** all Highs closed with tests; Privy login → first trade ≤ 4 taps on testnet; MFI API returns both venues.

### Wed 7 Oct (CP2): rehearse mainnet
- **A:** mainnet-fork rehearsal of `DeployPulse` with the real Safe; crash demo on the fork → per-block CSV (NAV, markApr, IF for 20 blocks).
- **B:** mainnet runbook dry-run on the fork: seed IF, MM inventory, vault; keeper/MM on fork; alerts paging live.
- **C:** **Rates & Risk** page (MFI chart Meridian vs Perpl, liquidation-distance histogram, insurance fund); hosted Envio on testnet; Lighthouse ≥ 80 phone + desktop.
- **D:** benchmark B3/B4 with the paid RPC; regenerate `BENCHMARKS.md`.
- **Gate (G4 closed):** fork deploy passes the full smoke; crash CSV produced; every demo-script segment works on testnet.

### Thu 8 Oct: MAINNET DAY
- 10:00 owner "go" → A broadcasts `DeployPulse` (caps on, owner = Safe), verifies contracts, writes `deployments/143.json`.
- B seeds IF + MM + vault, starts keeper/MM; C points app + indexer at 143 and deploys the site.
- 14:00 founders' first trades (excluded from user counts); 15:00 outreach wave 1 starts.
- **18:00 contract code freeze.**
- **Gate:** first external user trade + deposit onchain; app + indexer live on 143.

### Fri 9 Oct: traction
- Outreach wave 2 (founders' 45 names, Monad Discord/X thread, hackathon peers testing each other's apps). Onboarding per `docs/outputs/ONBOARDING.md`; record every user in `USERS.md` (real users only, consent for addresses).
- Ops: watch alerts, MM health, oracle staleness; fix only offchain issues.
- C: metrics dashboard on 143 (users, volume, fees, TVL, swap OI, MM share).
- D: MFI on mainnet (Meridian 143 + Perpl mainnet).

### Sat 10 Oct (CP3): G5
- **Gate G5:** ≥ 5 external users (target ≥ 25), first fees onchain, vault deposits, at least one swap by an external user.
- Record the crash demo (fork, labelled) and the √τ chart. Draft `WRITEUP.md`.

### Sun 11 – Mon 12 Oct: proof
- Demo video per DEMO_SCRIPT, updated: 0:00 open with "the reference rate for Monad perps"; add a 10 s MFI segment (Meridian vs Perpl) after the oracle card; end on mainnet metrics + "Live on Monad".
- `WRITEUP.md` (PRD §7.1 claims only), project profile, investor-grade 1-page vision (section 1 of this file), bounty forms with demo timestamps.
- Keep onboarding users; refresh metrics daily.

### Tue 13 Oct: submit by 15:00 (3 h buffer before 18:00)
- Final metrics snapshot into WRITEUP + video end card; every hard acceptance criterion linked to evidence (G6).

---

## 5. Targets (PRD §6, adjusted for the 1,200 AUSD vault cap)

| Metric by 13 Oct | Minimum (G5) | Target |
|---|---|---|
| External wallets that traded or deposited | 5 | **50** |
| Perp volume (MM share disclosed) | first trade | $250k |
| Swap notional | 1 external swap | $50k |
| Fees onchain | > $0 | $100 |
| Vault TVL | first deposit | 1,200 AUSD cap filled |
| Uptime keeper/MM since launch | — | ≥ 99% with alerts evidence |

No wash trading, no paid fake users, no inflated claims: judges check onchain, and one false number costs more than a small true one.

---

## 6. Cut order if behind (in this order; never cut the last line)

1. Perpl Analytics/Risk page → keep MFI API only
2. Desktop layout → phone layout centred (works today)
3. MFI → mention as roadmap with Perpl rate shown offchain in the video only
4. Privy → injected wallet (lose the Privy bounty)
5. Vault on mainnet → launch idle with "Waiting for route" (A-01 fallback)
6. Mainnet Thu → Sat 10 Oct

**Never cut:** both Highs fixed, per-block funding, funding oracle, mainnet launch, benchmarks, crash demo, honest metrics.

---

## 7. After 13 Oct (investor track, short form)

Week 1: post-mortem, audit quotes, incorporate, founder vesting. Week 2: grants (> VERIFY open Monad programmes), 10-slide deck from WRITEUP + benchmarks. Weeks 3–4: MFI onchain publisher, BTC/ETH markets, multiple swap maturities, 2–3 integration partners (MFI as settlement rate), weekly public metrics. Raise pre-seed on traction + index adoption; token only after product-market fit.
