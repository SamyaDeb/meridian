# Meridian: Monad's funding-rate layer

*Monad Metropolis · Track 01 Onchain Finance & Trading · draft 7 Oct 2026 (submission by Mon 12 Oct). Every number here is traceable in [`PROOF.md`](PROOF.md) or [`BENCHMARKS.md`](BENCHMARKS.md). Status: **live on Monad testnet; mainnet after the hackathon.***

## The problem
Perpetual funding is paid every 1–8 hours because the chains and venues that set the convention were slow. Hourly funding is a countdown, not a price: a position opened a minute before the tick pays a full period, and the rate everyone quotes is a stale average. There is also no onchain funding *rate* that other protocols can read: anyone who wants to earn the basis or fix their funding cost has to import a CEX number through an oracle and settle per period.

On Monad, blocks are ≈ 300 ms (measured 300–304 ms on testnet in our bench runs). Funding can be continuous, and the rate can be a public onchain primitive.

## The product: trade it, earn it, fix it, one rate, one engine
- **Trade it.** MON-PERP on a **fully onchain order book** (no offchain matching engine), isolated margin up to 5x, collateral AUSD. **Funding accrues every block** through O(1) cumulative indices; mark = median of index-implied, book mid and last trade, with the book-driven premium rate-limited per block. Liquidations, an insurance fund, and a bad-debt waterfall in which protocol fees are junior to users.
- **The oracle.** The clearinghouse is a **public funding-rate oracle**: `averageFundingRate(blocksAgo)` / `averageFundingApr` = ΔF / ΔG over any window, `observe`, `latestObservation`. Any Monad contract can read the realized funding rate, without importing it. The app's `/rates` page (Meridian Funding Index) shows realized 1 h / 8 h / 24 h APR.
- **Earn it.** A basis vault (ERC-4626 + an ERC-7540-style queue): spot MON plus a short perp, sized by the net long skew, so depositors earn the floating funding. Small exits are instant from idle; larger ones are queued, priced at NAV, and fulfilled by the keeper with a routed spot sale, and the batch pays its own unwind, so remaining holders aren't diluted. The owner (a Safe on mainnet) can `emergencyUnwind`.
- **Fix it.** 30-day fixed-for-floating funding swaps on Meridian's own order book (price = 1 + APR). The floating leg settles from the same per-block funding index; traders lock their funding cost, yield seekers lock a fixed rate.

## Why only Monad
1. **Risk scales with √τ.** Margin has to cover the price move over the time τ before risk can be re-assessed: z·σ·√τ. At σ = 100%: one Monad block (τ = 0.3 s) needs 0.029%, an 8-hour funding interval 9.066% (BENCHMARKS B6, `bench/sqrt_tau.py`, MATH_SPEC §3.4). Here funding, mark and liquidation eligibility all update every block. (Honesty caveat from MATH_SPEC §3.4: continuous-liquidation venues elsewhere have τ = keeper latency, not the funding interval.)
2. **Per-block funding is cheap enough to run every block.** The clearinghouse's first funding touch in a block costs **29,452 gas** (asserted < 30,000; 29,867 with the mark bound active; 30,168 on the 1-in-200 checkpoint block). Place + cancel on the onchain book costs **96,484** (< 100,000). Foundry, Cancun schedule; Monad testnet receipts are higher because MIP-8 prices cold storage pages and Monad bills the gas *limit*: BENCHMARKS B1 shows execution estimate vs billed limit per op.
3. **Measured latency.** On testnet a −15% oracle update was followed by the leveraged long's liquidation **4–5 blocks** after it became eligible (≈ 1.5 s; three runs on the current deployment with the keeper on a free-tier RPC; 8 blocks on the earlier deployment over the public RPC; 1 block on a local node, BENCHMARKS B7). The keeper then closed the position it inherited **7 blocks** later. Our ≤ 3-block target needs a paid RPC for the keeper; we report the miss rather than hide it.

## Architecture
```
            Pyth MON/USD (mainnet) ──► OracleAdapter (testnet: keeper-fed TestnetKeeperOracle)
                                            │ index
 traders / MM bot ──► OrderBook (CLOB) ──► ClearingHouse ── funding every block (O(1) F, G indices)
                       fills, Skip/Evict      │   │  mark = median(index·(1+premium), mid, last), premium ≤ 10 bps/block
                                              │   ├─► IFundingRateOracle: averageFundingRate / observe  ──► anyone
                                              │   ├─► InsuranceFund ◄── liquidation penalties; bad debt: IF → fees → uncovered
 keeper (TS) ── oracle push, funding poke, ───┘   │
   liquidations sized to headroom + reduce-only    ├─► FundingSwapMarket + swap OrderBook (fixed vs floating, settles on F)
   unwind, vault fulfil/rebalance                  └─► MeridianVault v2 (idle AUSD + KuruHedger spot + short perp; request/fulfil/claim queue)
                                                              └─► Kuru Flow routes for the spot leg (mainnet)
 Envio HyperIndex ◄── events ──► Next.js PWA (Privy login when configured): Trade · Earn · Fix · Rates · Stats
```
Contracts are non-upgradeable (Solidity 0.8.28, Cancun). Every loop is bounded by a constant; no global iteration over users, positions or orders.

## Security
Two internal cross-reviews (each founder reviewed the other's contracts: [review-A](security/review-A.md), [review-B](security/review-B.md)), then a hardening pass on our own 6 Oct audit (P1–P7). Status ([STATUS.md](security/STATUS.md)):

| Finding | Status | Evidence |
|---|---|---|
| A-01 vault forced exit needs a route (High) | Closed: queue + routed fulfil + emergency unwind | fork test with live Kuru Flow routes; testnet request → fulfil → claim |
| B-01 swap mark manipulation (High), B-02 (Medium) | Closed | PoCs fail before, pass after |
| H-1 keeper inherits liquidated positions (High) | Closed (offchain): sized liquidations + reduce-only unwind | `unwind.test.ts`; testnet txs |
| M-1 one-block mark manipulation | Closed: premium bound | PoC: +5% in one block before, +10 bps after |
| M-2 paused market evicts makers | Closed: CR-007 Skip | testnet `MakerFillSkipped` |
| M-3 bad debt before fees | Closed: IF → fees → uncovered | fuzz + invariants (128 / 112 waterfall hits) |
| H-3 ported frontend commit (process) | Closed: clean-room rewrite | not in this history; chart bars rewritten from [CHART_TOPBAR_SPEC.md](CHART_TOPBAR_SPEC.md) |
| Lows / infos (A-08, A-09 partial, A-12, B-03…B-15), no ADL | Open, listed | STATUS.md |

Tests: **499** Foundry tests (unit, fuzz, invariants I1–I11 at 256 × 128; all invariant suites also green at 512 × 256 with coverage counters proving the liquidation, bad-debt, skip and queue paths ran), 10 mainnet-fork tests, ≈ 800 TypeScript tests (keeper, MM, indexer, app, bench).

## Status and roadmap
**Now (testnet 10143):** perp + order book + funding oracle, funding swaps, the vault v2 (with a labelled mock hedger: Kuru has no testnet market), a labelled crash-demo market, keeper + market-maker bots, indexer, PWA. Demo deployment frozen 7 Oct. **Mainnet-ready by rehearsal:** the deploy scripts run end to end on a mainnet fork and pass `VerifyDeployment` 52/52 (perp + swaps) and 56/56 (with vault v2, Flow-only hedger), and A-01 is proven on a mainnet fork with live Kuru Flow routes (scope: spot leg real, perp leg our contracts on the fork, index pinned to the Kuru mid, funding mocked for the entry rule).

**After the hackathon:** mainnet with a Safe owner and dedicated keys on a paid RPC (≤ 3-block liquidations); auto-deleveraging for debt beyond the insurance fund and fees; reduce-only trigger orders (stop-loss / take-profit, CR-012); an ETH-PERP market; swap-market bad-debt event parity; external user onboarding with the risk disclosure.

We don't report users, volume or fees: none are on mainnet yet, and testnet activity so far is our own bots and labelled test wallets.

## Licence & prior work
MIT ([LICENSE](../../LICENSE); third-party libraries in [THIRD_PARTY.md](../../THIRD_PARTY.md)). All code was written during the hackathon (29 Sep – 13 Oct 2026). This public repo is a curated history of our private development repo: each commit is a real state of the code, dated when the work was done. One frontend commit during development (5 Oct) ported a chart top bar from a founder's earlier project, against our own rule; it isn't part of this history, and the chart's top and bottom bars were replaced by a clean-room rewrite from a behavioural spec ([CHART_TOPBAR_SPEC.md](CHART_TOPBAR_SPEC.md)).

## Team
Three founders: **A (Samya)**, core protocol (order book, clearinghouse, funding oracle, swaps, integration); **B**, liquidity and automation (keeper, market maker, vault, Kuru hedger); **C**, product and growth (indexer, PWA, benchmarks, demo).

## Bounties
Track 01 is our entry. Sponsor bounties, only where the testnet product already meets them (rule: no feature built only for a bounty):
- **Envio, Best Use of Envio:** the HyperIndex indexer powers the app's funding history, positions, vault queue and stats. **Only after** the hosted Envio deployment is moved to the current testnet contracts (today it still indexes the previous deployment).
- **Privy:** Privy is the app's single auth layer and it fixes a perp's worst step, onboarding. What we use: **login** with email, passkey, Google or an external wallet (one Privy modal); **embedded wallets** created for every user without one; **native gas sponsorship** on Monad Testnet (`sendTransaction(…, { sponsor: true })`, EIP-7702, embedded wallets only, kill switch `NEXT_PUBLIC_SPONSOR_GAS=0`, never on mainnet); **export wallet** from the account menu. Why it matters for a perp: before, a tester needed a wallet, MON for gas and AUSD before their first order; now it is **email → embedded wallet → free test AUSD + deposit (one tap, three sponsored transactions) → first filled market order**, measured on Monad Testnet with a fresh Privy user: **5 taps, 22.6 s, 0 MON before and after** (Start trading, email Submit, ToS checkbox, one setup tap, Market long; PROOF §10 has the four tx hashes), and **4 taps / 19.6 s** on anvil without the Privy modal (`app/e2e/onboarding-anvil.spec.ts`). Design: Privy loads only in builds with an app ID; the write path is one core (estimate × 1.2 gas limit, receipt check incl. the bundled call's own result) with two transports (`app/src/lib/tx.ts`, `sponsor.ts`). Demo video: [timestamp TBD].
- **Not claimed:** Agora (requires trades through Perpl), Kuru (the testnet vault uses a mock hedger; real Kuru Flow routes are shown only on a mainnet fork), Chainlink CRE (not deployed), Mera (not our login).
