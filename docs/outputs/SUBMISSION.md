# Submission pack: Meridian (Monad Metropolis)

Submit by **Tue 13 Oct 2026, 15:00** (hard deadline 18:00). Repo: `github.com/SamyaDeb/meridian` (MIT; must be public at submission: **OWNER**). App: https://meridian-testnet.vercel.app (Monad testnet 10143). Demo video: > VERIFY: link after the Sun 11 recording (`docs/DEMO_SCRIPT.md`).

**Ground rules for every block below.** Every number is from `docs/outputs/PROOF.md` (section named), a test, or a tx. Testnet is labelled testnet. Operators (deployer, keepers, market makers, house flow, the demo victim, our test wallets: `docs/outputs/test-wallets.json`) are never users. "Met" is our self-check against the pasted criteria. Until a block's criteria are pasted, every line says **pending**.

Prize names and amounts come from the public listing (monad.xyz/metropolis, 29 Sep 2026, `BOUNTY_MAP` in the team repo) unless marked > VERIFY. The detailed criteria sit behind the login at hackathon.monad.xyz: **OWNER pastes each block verbatim** where it says `> VERIFY: paste criteria`.

PRs: #1 Privy (merged), #2 Envio (merged), #3 Rates & Risk (open), #4 CRE (merged), #5 Perpl hedge (open), and the submission PR from this branch (open). PROOF §12 and §14 live on #5 and #3 until they merge.

---

## 1. Track 01: Onchain Finance & Trading ($30,000 split among 3 teams)
**What we built.** A perp on Monad with a **fully onchain order book** (no offchain matcher) and **funding settled every block** (both are the track's own example ideas). On top of it sit a public funding-rate index (the MFI, onchain via CRE), a basis vault (floating yield, with a withdrawal queue) and funding swaps (fixed yield) that settle from the same funding index.
**Why it makes the perp better.** Funding accrues per 300 ms block instead of in 8-hour jumps: no funding sniping around a timestamp, and margin that tracks funding continuously. The yield layers turn the funding rate into products: hedge it, earn it, fix it.
**Evidence.** PROOF §1 (per-block funding on the onchain book), §2 (funding-rate oracle), §3–§6 (audit fixes: mark bounds, Skip, bad-debt waterfall, liquidation + unwind within blocks), §7 (vault v2 and the A-01 mainnet-fork test with real Kuru Flow routes), §8 (mainnet-ready by rehearsal, live on testnet), §9 (invariants and test depth), `docs/outputs/BENCHMARKS.md`. Earn queue in the app: `app/e2e/earn-queue-anvil.spec.ts` (anvil). Users: `docs/outputs/USERS.md` (from `indexer/scripts/users-report.mjs`, operators and test wallets excluded): > VERIFY: fill from the hosted indexer.
**Demo:** 0:12–0:55 (login, trade, per-block funding), 1:55–2:45 (Earn queue, Fix), 2:45 (metrics).
**Not claimed:** a mainnet deployment (rehearsed on a fork only), external fees or volume beyond what USERS.md shows, B4 parallel-market load (not run).

> VERIFY: paste criteria (Track 01: judging criteria, weights, submission requirements)

| Criterion (verbatim, one per row) | Met / not met | Where |
|---|---|---|
| pending | pending | |

## 2. Grand Champion ($25,000)
**What we built.** The Track 01 entry above, judged across tracks: one product with the perp, the index, the vault and the swaps, plus the integrations that make it better: Privy onboarding, Envio data layer, Chainlink CRE backstop, Perpl hedging and Perpl risk analytics.
**Evidence.** As Track 01, plus each sponsor block below. Test depth: PROOF §9. Security: two internal cross-reviews (`docs/outputs/security/`), status per finding in `STATUS.md`.
**Demo:** the whole 3:00.

> VERIFY: paste criteria (Grand Champion)

| Criterion | Met / not met | Where |
|---|---|---|
| pending | pending | |

## 3. Perpl: Best API usage (> VERIFY: prize amount)
**What we built.** Meridian's market maker hedges its leftover inventory on Perpl's MON perp through Perpl's authenticated trading API. It uses Ed25519 API-key auth (signed REST + the `mt: 29` WebSocket sign-in) and IOC orders over the trading WebSocket with a signed REST fallback. Outcomes are taken only from Perpl's streams, with reconcile after reconnect, a rate limiter, and testnet-only guardrails with a kill switch and circuit breaker. The MFI reads Perpl's funding live over the market-data WebSocket and publishes the Meridian–Perpl funding spread.
**Why it makes the perp better.** An unhedged maker goes one-sided as inventory builds. Hedged, it quotes on its net delta and keeps both sides of Meridian's book.
**Evidence.** PROOF §12 (PR #5), testnet 7 Oct, two 30-minute halves, same house flow: time one-sided **46.6 % → 8.4 %**, depth within ±1 % **5.3/2.7 → 6.9/4.8 lots**, |net delta| p90 **2,500 → 500 MON**. Two hedges, both filled, read back from Perpl's `GET /v1/trading/fills` (account 969): orders `4525679575056` (2,000 MON) and `4525855211536` (600 MON). The inner spread was **wider** in the hedged half (p50 5.41 → 6.96 bps; realized volatility was higher), so we don't claim a tighter spread. Small sample (not the ≥ 1 h we planned). Tests: `mm-bot/test/{perpl-auth,perpl-trading,hedge}.test.ts`, `mfi/test/ws.test.ts`.
**Demo:** 1:15–1:35.

> VERIFY: paste criteria (Perpl API)

| Criterion | Met / not met | Where |
|---|---|---|
| pending | pending | |

## 4. Perpl: analytics / risk tool (> VERIFY: exact prize name and amount)
**What we built.** Rates & Risk (`/rates`): Meridian vs Perpl funding (now, realized 1 h / 8 h / 24 h / 7 d, spread, countdown, net carry after both taker fees), and a position monitor that reads any Perpl position onchain and computes its liquidation price with **Perpl's own margin rule** (from Perpl's SDK), with alerts (`keepers/alerts`).
**Why it makes the perp better.** Traders see which venue pays funding and how close a position on either venue is to liquidation, from one screen.
**Evidence.** PROOF §14 (PR #3): account 969 (testnet) liquidation **0.02239**, mainnet account 1076 **0.018084**; maintenance read from the exchange (`getMarginFractions`); rounding against the trader asserted in `risk/test/perpl.test.ts`; Lighthouse mobile 97 / 100 / 96. Open: the side-by-side with Perpl's UI or `perpl-cli` (**OWNER**, PROOF §14 > VERIFY).
**Demo:** 1:35–1:55.

> VERIFY: paste criteria (Perpl analytics)

| Criterion | Met / not met | Where |
|---|---|---|
| pending | pending | |

## 5. Privy ($5,000)
**What we built.** Privy is the app's only login (email, passkey, Google or an external wallet) with embedded wallets and **native gas sponsorship on Monad testnet**, so a new user goes from email to a filled order with **0 MON**.
**Why it makes the perp better.** Onboarding is a perp's worst step (wallet, gas, collateral). Here it is email → one tap for test AUSD + deposit → first order.
**Evidence.** PROOF §10: fresh Privy user on testnet, **5 taps, 22.6 s, 0 MON before and after**, four sponsored txs (`0x8f5f…200c` mint, `0x0f86…4550` approve, `0xa13b…804b` deposit, `0x70d7…698c` market long); anvil e2e 4 taps / 19.6 s; `app/src/lib/{sponsor,tx}.test.ts`.
**Demo:** 0:12–0:32.

> VERIFY: paste criteria (Privy)

| Criterion | Met / not met | Where |
|---|---|---|
| pending | pending | |

## 6. Envio: Best Use of Envio ($1,000 + hosting credit for track winners)
**What we built.** HyperIndex is Meridian's data layer and computes what traders read: realized funding APR windows (equal to the contract's `averageFundingApr`), funding paid per account, the insurance-fund waterfall, daily stats with operators excluded, and the vault withdrawal queue. The same indexer follows Perpl's exchange on testnet and on mainnet (multichain).
**Why it makes the perp better.** History, Stats, the Earn queue and the cross-venue funding chart come from one GraphQL endpoint, not the browser's RPC window.
**Evidence.** PROOF §11; `indexer/PERPL_EVENTS.md`, `indexer/SCHEMA.md`; tests `pnpm -C indexer test`. Hosted numbers (sync time, lag, query latency) for the **current** deployment: > VERIFY after the K2 hosted deployment (**OWNER**; the hosted URL used so far indexes the old v1 contracts, `TESTNET_GUIDE.md` §4).
**Demo:** 2:45–3:00 (`/stats` as of block N), `/rates` cross-venue chart.

> VERIFY: paste criteria (Envio; HyperIndex vs HyperSync, hosted requirement?)

| Criterion | Met / not met | Where |
|---|---|---|
| pending | pending | |

## 7. Chainlink: Best workflow with CRE ($3,000)
**What we built.** Three CRE workflows act as a keeper backstop that doesn't depend on our TS process. W1 is the liquidation guardian: it liquidates, then unwinds. W2 handles upkeep (funding poke, vault rebalance dry-run). W3 publishes the Meridian Funding Index onchain (`MeridianMfiFeed`). All three report into one receiver that isolates failures.
**Why it makes the perp better.** A perp is only as safe as its keeper. Liquidations and funding continue if the TS keeper dies.
**Evidence.** PROOF §13: funding pokes, 4 MFI publishes matching our API, 4 liquidations + 4 unwinds of a labelled test wallet on the demo market (e.g. `0xe650…eb34` / `0x529d…fa82`). **Exactly what ran:** `cre workflow simulate --broadcast` through Chainlink's simulation forwarder, **not a DON** (deployment access not granted). Latency 9–13 blocks vs 4–5 for the TS keeper (BENCHMARKS B7).
**Demo:** 0:55–1:15.

> VERIFY: paste criteria (Chainlink CRE; is simulation acceptable or is a deployed workflow required?)

| Criterion | Met / not met | Where |
|---|---|---|
| pending | pending | |

## 8. Alchemy (> VERIFY: is there an Alchemy prize, and are we eligible?)
We use Alchemy's free-tier RPC for bots on testnet (`keepers/RUNBOOK.md`, RPC notes). That is a dependency, not a product feature built on Alchemy. Claim only if the pasted criteria fit what we actually use; otherwise list it under "not claimed".

> VERIFY: paste criteria (Alchemy) or drop this block

---

## Not claimed
Agora (requires trades through Perpl and a Mera login), Mera (not our login), Kuru (the testnet vault uses a labelled mock hedger; real Kuru Flow routes run only on a mainnet fork), CRE on a DON (simulation only), mainnet deployment, parallel-market load (B4).

## Owner checklist before submitting
- [ ] Paste every criteria block verbatim above, then fill each "met / not met" row honestly.
- [ ] Merge #3, #5 and the submission PR (in that order; PROOF/WRITEUP merge carefully).
- [ ] Hosted K2 indexer for the current deployment → `NEXT_PUBLIC_INDEXER_URL`; record `users-report.mjs` into `docs/outputs/USERS.md`.
- [ ] Vercel production env + `/api/health` `ready: true` + `prod-smoke.spec.ts` green (`TESTNET_GUIDE.md` §4).
- [ ] MON for the tester windows and the recording (`TESTNET_GUIDE.md` §5).
- [ ] Record the video on Sun 11; put the tx hashes of every "TBD at recording" step into PROOF and the timestamps here.
- [ ] Flip `SamyaDeb/meridian` public; fill each sponsor form; demo link in every block.
