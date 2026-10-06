# RISKS

Scale: L(ikelihood)/I(mpact) = H/M/L.

## Technical
| # | Risk | L | I | Mitigation | Owner |
|---|---|---|---|---|---|
| T1 | Kuru ABI differs from docs (selector mismatch) | **Realized** | H | **Resolved 29 Sep:** interface fixed to the SDK ABI and fork-tested (CR-001) | WS-04 |
| T2 | Kuru market creation not permissionless | **Realized** (`deployProxy` owner-only, R18) | M | **Resolved by CR-003:** the fixed-rate layer lives on Meridian's own order book; no Kuru listing needed | — |
| T3 | No deep MON/AUSD on Kuru | **Realized** (R19: dead market) | H | CR-002: route the spot leg through Kuru Flow (0.34% @ $10k); MM bot revives Kuru MON/AUSD; vault cap 10k AUSD at launch | WS-04, WS-03 |
| T4 | Oracle freshness: Chainlink push heartbeat too slow for per-block premium | H | M | Verified: Chainlink MON/USD updates are minutes apart and Pyth's sponsored push lands every 10–30 s. Pyth is primary, and our keeper pushes Hermes updates every ≤ 3 s; the premium uses the latest fresh index; staleness guard ⇒ reduce-only | WS-03 |
| T5 | Order-book gas > 100k per MM cycle | M | M | `replaceOrder`, packed 1-slot orders, level array (MIP-8 pages), bitmap; measure Day 4 | WS-01 |
| T6 | OB⇄CH reentrancy through hooks | L | H | Hooks `onlyOrderBook`; no token transfers inside hooks; `nonReentrant` on OB entrypoints; CEI | WS-01/02 |
| T7 | Gas charged on gas limit ⇒ bots overpay / fail | M | L | Tight per-call gas limits from `estimateGas × 1.2` | WS-03 |
| T8 | Rounding bugs break solvency | M | H | Round-against-user rule; fuzz asserting rounding direction; invariant I1 | WS-02/08 |
| T9 | Envio HyperSync unsupported on 143 ⇒ slow indexing | **Cleared** (HyperSync live on 143; needs API token) | M | RPC-mode indexing; fallback to direct `viem` log polling in the app | WS-06 |
| T10 | Privy/Monad config issues | L | M | Day-1 spike; fallback: injected wallet + WalletConnect | WS-07 |
| T11 | CRE deploy access for our org (Monad forwarders verified, R14) | M | M | TS fallback keeper first (runs the same actions); CRE for the bounty | WS-03 |
| T12 | Interface churn across 9 sessions | M | H | Frozen interfaces, CR log, mocks, daily rebase | WS-00 |

## Economic
| # | Risk | Mitigation |
|---|---|---|
| E1 | Funding manipulation (spoof book mid for a few blocks) | Premium from book mid only when spread ≤ 2%; per-sample clamp ±5%; EMA half-life ~100 s; rate cap 0.2%/h; δ-cap (≥ 10 min to swing full range); median mark clamped to ±5% of index |
| E2 | Mark manipulation to trigger liquidations | Median of three (one outlier can't move it) + index band; last trade must be ≤ 30 s old |
| E3 | Bad debt on gaps / thin book | Liquidator takes the position at mark (doesn't hit the book); keeper reward; IF seeded 1–2k AUSD; OI and position caps; uncovered bad debt tracked (ADL roadmap) |
| E4 | AUSD depeg | Chainlink AUSD/USD monitor; pause vault deposits and new positions if < 0.99; perp PnL is AUSD-denominated so the depeg is a collateral-value, not a solvency, issue |
| E5 | Negative funding (shorts pay) | Vault exit rule (r̄·3d < 2·cost) → flat; swap longs pay (that is the hedge working); oracle shows the negative APR honestly |
| E6 | Thin Kuru liquidity ⇒ vault slippage | Measured: 0.34% for $10k and 7.5% for $50k via Kuru Flow. maxSlippage 0.5%; deploy in ≤ $2.5k slices; deposit cap **10k**; NAV at index + withdrawal fee |
| E7 | Vault liquidated on a spike | Margin ratio target 50% vs MM 5% (≈ 45% adverse move before liquidation at L = 2); rebalance at 25% |
| E8 | Swap margin shortfall on an extreme funding path | Margin covers 24 h at the rate cap + APR shock (MATH_SPEC §6.4); keeper liquidates swap accounts; notional cap at launch |
| E9 | MM bot is most of the volume ("fake volume" criticism) | Disclose MM share in metrics; report organic volume separately |
| E10 | √τ claim overreach | Use the scoped claim from MATH_SPEC §3.4 caveat |

## Schedule
| # | Risk | Mitigation |
|---|---|---|
| S1 | WS-00 slips ⇒ everyone blocked | Interfaces and mocks already done in the planning session; WS-00 is only CI/scripts |
| S2 | Integration surprises at CP1 | OB⇄CH protocol spelled out in INTERFACES §2; MockOrderBook/MockClearingHouse exercise the same hooks |
| S3 | Mainnet deploy late ⇒ no real users | Fork rehearsal Day 11; deploy Day 12 with caps; user outreach from Day 10 (Monad Discord, bounty channels) |
| S4 | Demo video crunch | DEMO_SCRIPT fixed Day 9; capture B-roll from Day 10 |
| S5 | Solo reviewer bottleneck | WS-08 reviews PRs against acceptance checklists; Samya only merges |

## Added with the final plan (29 Sep)
| # | Risk | Mitigation | Owner |
|---|---|---|---|
| P1 | Vault stays idle: entry rule needs funding ≳ 15.6% APR at 0.15%/leg cost; MON median funding ≈ 10.95% (R23) | Honest UI ("waiting for funding"); cut spot cost (≤ $2.5k slices, MM revives Kuru MON/AUSD); tune entryHorizon; the vault's value is also skew absorption | B |
| P2 | Swap book has no two-sided interest | MM bot quotes both sides around realized 8 h APR; vault is a natural fixed-rate seller (should-tier) | B |
| P3 | Swap margin model wrong under extreme rate paths | Invariant I9 fuzzes rate paths at cap/δ; liqHorizon 24 h; launch notional cap | A |
| P4 | Interest term (10.95%) looks like "free yield" to judges | Explain it as the industry convention (0.01%/8h) that anchors perp price to spot; show the calibration (R23) | A |
| P5 | 3-founder coordination (≈ 9 sessions) | TEAM_PLAN rhythm: frozen interfaces, CR log, cross-review matrix, checkpoint gates, scope freeze Day 9 | all |
| P6 | Pyth Hermes key / CRE access not granted | Sponsored Pyth push fallback (maxStaleness 60 s); CRE is should-tier | B |
| P7 | Agora bounty requires native / Mera | Decide login by Day 2; never build native | C |

## Cut order (in this order)
1. Chainlink CRE (TS keeper stays)
2. Second login system / Mera (keep one)
3. Vault fixed-rate lock via swaps
4. Funding swaps → pitch as roadmap (keep MATH_SPEC §6)
5. Polish
**Never cut:** per-block funding engine · funding oracle · basis vault · benchmarks · crash demo.
