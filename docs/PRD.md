# PRD: Pulse (placeholder name)

> "Hourly funding exists because chains were slow. On Monad, funding is continuous, so we built the funding-rate layer on top of it: **trade it, earn it, fix it.**"

Hackathon: Monad Metropolis, **Track 01 Onchain Finance & Trading** (+ Grand Champion). Deadline 13 Oct 2026. Team: 3 founders (docs/TEAM_PLAN.md).

## 1. Problem
| Problem | Today | Pulse |
|---|---|---|
| Funding is lumpy | Perps settle funding in lumps (Perpl every ~43 min; CEXs 1–8 h): equity jumps, timing games, bigger buffers | Funding accrues **every block (300 ms)** through an O(1) index |
| No onchain funding rate | Rate products (e.g. Pendle Boros on Arbitrum) import CEX funding through oracles | A **Monad-native funding-rate oracle** anyone can settle against |
| Basis yield is hard to reach | Cash-and-carry needs two venues + babysitting | One-tap AUSD basis vault |
| No fixed rate on funding | Funding floats | **Funding swaps**: lock a fixed funding APR to maturity |

## 2. Users
| Persona | Wants | Product |
|---|---|---|
| Perp trader | Leverage on MON, fair continuous funding | MON-PERP |
| Hedger (perp long) | Known funding cost | Long swap (receive floating, pay fixed) |
| Yield seeker | "Deposit AUSD, earn funding" | Basis vault |
| Fixed-rate seeker / basis trader | Locked carry | Short swap |
| Integrator | A trustworthy rate | Funding-rate oracle |

## 3. Goals / non-goals
**Goals:** (G1) per-block funding perp on a fully onchain CLOB, live on mainnet; (G2) public funding-rate oracle; (G3) skew-absorber basis vault with live yield; (G4) 30-day funding swap market; (G5) benchmark report ("why only Monad"); (G6) real users and fees.
**Non-goals:** cross-margin, ADL execution, multi-collateral, token/governance, upgradeability, PT/YT (deferred), more than one perp market (stretch), native mobile apps.

## 4. Scope
| Tier | Items |
|---|---|
| **Must** | MON-PERP (5x max, AUSD), funding oracle, basis vault (10k cap), funding swaps (1 maturity), mobile PWA (Privy or Mera), Envio indexer, TS keeper, MM bot, benchmarks, crash demo |
| **Should** | Chainlink CRE workflows (if deploy access by Day 7); Mera login if Agora requires it; vault locks a fixed rate via swaps |
| **Stretch** | ETH-PERP; Aurora any-chain deposit |
| **No** | PT/YT alongside swaps; anything depending on Kuru owner actions |

## 5. User stories & acceptance criteria
| # | Story | Acceptance |
|---|---|---|
| US1 | Log in on my phone (no seed phrase) and see MON-PERP funding tick every block | Login < 30 s; ticker updates ≥ 2×/s |
| US2 | Deposit AUSD (one signature via permit) and open a 5x long | Position shows entry, liq price, pending funding within 2 s |
| US3 | Place/cancel limit orders | Depth updates; cancel releases margin |
| US4 | My position accrues funding every block | pendingFunding changes block to block when OI > 0 |
| US5 | If equity < MM, anyone can liquidate me; the insurance fund covers bad debt | Liquidation test + live demo |
| US6 | One tap to deposit into the vault and see live APY | Share price rises with funding; UI shows "waiting for funding" when the entry rule is off |
| US7 | Withdraw anytime | From idle or bounded unwind, ≤ maxSlippage |
| US8 | Lock my funding cost: go long a swap at a fixed APR | Fill at book APR; accrual = floating − fixed per MATH_SPEC §6.2 within 1 wei |
| US9 | See the 8 h / 24 h realized funding APR from the oracle | Matches ΔF/ΔG from indexed FundingUpdated events |
| US10 | Judges read a benchmark report | Gas table, funding-update gas, parallel load test, √τ chart |

## 6. Success metrics (by 13 Oct)
| Metric | Target |
|---|---|
| Unique mainnet wallets that traded or deposited | ≥ 50 |
| Perp volume | ≥ $250k (MM share disclosed) |
| Swap notional traded | ≥ $50k |
| Fees generated | ≥ $100 onchain |
| Vault TVL | ≥ $10k (cap) |
| MM place+cancel gas | < 100k |
| Funding first-touch incremental gas | < 30k normally; < 40k on checkpoint blocks (1 in 200) |
| Invariants I1–I11 | green at 256×128 |

## 7. Competitive positioning
| | Perpl | Monday Trade | Pendle Boros | **Pulse** |
|---|---|---|---|---|
| Chain | Monad | Monad | Arbitrum | Monad |
| Book | onchain CLOB | CLOB + AMM | order book | onchain CLOB |
| Funding | every ~43 min | periodic | n/a (trades CEX funding) | **every block** |
| Rate oracle | — | — | imports CEX funding | **native, per block, public** |
| Yield products | — | — | fixed/floating funding (1.2x at launch) | basis vault + funding swaps |
| Collateral | AUSD | — | underlying asset | AUSD |

We don't compete with Perpl on market breadth. We compete on the rate layer nobody on Monad has.

### 7.1 Claims we may make (and ones we must not)
| ✅ Say | ❌ Never say | Why |
|---|---|---|
| "Per-block funding on a fully onchain order book" | "First low-latency onchain perp" | Hyperliquid, dYdX v4, Perpl, Monday Trade exist |
| "The first funding-rate market whose floating leg settles every block from a rate generated onchain, with no rate oracle" (verify before submitting) | "First continuous funding" | GMX v2 (per second) and Synthetix Perps v2 already accrue funding continuously, but in pool/skew models, not CLOB premium |
| "Monad's first public funding-rate oracle" | "First funding-rate swaps" | Rho Protocol (since Nov 2023) and Pendle Boros (2025) trade funding, but they import CEX funding via oracle and settle per period |
| "Trade it, earn it, fix it: one rate, one engine" | — | The closed loop is the unique part: the same CLOB produces the rate, the vault earns it, the swaps fix it |


## 8. Cut order if behind
CRE → Mera (keep one login) → vault fixed-rate lock → funding swaps (pitch as roadmap, keep MATH_SPEC §6) → polish.
**Never cut:** per-block funding, funding oracle, basis vault, benchmarks, crash demo.
