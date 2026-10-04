# MATH_SPEC — Pulse (normative)

All defaults are **tunable** and set at deploy through `setRiskParams` / `setFundingParams` / `setVaultParams`. "↑" = round up (toward +∞), "↓" = round down (toward −∞), "0" = truncate toward zero (neutral, used only where both sides read the same value).

## 0. Conventions
| Symbol | Meaning | Unit | Scale |
|---|---|---|---|
| P, I, M | price, index, mark | AUSD per base | WAD |
| q | position size (+long/−short) | base | WAD int |
| C | collateral | AUSD | WAD |
| ON | open notional, Σ qᵢ·Pᵢ of open lots (signed) | AUSD | WAD int |
| E = ON/q | entry price | AUSD/base | WAD |
| F | cumulative funding per 1 base | AUSD | WAD int |
| r | funding rate | 1/second | WAD int |
| n | blocks elapsed since last funding update | blocks | integer |
| Δt | n · blockTimeMs / 1000 | seconds | WAD |

Token boundary: `wad = amountToken · 1e12` (exact); `amountToken = ⌊wad / 1e12⌋` ↓.

## 1. Funding

### 1.1 Time base (decision)
Monad `block.timestamp` has 1 s resolution with 300 ms blocks (ARCHITECTURE R4), so ~3 consecutive blocks share a timestamp. **Accrual uses block numbers:** `Δt = (block.number − lastUpdateBlock) · blockTimeMs / 1000`, with `blockTimeMs = 300` (tunable, updated if Monad changes block time; MIP-12 moved it from 400 → 300). Drift vs wall-clock is bounded by consensus block-time variance; the benchmark (B2) reports the realized mean block time so the param can be tuned.

### 1.2 Formulas (per market, executed on the first touch in block b)
```
S_b      = fairBookPrice_b                            // §2.2; NOT the mark (avoids circularity)
premium_b = clamp((S_b − I_b) / I_b, −π, +π)          // π = premiumBand; ↓/0 neutral
αeff     = 1 − (1 − α)^n                              // exact EMA over n elapsed blocks; (1−α)^n computed ↑ ⇒ αeff ↓
p̄_b      = αeff · premium_b + (1 − αeff) · p̄_(b−n)    // 0
r*_b     = p̄_b / T + i                                // T = convergence period (s); i = interest per s
r_b      = clamp(r*_b, r_(b−n) − δ·n, r_(b−n) + δ·n)  // 1st: per-block change cap, scaled by elapsed blocks
r_b      = clamp(r_b, −cap, +cap)                      // 2nd: absolute cap (applied LAST so |r| ≤ cap always, even after an admin lowers cap)
F_b      = F_(b−n) + r_b · I_b · Δt                    // 0 (both sides read the same F)
G_b      = G_(b−n) + I_b · Δt                          // 0 — notional-time index for funding swaps (§1.8, §6)
```
- Integer implementation (one rounding per index, both truncating "0"): with `dtMs = n · blockTimeMs`,
  `F += r · I · dtMs / (1e18 · 1000)` via `fullMulDiv(r·I … )` handled for sign (compute |r|·I·dtMs with fullMulDiv, then apply sign), and
  `G += I · dtMs / 1000`. Never divide twice. Units: F in AUSD-WAD per 1 MON; G in AUSD-WAD·seconds per 1 MON.
- Positive r ⇒ F rises ⇒ **longs pay shorts**.
- Only the first tx per block per market writes; `lastUpdateBlock == block.number ⇒ return`.
- Refinement vs PRD: the PRD wrote `rate = clamp(p̄ + interest)`. A premium is dimensionless, so we divide by a convergence period T to get a per-time rate: "if the premium persists at 0.1%, longs pay 0.1% per T". With T = 1 h this matches hourly-funding venues in magnitude, but it is paid continuously.
- Using `r_b` (the new rate) over the whole elapsed interval is a deliberate simplification. The δ-cap bounds the error to ≤ δ·n·I·Δt.

### 1.3 Parameters
| Param | Default | Meaning |
|---|---|---|
| α | 0.002 (WAD 2e15) | EMA weight per block; half-life ≈ 347 blocks ≈ 104 s |
| π (premiumBand) | 0.05 | per-sample premium clamp ±5% |
| T | 3600 s | convergence period (hard-coded constant in FundingLib; change via CR) |
| i | **10.95% APR = 3.4722e-9 /s (WAD 3_472_222_222)** | interest component, the industry 0.01%/8h convention. Calibration: Hyperliquid MON funding over the last ~21 days averaged 13.8% APR, median 10.95% (its interest floor), and was positive 97% of hours (R23). With i = 0 a balanced book pays ~0 and the vault earns nothing |
| cap | 0.2%/h = 5.556e-7 /s (WAD 555_555_555_556) | rate clamp |
| δ | cap/1000 per block (WAD 555_555_556) | full −cap→+cap swing needs ≥ 2000 blocks ≈ 10 min |
| blockTimeMs | 300 | ms |

### 1.4 Account settlement (lazy, O(1))
```
owed = q · (F_now − F_entry)          // ↑ : the account owes more / receives less
C   -= owed ;  F_entry = F_now
```
Rounding: `owed = ceil(q·ΔF / 1e18)` for both signs (payers pay ↑, receivers get ↑ = less negative = less received). Implement with `sMulWad` plus a +1 correction when there is a remainder, or `fullMulDivUp` on |q·ΔF| with the sign handled.

### 1.5 Funding conservation invariant
Longs and shorts are matched 1:1 (Σq = 0 at all times). **Requirement:** every position change (fill on either side, liquidation transfer) settles funding for *both* affected accounts at the current F *before* changing q. Then total funding over any history splits into intervals of constant positions, each contributing ΔF·Σq = 0. Rounding each settlement ↑ creates dust with **0 ≤ dust ≤ number of settlements** (wei), which accrues to the protocol.
Invariant test (WS-08): `0 ≤ Σ owed_i ≤ #settlements` wei; solvency is I1 (§7).

### 1.6 Oracle stale behaviour
If `oracle.tryGetIndexPrice()` fails: skip the premium sample and accrual (F **and G** unchanged, so funding swaps also pause consistently), still set `lastUpdateBlock` (no retroactive accrual), emit FundingUpdated with rate unchanged. CH blocks position-increasing trades (`OracleStale`); reduce-only, cancels, deposits and liquidation (using last good mark) continue.

### 1.7 Worked example
(a) Premium only, **with i = 0 for illustration**: I = 2.0000, persistent premium p̄ = +0.1%, T = 3600 s:
- r = 0.001/3600 = 2.7778e-7 /s (WAD 277_777_777_778) < cap ✓
- per block: ΔF = r·I·0.3 s = 1.6667e-7 AUSD per MON (WAD 166_666_666_667)
- A long of 1,000 MON over 1 h (12,000 blocks) owes 1000 · 2.7778e-7 · 2 · 3600 = **2.0000 AUSD** (0.1% of 2,000 notional) ✓
- Gap of n = 100 blocks: αeff = 1 − 0.998¹⁰⁰ = 0.1814.

(b) Interest only (default i, p̄ = 0): I = 0.029, r = 3.4722e-9 /s (WAD 3_472_222_222). A long of 1,000,000 MON ($29,000) for 1 day owes 1e6 · 3.4722e-9 · 0.029 · 86,400 = **8.70 AUSD** = 29,000 · 10.95% / 365 ✓. Per block ΔF = r·I·0.3 = 3.02e-11 AUSD/MON (WAD 30_208_333).

### 1.8 Funding rate oracle (IFundingRateOracle)
```
avgRate(window) = (F_now − F_then) · 1e18 / (G_now − G_then)   // per second, WAD (F is WAD, G is WAD·s); time- and price-weighted
avgApr(window)  = avgRate · 365 d                               // identity: |ΔF| ≤ cap·ΔG ⇒ avgRate ∈ [−cap, cap]
```
- Checkpoint ring buffer (**sequential**, Uniswap-v3 style): on a funding touch, if `block.number / 200 > lastCheckpointBlock / 200`, write `{F, G, block}` at `idx = (idx + 1) mod 1440`. Pack as 2 slots: `int256 F` and `(uint64 block, uint192 G)` (G < 2^192 for any realistic price·time). At most 1 checkpoint per 200-block bucket ⇒ ≤ 1 extra write per ~60 s. **Gas target (Phase 2, decision 1):** funding first touch < 30k gas normally and < 40k on checkpoint blocks (1 in 200); the 2-slot checkpoint stays (1-slot packing overflows for BTC-priced markets); slots are reused after the ring wraps (nonzero→nonzero ⇒ no 17k growth cost).
- `observe(blocksAgo)`: target = block.number − blocksAgo. **O(1) fast path**: the keeper pokes every ≤ 20 blocks, so every bucket has a checkpoint and the entry is at `idx − (currentBucket − targetBucket)`. Verify its block ≤ target and the next one's > target; otherwise fall back to **binary search over the ring (≤ 11 iterations, bounded)**. Reverts `ObservationTooOld` if target < oldest checkpoint. Returns the checkpoint at or before target, and consumers use its actual block for the window length.
- Manipulation: F only moves at the clamped, δ-capped rate, so moving the 8 h average by x APR points needs sustained premium over hours at a real cost. Proof sketch goes in the write-up.

## 2. Mark price

### 2.1 Formula
```
A = I · (1 + p̄)                         // funding-implied basis
B = bookMid       if both sides present  else A
Cp = lastTradePrice if block.number − lastTradeBlock ≤ lastTradeMaxAge (100 blocks = 30 s)  else A
M = median(A, B, Cp)
M = clamp(M, I·(1 − markBand), I·(1 + markBand))    // markBand = 5% (tunable)
```
Fallback table:
| Book | Last trade fresh | M |
|---|---|---|
| ✓ | ✓ | median(A,B,C) |
| ✗ | ✓ | median(A,A,C) = A |
| ✓ | ✗ | median(A,B,A) = A |
| ✗ | ✗ | A |
Every fallback collapses to A, the smoothed funding-implied price, which is the manipulation-resistant anchor. A single manipulated input can never move the median beyond the other two.

### 2.2 Fair book price (premium source)
`S = bookMid` if both sides present and `spread/mid ≤ 2%`; else `S = I` (premium 0 sample). Impact-mid (depth-weighted) = stretch.

## 3. Margin, PnL, liquidation (isolated)

### 3.1 Position update on a fill (Δq at price P)
- Increase (same sign or flat): `ON += Δq·P` (0), `q += Δq`.
- Decrease: `c = min(|Δq|,|q|)`; `released = ON·c/|q|` **rounded toward +∞ in both cases** (long: ON > 0, bigger released ⇒ smaller realized; short: ON < 0, toward +∞ = toward 0 ⇒ smaller realized), so `realized = sign(q)·c·P − released` rounds ↓; `ON −= released`; `q += sign(Δq)·c`; any remainder opens the opposite side at P.
- Fee: `fee = |Δq|·P·feeRate` ↑ (taker); maker fee may be negative (rebate ↓).

### 3.2 Equity and requirements
```
upnl   = q·M − ON                                   // ↓
equity = C + upnl − owedFunding(pending, §1.4)      // components already rounded against user
IM     = |q|·M·imr + reservedOrderMargin            // ↑
MM     = |q|·M·mmr                                  // ↑
liquidatable ⇔ equity < MM
reserve(order) = size·price·imr                     // ↑
```
Liquidation price (isolated, ignoring funding):
- long: `P_liq = (E − C/q)/(1 − mmr)`; short: `P_liq = (E + C/|q|)/(1 + mmr)`.

### 3.3 Liquidation
```
x        = min(maxSize, |q|)                        // liquidator chooses; partial allowed
notional = x·M
penalty  = min(notional·liqPenalty ↑, max(equity_after_close, 0))
keeper   = penalty·keeperShare ↓ ;  toIF = penalty − keeper
position x transferred to liquidator at M (liquidatee realizes pnl at M)
if C_liquidatee < 0: badDebt = −C ; IF.coverBadDebt(badDebt) ; uncovered ⇒ totalBadDebt (ADL roadmap)
liquidator must satisfy equity ≥ IM after
```
The liquidatee keeps any equity left after the penalty (as collateral in its account). The insurance fund receives only `toIF`.
Check (crash demo): 5x long, −15% ⇒ equity 20% − 15% = 5% of entry notional < MM = 10% × 0.85 = 8.5% ⇒ liquidatable ✓.
| Param | Default |
|---|---|
| imr | **20% (5x, same as Hyperliquid's MON max leverage, R23)** |
| mmr | **10%** |
| liqPenalty | 1% |
| keeperShare | 50% |
| takerFee / makerFee | 5 bps / −1 bp |
| maxOpenInterest / maxPositionSize | launch caps: 250k MON / 25k MON (tunable) |

### 3.4 The √τ margin argument
Price moves over the liquidation latency τ as a Brownian increment with std σ√τ. To keep P(loss > MM before liquidation) ≤ Φ(−z), we need

  **mmr ≥ z·σ·√τ  (+ impact + funding jump)**

where the *funding jump* is the discrete equity hit a venue applies at each funding timestamp (≈ |rate|·interval). Per-block funding makes it ≈ 0.

Table (σ = 100% annualized, z = 3; script `bench/sqrt_tau.py` reproduces it):
| Design | τ | z·σ·√τ | implied max leverage |
|---|---|---|---|
| Monad, 1 block | 0.3 s | 0.029% | ~3400x |
| Monad, 3 blocks | 0.9 s | 0.051% | ~2000x |
| Monad, keeper ≈ 2 s | 2 s | 0.076% | ~1300x |
| Ethereum L1 block | 12 s | 0.185% | ~540x |
| 1-minute | 60 s | 0.414% | ~240x |
| Hourly | 3600 s | 3.205% | ~31x |
| 8-hour | 28800 s | 9.066% | ~11x |

σ sensitivity (τ = 0.3 / 0.9 / 3600 / 28800 s): σ=50% → 0.015/0.025/1.603/4.533%; σ=150% → 0.044/0.076/4.808/13.599%.
**Honesty caveat (put in the write-up):** the hourly/8h rows model designs where risk state (mark, funding and settlement) refreshes only at that interval. Most CEX/perp DEXs liquidate continuously, so their τ is keeper latency, not the funding interval. Our claim is narrower and defensible: on Monad, *funding, mark and liquidation eligibility* all update every block, so both the √τ term and the funding-jump term shrink. We still set mmr = 10% (5x max) for the MVP because thin launch liquidity (impact) dominates. That is a launch-risk choice, not a latency limit.

## 4. Market-maker bot (Avellaneda–Stoikov), in basis-point units
Work in **bps relative to mid**, so the parameters don't depend on MON's $0.03 price:
```
r_bps = − q·γ·σ²·(T − t)                               // reservation offset from mid (bps)
δ_bps = γ·σ²·(T − t) + (2/γ)·ln(1 + γ/k)               // total spread (bps); bid = mid·(1 + (r − δ/2)/1e4), ask = mid·(1 + (r + δ/2)/1e4)
```
| Symbol | Unit | Default | Note |
|---|---|---|---|
| σ | bps/√s | from last 10 min of index; 100% annual vol ⇒ 1e4/√(31,536,000) ≈ **1.78** | |
| q | inventory / maxInventory ∈ [−1, 1] | — | one-sided quoting at the limits |
| γ | 1/bps | **0.01** | risk aversion |
| k | 1/bps | **0.5** | order-arrival decay; refit from fills daily |
| T − t | s | **60** | rolling horizon (infinite-horizon variant) |
Worked numbers: γσ²(T−t) = 0.01·1.78²·60 ≈ **1.90 bps**; (2/γ)ln(1+γ/k) = 200·ln(1.02) ≈ **3.96 bps** ⇒ spread ≈ **5.9 bps**; at q = +1 the reservation shifts −1.90 bps. Snap bid ↓ / ask ↑ to tick (perp tick 1e-6 AUSD ≈ 0.345 bps at $0.029, so the 5.9 bps spread spans ≈ 17 ticks and the 1-tick floor never binds; *corrected Phase 2: was "3.4 bps"*). Refresh on each new block or an index move > 2 bps.
Swap book: same model on the APR axis (units = APR bps around realizedApr(8 h)), σ from the 8 h realized APR series.

## 5. Vault: "skew absorber" basis vault (ERC-4626)

### 5.1 Allocation
Capital D (AUSD), perp leverage L:
```
N = D·L/(L+1)                    // target hedge notional ↓
h = min(N/P, shortCapacity)      // hedge size in MON, lots ↓ (never over-short)
spot = h (MON bought)            // spot always matches the short ⇒ delta-neutral
M = h·P/L                        // perp margin ↑ ; D − h·P − M stays idle
APR ≈ r_funding · L/(L+1) − costs   (when fully deployed, h = N/P)
```
Default **L = 1.5** ⇒ N = 0.6·D, M = 0.4·D, initial perp margin ratio 66.7%. The perp leg (isolated) reaches MM (10%) after a **≈ +51%** MON pump: 0.4 − 0.6x = 0.1·0.6·(1+x) ⇒ x = 0.515. The MarginLow rebalance (ratio < 25%) fires at ≈ +33%, well before that.
Baseline yield at the interest floor alone: 10.95% × 0.6 ≈ **6.6% APR**. Premium on top when longs dominate.

### 5.2 Capacity (skew) rule: the vault never creates short skew
```
otherLongs  = longOI − 0                     // vault is never long
otherShorts = shortOI − |vaultShort|
shortCapacity = skewCapacity · max(0, otherLongs − otherShorts)     // skewCapacity = 0.8
```
If `|vaultShort| > shortCapacity` ⇒ reason `SkewCap`: reduce the short and sell the matching spot.
*(Amended Phase 3, decision 11.)* Because every long is matched by a short (Σq = 0 ⇒ longOI = shortOI), the literal form above equals `skewCapacity·|vaultShort|`: a flat vault would have capacity 0 and never enter. "Other traders" must exclude the **registered liquidity providers** (our MM bots), whose inventory is the skew the vault replaces:
```
shortCapacity = skewCapacity · max(0, −(vaultSize + Σ providerSize))     // = takers' net long, via Σq = 0
```
Providers are owner-registered on the vault (≤ MAX_BATCH, O(#providers) view). With providers carrying m short and the vault v short, v + m is constant under vault trading (the vault sells into the MM's bids), so the vault converges to ≤ 80% of the takers' skew and leaves ≥ 20% to the MM, which keeps the premium alive.
Rationale: funding is paid by excess longs. A vault bigger than the excess would push funding to ≤ 0 and destroy its own yield.

### 5.3 Entry / exit / rebalance
```
r̄  = oracle.averageFundingRate(8 h)                      // per second
c = one-way cost to open (or close) the hedge, as a fraction of hedge notional
    = spot slippage + spot fee + perp taker fee (measured ≈ 0.15% with ≤ $2.5k slices)
enter ⇔ r̄ · entryHorizon (7 d) > 2·c        // funding must repay open + close:   APR > 2c·365/7 ≈ 15.6%
exit  ⇔ r̄ · exitHorizon  (3 d) < −c         // exit only when expected NEGATIVE funding over 3 d exceeds the cost to close: APR < −c·365/3 ≈ −18.3%
                                            // between the two thresholds: hold (hysteresis; entry cost is sunk)
drift ⇔ |spotBase + perpSize|·P / N > θ (2%)
margin⇔ marginRatio < 25%  ⇒ sell spot slice → top up perp margin
slice ⇔ each rebalance moves ≤ maxSliceAssets (2,500 AUSD) through the spot leg
```
| Param | Default |
|---|---|
| L | 1.5 |
| skewCapacity | 0.8 |
| θ driftBand | 2% |
| target / min marginRatio | 60% / 25% |
| entryHorizon / exitHorizon | 7 d / 3 d (thresholds ≈ +15.6% / −18.3% APR at c = 0.15%) |
| maxSlippage | 0.5% vs oracle index |
| maxSliceAssets | 2,500 AUSD |
| idleBuffer | 5% |
| withdrawal fee | 5 bps (to remaining holders) |
| depositCap | 10,000 AUSD at launch |

### 5.4 NAV and share price
```
NAV = idle + spotBase·I + perpCollateral + perpSize·I − perpON − owedFunding     // all at ORACLE INDEX I
```
Both legs at the same index ⇒ NAV is price-neutral when hedged and cannot be moved by trading on Kuru or Pulse. shares minted ↓, assets out ↓, shares burned ↑; OZ ERC-4626 decimals offset 12.

### 5.5 Worked example
D = 10,000, L = 1.5, P = 0.029: N = 6,000 AUSD → ≈ 206,897 MON spot; M = 4,000; short 206,897 MON (if shortCapacity allows, e.g. other traders net long ≥ 258,621 MON). At 10.95% floor funding: 6,000 × 10.95% ≈ 657 AUSD/yr ≈ 6.6% on D. Round trip (open + close) ≈ 2 × 0.15% × 6,000 = 18 AUSD ≈ 10 days of yield (657/365 = 1.8 AUSD/day) ⇒ the 7-day entry test fails at the bare 10.95% floor; it needs ≈ 15.6%, i.e. premium adding ≈ 4.7 APR points. That is intentional: the vault only works when the market pays.

## 6. Funding swaps (fixed-for-floating, one maturity): the "fix it" layer
*(PT/YT is deferred to post-hackathon. Its interfaces live in `contracts/src/interfaces/deferred/`.)*

### 6.1 Instrument
- Underlying: MON-PERP funding. Size q in MON notional units (+ long = receive floating, pay fixed).
- Order book price `p = 1 + A` (WAD), with A the fixed APR (A ∈ (−100%, +∞) since p > 0). tickSize = 1e14 (1 bp APR), lotSize = 1,000 MON.
- Maturity `T_m` (timestamp): one 30-day contract listed at mainnet launch (Day 12). Accrual stops at the maturity snapshot. `τ = max(0, T_m − now)` seconds; `YEAR = 365 days`.

### 6.2 Position state and accrual (O(1), lazy, exactly conserving)
Per account: `q`, `K` (= fixedAprNotional), `F₀`, `G₀` (perp indices at last settle).
**Fill rule (every fill, both sides):** settle first, then `q += Δq`, `K += Δq·A_fill`. No proportional reduction. *(Amended Phase 2, decision 9:)* `kDelta = Δq·A/1e18` (truncating "0") is computed **once per fill** and applied as `+kDelta` to the buyer and `−kDelta` to the seller, so ΣK = 0 exactly (never compute it separately per side).
```
floating = q · (F − F₀) / 1e18                        // received by a long (what a q-long perp pays)
fixed    = K · (G − G₀) / (1e18 · YEAR)              // paid by a long; K·ΔG is notional-time × APR
net      = floating − fixed                          // credited; ↓ (rounds against the account for either sign)
```
*(Amended Phase 2, decision 9)* Implementation uses **one floor division**, never two: `net = floor((q·ΔF·YEAR − K·ΔG) / (1e18·YEAR))` (compute the numerator in full precision, e.g. int512 via `fullMulDiv` on magnitudes, then floor toward −∞). Rounding ↓ once per settlement ⇒ Σ net ∈ [−#settlements, 0] wei (I9).
Equivalent form: `net = q·Σ I·Δt·(r − Ā/YEAR)` with r per second and Ā = K/q per year, a pure rate difference.
**Why K is never reduced proportionally:** after a long q at Ā sells c at A_exit, K = q·Ā − c·A_exit. If fully closed (q = 0), K = q(Ā − A_exit) ≠ 0 and the account keeps a **locked spread stream** (A_exit − Ā)·ΔG/YEAR until maturity, exactly like offsetting an interest-rate swap. Because every fill adds +Δq·A to one side and −Δq·A to the other, **Σq = 0 and ΣK = 0 at all times ⇒ Σ net = 0 exactly (minus rounding dust)**. Paying the value upfront in cash instead would leave the protocol exposed to MON price moves between now and maturity (future ΔG ≠ I_now·τ). Don't do that.

### 6.3 Mark and PnL
```
markApr = median(bookMidApr, lastTradeApr (≤ 30 s old), realizedApr(8 h)),  clamped to realizedApr ± 50 APR points
markApr_used = clamp(markApr, anchor ± min(blocksSinceAnchor, 20) · 0.5 APR points)   // B-01 (review B), rounds neutral
//   anchor = the markApr_used of the last block that touched the market; the first touch of a block fixes it for the
//   whole block, and a trade printed in the current block is not a lastTradeApr input. One refresh moves the mark
//   ≤ 10 APR points (≈ 0.8% of notional at τ = 30 d, below the ≈ 2.6% IM–MM gap); a genuine regime change reaches the
//   live mark in ≈ 10 points per touched refresh (keepers touch with `settle` of any account).
V       = (q·markApr/1e18 − K) · I / 1e18 · τ / YEAR      // value of the remaining stream, AUSD WAD ↓ (K is stored in WAD: K += Δq·A/1e18)
equity  = collateral + accruedNet(unsettled, §6.2) + V
```
For a plain long at Ā: V = q·I·(markApr − Ā)·τ/YEAR ✓. For a closed account (q = 0): V = −K·I·τ/YEAR = the locked spread ✓.

### 6.4 Margin
Losses accrue at a **bounded rate** because |r| ≤ cap and r moves ≤ δ per block:
```
worstRate = I · (|q|·cap_apr/1e18 + |K|) / 1e18                 // max AUSD-WAD/yr the position can lose to its two legs
MM = worstRate · liqHorizon / YEAR                               // 24 h of worst case
   + |q| · I · aprMoveBuffer · τ / YEAR                          // implied-APR shock on the mark value
   + |q·markApr − K| · I · τ / YEAR · PRICE_SHOCK                // MON price shock on notional-time (PRICE_SHOCK = 0.3, constant in SwapMarginLib)
IM = MM · imMultiplier                                            // all ↑
```
Defaults at inception (q = 1, Ā = 12%, 30 d): cap_apr = 0.2%/h × 8,760 = 1,752% APR ⇒ (17.52 + 0.12)/365 = 4.83%; + 0.05 × 30/365 = 0.41%; + 0 ⇒ **MM ≈ 5.24%, IM ≈ 7.87% of notional (≈ 12.7x)**.
Full worst-case collateralization to maturity would need ≈ 144% of notional (17.52 × 30/365), which is why this is a margined product with liquidation.
**Voluntary reductions (B-02):** a trade that does not grow |q| needs equity ≥ 0 after it and must not create or worsen a maintenance shortfall: `slack = equity − MM` (MM ↑, so slack rounds against the account) must satisfy `slack_after ≥ min(0, slack_before)`. An off-market close that turns q into a large locked |K| is refused; a close near the mark (and any reduction that improves an existing shortfall) passes. Makers: the fill is skipped and the order evicted, as for any failed maker check.
**Liquidation:** the liquidator receives `x` and the proportional `K·x/q`. A cash transfer `V_x = x·I·τ/YEAR·(markApr − K/q)` goes from liquidator to liquidatee (negative = the other way). The amount is equal and opposite, so conservation is exact. Then penalty = liqPenalty·MM_x: keeperShare to liquidator, rest to the IF; bad debt via IF. Accounts with q = 0 (locked spread only) are never liquidated if the stream is positive; otherwise their MM is the price-shock term only.

### 6.5 Fees
`fee = |Δq|·I·feeApr·τ/YEAR` ↑ per fill (taker 0.2% APR; maker −0.05% APR rebate ↓). Fees in APR·time are fair across time-to-maturity.

### 6.6 Worked example
I = 0.029 (held constant for the example), trader long 1,000,000 MON notional (≈ $29,000) at A = 12%, 30 days, realized funding averages 18%:
net = 29,000 × (0.18 − 0.12) × 30/365 = **+143.01 AUSD**. IM ≈ 7.87% × 29,000 ≈ **2,281 AUSD**.
Offset example: after 10 days the trader sells 1,000,000 at 15%: q = 0, K = 1e6·(0.12 − 0.15) = −30,000 ⇒ locked stream = +0.03 × ΣIΔt/YEAR ≈ 29,000 × 0.03 × 20/365 ≈ **+47.7 AUSD** over the remaining 20 days, independent of funding.
Vault use (should-tier): the vault (receiving floating ≈ 18%) shorts 1M MON of swap at 12% ⇒ locks 12% on that notional for 30 days.

### 6.7 Implied APR display
The book price is the APR itself (p − 1), simple (non-compounded) APR. UI shows "Fixed 12.00% until <date>".

## 7. Invariants (WS-08 implements; each WS supplies handlers)
| ID | Invariant |
|---|---|
| I1 Solvency / conservation | `AUSD.balanceOf(CH)·1e12 ≥ Σ_i C_i − Σ_i ON_i − Σ_i pending_i + accruedFees` with equality up to non-negative dust (Σq = 0 ⇒ Σ upnl = −Σ ON at any mark; pending_i = owed funding not yet settled, §1.4, so Σ pending ≥ 0 is the rounding dust in the protocol's favour). Uncovered bad debt appears as a negative C_i that is zeroed only via IF inflow. *(Amended Phase 2, decision 7: −Σpending term.)* |
| I2 OI balance | `longOI == shortOI == Σ max(q_i,0) == Σ max(−q_i,0)` (ghost sums in handler) |
| I3 Funding conservation | for any run with all accounts settled: `0 ≤ Σ owed_i ≤ N_accounts` wei |
| I4 Funding once per block | `FundingUpdated` emitted ≤ 1 per block per market; F unchanged by 2nd touch |
| I5 Rate bounds | `|r| ≤ cap` always; `|r_b − r_prev| ≤ δ·n` (except the update right after an admin lowers cap) |
| I6 Book integrity | bestBid < bestAsk when both exist; level.totalLots = Σ orders; bitmap bit ⇔ level non-empty |
| I7 Margin reservation | Σ reserved(maker) = Σ open-order reservations |
| I8 Vault shares | `convertToAssets(totalSupply) ≤ totalAssets()`; share price never decreases from deposit/withdraw alone |
| I9 Swaps | `Σq == 0` and `ΣK == 0` (ghost sums); `longOI == shortOI`; Σ net accrual over settled swap accounts ≤ 0 and ≥ −#settlements wei; after maturity no account's accrual changes; equity ≥ 0 for all accounts in fuzz runs where the rate path respects cap/δ and liquidations run within liqHorizon |
| I11 Oracle | G never decreases; `|F_b − F_a| ≤ cap·(G_b − G_a)/1e18` for any two checkpoints; checkpoint blocks strictly increasing around the ring; `averageFundingRate(w)` ∈ [−cap, cap] |
| I10 No free money | any sequence of deposit→withdraw by one actor with no price move returns ≤ deposit |

## 8. References
Web-verified 29 Sep: Shiller 1993 (J. Finance 48(3):911–931); He, Manela, Ross, von Wachter (arXiv 2212.06888); Ackerer, Hugonnier, Jermann (Mathematical Finance, doi 10.1111/mafi.70018; arXiv 2310.11771); Angeris, Chitra, Evans, Lorig (arXiv 2209.03307; SIAM J. Financial Math.); Schmeling, Schrimpf, Todorov (BIS WP 1087; Management Science); Mackinga, Nadahalli, Wattenhofer (IEEE ICBC 2022, "TWAP Oracle Attacks: Easier Done than Said?"). The others are standard references and were not re-checked this session; confirm venue/year in the write-up.

Shiller (1993) *Measuring Asset Values for Cash Settlement in Derivative Markets: Hedonic Repeated Measures Indices and Perpetual Futures*; He, Manela, Ross, von Wachter, *Fundamentals of Perpetual Futures*; Ackerer, Hugonnier, Jermann, *Perpetual Futures Pricing*; Angeris, Chitra, Evans, Lorig, *A Primer on Perpetuals*; Batog, Boca, Axelsen (2018) *Scalable Reward Distribution on the Ethereum Blockchain*; Avellaneda & Stoikov (2008) *High-frequency trading in a limit order book*; Budish, Cramton, Shim (2015) *The High-Frequency Trading Arms Race*; Gelashvili et al. (2022) *Block-STM*; Qin et al. (2021) *An Empirical Study of DeFi Liquidations*; Schmeling, Schrimpf, Todorov, *Crypto Carry*; Makarov & Schoar (2020) *Trading and Arbitrage in Cryptocurrency Markets*; Pendle V2 whitepaper; Niemerg, Robinson, Livnat (2020) *YieldSpace*; Mackinga et al., *TWAP Oracle Attacks*.
