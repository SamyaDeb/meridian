# Security review B: A's contracts (Founder B, Phase 5 step B1)

**Scope:** `OrderBook` (433 lines), `TickBitmap`, `ClearingHouse` (877), `InsuranceFund`, `MarketFactory`, `FundingSwapMarket` (703), `FundingLib`, `MarkPriceLib`, `MarginLib`, `SwapMathLib`, `SwapMarginLib`. Read line by line against MATH_SPEC §0–§3, §6, §7, INTERFACES §2 and PHASES decisions 1–11.
**Commit reviewed:** `main` @ `158aa8c` (interfaces-v1.5). **Reviewer:** B. **Date:** 30 Sep 2026.
**PoC tests:** `contracts/test/security/ReviewB.t.sol` (real CH + OB + FundingSwapMarket + swap OB, MATH_SPEC defaults). Each test asserts the *correct* behaviour, so it **fails on today's code** and passes once the finding is fixed. The tests are gated so `forge test` stays green until A lands the fix and removes the gate:
```
cd contracts && REVIEW_B_POC=true forge test --match-path test/security/ReviewB.t.sol -vv
```

## Summary
| ID | Sev | Where | Title | Status |
|---|---|---|---|---|
| B-01 | **High** | `FundingSwapMarket.sol:514-532`, `:374` | Swap `markApr` can be moved ±50 APR points inside one transaction ⇒ healthy accounts liquidated | Open (A), PoC fails today |
| B-02 | **Medium** | `FundingSwapMarket.sol:339-348` | Swap "reduction" judged by \|q\| only: an off-market close grows \|K\| and leaves 0 ≤ equity < MM (IF-funded free option) | Open (A), PoC fails today |
| B-03 | Low | `ClearingHouse.sol:485-487` | Perp voluntary reduction at an off-market price can leave equity < MM (decision 4 only requires ≥ 0) | Open (A decides) |
| B-04 | Low | `OrderBook.sol:359-361`, `ClearingHouse.sol:489-490` | **CR-007:** a taker evicts ≤ 32 increasing makers per tx while paused / oracle stale, at no cost | **Rated Low; recommend not applying CR-007 before the freeze** |
| B-05 | Low | `ClearingHouse.sol:534`, `FundingSwapMarket.sol:386` | Liquidation size isn't lot-aligned ⇒ unclosable dust positions | Open (A) |
| B-06 | Low | `ClearingHouse.sol:644-662, 857-860` | Changing `imr` with open orders corrupts the perp reservation (phantom or missing reserve) | Open (A); ops rule in RUNBOOK (B) |
| B-07 | Low | `FundingSwapMarket.sol:621-622` | Swap bad debt after maturity is never covered: `_mm = 0` once τ = 0, so no liquidation ⇒ last withdrawers short | Open (A) |
| B-08 | Low | `FundingSwapMarket.sol:198-207, 339-357` | Swap trades keep opening risk at the perp's *last good* index while the perp oracle is stale | Open (A) |
| B-09 | Low | `ClearingHouse.sol:374-383`, `MarkPriceLib.sol:36-51` | Perp mark manipulation (RISKS E2) is bounded by the 5% band but not by the per-block cache (cancels don't touch funding) | Accept / monitor |
| B-10 | Info | `FundingLib.sol:22-48` | After a long keeper gap, one premium sample dominates the EMA and the new rate is applied to the whole gap | Accept (keeper liveness, watcher alert) |
| B-11 | Info | `FundingSwapMarket.sol:188-193` | Maturity snapshot includes accrual up to the first touch ≥ maturity | Accept (keeper `settleMaturity` ≤ 1 s) |
| B-12 | Info | `ClearingHouse.sol:224, 591` | `totalBadDebt` is cumulative ("ever socialized"), not reduced when a deposit repays negative collateral | Doc fix (natspec like FSM:99) |
| B-13 | Info | `ClearingHouse.sol:523`, `FundingSwapMarket.sol:375` | Self-liquidation guard is bypassed by a second address (recovers keeperShare of own penalty) | Accept |
| B-14 | Info | `TickBitmap.sol:14` | 2^24 ticks: perp max price 16.78 AUSD at tick 1e-6 (≈ 575× MON today) | Accept for MON-PERP |
| B-15 | Info | `InsuranceFund.sol:37-43` | One shared IF: any authorized market can drain it for its own bad debt | Accept (owner = Safe) |

No finding breaks conservation (I1, I2, I3, I9) on its own. B-01 and B-02 are **economic**: value moves between accounts through the liquidation or trade price, and the IF absorbs what an account can't pay.

---

## B-01 (High): swap `markApr` can be moved ±50 APR points inside one transaction
**Where:** `FundingSwapMarket._markApr` (514-532), used by `liquidate` (374), `isLiquidatable`, `_equity`, `_mm`.
**Description.** The perp mark is cached once per block at the first touch (decision 2). The swap mark is not cached: every call recomputes `median(book mid APR, last trade APR ≤ 100 blocks, realizedApr 8 h)` from the live swap book, and clamps it only to realized ± **50 APR points** (`MARK_BAND_APR = 0.5e18`). An attacker who moves two of the three inputs (book mid and last trade) sets the mark anywhere in that band, then liquidates in the same transaction. At τ = 30 d a 50-point move changes V by 50 × 30/365 ≈ **4.1 % of notional**. The IM–MM gap at inception is 7.87 − 5.24 = 2.6 %, and the moved mark also raises the price-shock term, so any account below ≈ 1.5× IM becomes liquidatable.
**Failure scenario (PoC `test_B01_swapMarkAtomicManipulationLiquidatesHealthyAccount`, fails today).** alice is long 100,000 MON at 11.00 % with 300 AUSD, and healthy. In **one transaction**, attacker X sweeps the MM's 5-lot bid at 10.90 % (a fair trade). X then rests an ask at −38 %, Y buys 1 lot from it (last trade −38 %), and X/Y rest −38 % / −40 % quotes. Result: markApr **+10.94 % → −38.00 %**, alice's equity **299.40 → 182.73 AUSD < MM 187.03** ⇒ liquidatable. The liquidator takes alice's long at the manipulated mark and receives |V_x| ≈ 117 AUSD in cash plus the keeper share, for a position worth ≈ 0 at the true APR. The attack costs two taker fees and 1 lot of self-trade. Launch caps bound the dollar size, but the attack is atomic and needs no capital beyond the victims' IM.
**Suggested fix (no interface change).**
1. Clamp markApr to realized ± `aprMoveBuffer` (0.05 = 5 points) instead of ± 50 points. MM already reserves exactly that implied-APR shock (`_aprShock`, MATH_SPEC §6.4), so a manipulated mark can't push an IM-margined account through MM by more than the buffer covers. `MARK_BAND_APR` is a constant; `aprMoveBuffer` is in `SwapParams` (already bounded ≤ 1e18). MATH_SPEC §6.3 needs the same edit.
2. Cache markApr once per block at the first swap touch, as the perp does (transient `(block, mark)` or one storage slot). Then a same-transaction book change can't move eligibility.
3. Optional: ignore a last trade below a minimum size (e.g. 10 lots) as a mark input.
(1) alone closes the High; (2) makes it structural.

## B-02 (Medium): swap "reduction" judged by |q| only
**Where:** `FundingSwapMarket._check` (339-348): `if (!_increases(a.size, q)) return equity < 0 ? Insufficient : ok`.
**Description.** On the perp, reducing |q| always reduces risk. On the swap, K is **never reduced proportionally** (MATH_SPEC §6.2), and the swap book has no price band. So closing q at an off-market APR turns the position into a large locked stream with V = −K·I·τ/YEAR. The trade passes because it "reduces |q|" and equity ≥ 0, but the MM of the new position (price shock on |K|, worst-case on |K|) can be far above equity. The counterparty (a colluding account) holds the mirror stream at a profit. If the index rises before a keeper liquidates, the account goes insolvent and the IF pays: a free option for the pair.
**Failure scenario (PoC `test_B02_swapReductionAtOffMarketAprLeavesAccountBelowMM`, fails today).** alice (long 100k at 11 %, 300 AUSD) closes reduce-only into a colluding bid at price 0.0001 (APR −99.99 %). The trade succeeds: size 0, equity **34.50 AUSD < MM 79.36 AUSD**, immediately liquidatable. After a +20 % index move, equity is **−18.40 AUSD** (bad debt for the IF). The counterparty gained ≈ 265 AUSD of stream value.
**Suggested fix (no interface change).** Treat a fill as risk-increasing when |q| grows **or** the position's MM grows: `_mm(q_after, K_after) > _mm(q_before, K_before)`. Then it goes through the full IM (and paused/matured) checks. Alternative: require `equity_after ≥ MM_after` on every non-increasing fill where `MM_after > 0`. Either way, a genuine close at a fair APR still passes (|K| shrinks or the locked stream is positive, so MM = 0).

## B-03 (Low): perp voluntary reduction can leave equity < MM
**Where:** `ClearingHouse._checkFill` (485-487).
**Description / scenario.** Same shape as B-02 on the perp, but bounded. A long sells part of its position into a colluding bid far below mark; the realized loss moves to the colluder. Decision 4 only requires equity ≥ 0, so the account keeps the remaining position at 0 ≤ equity < MM. An adverse move before liquidation becomes bad debt. Exposure = remaining |q| (≤ `maxPositionSize` 25k MON ≈ $725) × the move within 1–3 blocks: cents at launch.
**Suggested fix.** If equity ≥ MM before the fill, require equity ≥ MM after it (voluntary trades can't push an account into liquidation); otherwise keep "≥ 0". Or accept for launch (A's call; decision 4 was deliberate).

## B-04 (Low): CR-007 eviction griefing (rating requested by Thu 1 Oct)
**Where:** `OrderBook._visit` (359-361) evicts on `false`; `ClearingHouse._checkFill` returns `Paused`/`OracleStale` for any increasing maker fill; FSM likewise (`Paused`/`Matured`).
**Description.** While the market is paused or the oracle is stale, an IOC taker order evicts every *increasing* maker it touches (≤ 32 per tx). If no maker fills, `filled == 0`, so no taker fill runs and the tx succeeds. The attacker needs no position and no margin; the cost is gas only (≈ 32 × ~25k, ≈ 0.08 MON at the testnet price).
**Rating: Low.**
- No funds move. Evicted reservations are released, and the orders couldn't have filled anyway (increases are blocked while paused or stale).
- Loss = queue priority, plus an empty book for the few blocks until the MM re-quotes. With an empty book the mark collapses to A and the premium sample to 0 (MATH_SPEC §2), the manipulation-resistant fallback, so the grief can't move funding or marks.
- Windows are short: a stale oracle lasts seconds with the keeper heartbeat ≤ 10 s; a pause is rare and owner-driven.
- The MM bot already drops evicted ids (it reads its `OrderEvicted` logs) and re-quotes on its next tick (RUNBOOK §6 "Eviction storm"). B6 adds an alert for `openOrderCount == 0` for > 60 s.
**Recommendation to A:** **don't apply CR-007 before the Sat 10 Oct freeze.** It changes the `IMarginEngine` ABI across OB, CH, FSM, mocks, indexer, MM and app one week before mainnet, for a Low finding with a working operational mitigation. Keep it as a post-hackathon item. If A wants a code change anyway, a non-ABI option: in `_makerFill`, **revert** (instead of returning false) when the fill is increasing **and** the market is paused or stale. Same "stop matching" effect as Skip, but it also reverts the taker's earlier fills in that order, so reducers trade only against reducing makers while paused.

## B-05 (Low): liquidation size isn't lot-aligned
**Where:** `ClearingHouse.liquidate` (534: `x = min(maxSizeWad, |q|)`), `FundingSwapMarket.liquidate` (386).
**Scenario.** A third-party liquidator passes `maxSizeWad = |q| − 1 wei` or any non-multiple of `lotSize`. The liquidatee is left with a sub-lot position it can't close on the book: reduce-only needs whole lots, and a full lot flips the side, which needs IM. The liquidator also holds a non-lot position. Also, bad debt is only routed to the IF on a full close, so a 1-wei remainder keeps negative collateral out of `totalBadDebt`. Our keeper passes the full size, so this only happens with third-party liquidators.
**Fix.** `x = (x == |q|) ? x : x − x % lotSize` (the CH knows the OB's lot size via `IOrderBook(orderBook).lotSize()` at `setOrderBook`, or cache it like `tickSize`); revert if x rounds to 0.

## B-06 (Low): changing `imr` with open orders breaks the perp reservation
**Where:** `_released` uses the *current* `_imr` (857-860); `_storeRisk` can change it at any time.
**Scenario.** Orders are reserved at imr = 20 %. The owner lowers imr to 10 %, and every cancel or fill then releases half, leaving a phantom reservation that permanently cuts the account's withdrawable collateral (`_im` includes `reserved`). Raising imr does the opposite: releases saturate at 0 early and the other orders go under-reserved. The swap market is not affected: it stores size and |K|, not margin.
**Fix.** Store the reservation imr-free (Σ size·price) and apply imr at check time, like FSM. Or, for launch: RUNBOOK rule "change `imr` only after the MMs cancel-all; affected accounts cancel and re-place". **B adds the RUNBOOK rule (B7 mainnet section).**

## B-07 (Low): swap bad debt after maturity is never covered
**Where:** `_mm` returns 0 when `tau == 0` (621-622), so `liquidate` reverts `NotLiquidatable` after maturity.
**Scenario.** An account whose settled accrual exceeds its collateral at maturity (a missed liquidation plus an index move) keeps negative collateral forever. The winners withdraw first; the market's token balance is short by that amount and the last withdrawer can't exit. Nothing routes it to the IF, and `totalBadDebt` doesn't record it. The same gap exists before maturity for a partial liquidation (bad debt only on full close with K = 0).
**Fix (no ABI change).** In `settle(account)`: once `_snapped`, if the settled collateral is < 0, call `_coverBadDebt(account, −collateral)`. The keeper calls `settle` on accounts with negative accrual after `settleMaturity` (B adds this to the keeper).

## B-08 (Low): swap trades use the perp's last good index while the perp oracle is stale
**Where:** `_observe` reads `ch.indexPrice()`, which falls back to `_px.lastIndex` when stale; `_check` has no stale guard.
**Scenario.** During a perp oracle outage, F and G freeze (so nothing accrues, which is consistent), but swap IM/MM/V and fees are computed at a stale index. Risk-increasing swap trades and liquidations continue at a price that may be minutes old. The error is bounded by the price move during the outage and the swap caps.
**Fix.** In `_observe`, call `IOracleAdapter(IClearingHouse(perp).oracle()).tryGetIndexPrice()` (both in the interfaces). If it's not ok, block increases (`OracleStale` isn't in IFundingSwapMarket; reuse `Paused`, or add the error through a CR) and keep reductions, liquidations and withdrawals working.

## B-09 (Low): perp mark manipulation (RISKS E2)
**Where:** `releaseOrderMargin` doesn't touch funding (374-383), so cancels reshape the book before the block's first touch. `MarkPriceLib.markPrice` median + 5 % band.
**Scenario.** Block b−1: the attacker sweeps the MM's 3 levels and prints a 1-lot self-trade at +5 % (last trade fresh for 100 blocks), leaving resting quotes near +5 %. Block b, first touch: the attacker cancels the orders that would pull the mid back (no touch), then liquidates. median(A, B, C) = min(B, C), clamped to I·1.05. Only accounts within 5 % of MM qualify; the liquidator gains ≤ 5 % of the slice. Unlike B-01 this needs two blocks, and the MM re-quotes in between. Our MM quotes with flags 0 (not post-only) around the index, so its re-quote *fills* the attacker's off-market quotes at the attacker's price (the attacker pays for it), though that trade also refreshes the last-trade input at that price.
**Recommendation.** Accept for launch (the band is below mmr = 10 %). Monitor the "last trade > 2 % from index" alert (B6). Post-launch: a minimum last-trade size.

## B-10 … B-15 (Info)
- **B-10:** after an n-block gap, αeff = 1 − 0.998ⁿ (n = 1000 ⇒ 86 %) and the δ-cap allows δ·n, so the first toucher's book state sets the rate applied to the whole gap. Bounded by cap·gap (≤ 0.2 %/h × gap). Keeper liveness is part of the security model; the watcher already alerts on FundingUpdated gaps > 20.
- **B-11:** the snapshot is taken at the first touch ≥ maturity with the perp's *current* F/G, so accrual runs up to that block. The keeper fires `settleMaturity` ≤ 1 s after maturity (testnet evidence), and anyone can call it.
- **B-12:** `IClearingHouse.totalBadDebt` natspec should say "cumulative, ever socialized" as FSM:99 does. A deposit repays the negative collateral (decision 5) but doesn't reduce the counter. The indexer and app must not show it as outstanding debt.
- **B-13:** `account == msg.sender` is cosmetic: a sybil liquidator recovers keeperShare (50 %) of the account's own penalty, so the IF gets only its 50 %. Accept.
- **B-14:** perp MAX price 16.78 AUSD at tick 1e-6; swap max APR ≈ 167,000 %. Fine for MON; a new market needs its own tick.
- **B-15:** the IF is shared by the perp and the swap market; `coverBadDebt` pays the first caller in full. Accept (authorization is owner-only = the Safe).

## Checklist: verified, no finding
- **OB⇄CH protocol (INTERFACES §2):** every hook is `onlyOrderBook` + `nonReentrant` (CH 351-427, FSM 235-306). No token transfer inside hooks. Maker fills run before the single taker fill; `false` ⇒ `_drop(..., evicted = true)` + release. CH→OB calls are views only (`_book`), so there's no reentrancy path through the margin engine (the OB and CH locks are separate, and CH never calls a state-changing OB function).
- **Bounded loops:** `_match` ≤ `MAX_FILLS_PER_ORDER` = 32 visits (fills, evictions and self-trade expiries all count); `cancelOrders` and `getDepth` ≤ `MAX_BATCH`; `MAX_OPEN_ORDERS_PER_ACCOUNT` = 64 on resting orders only; `decayFactor` ≤ 64 iterations; `observe` binary search ≤ 11. No global iteration.
- **Reservation:** release saturates at 0 (CH 857-860; FSM 668-675), ≤ 1 wei per fill (decision 6), except B-06.
- **Funding:** δ-clamp then cap last (FundingLib 41-48); one truncating division per index; `owed` ↑ for both signs; stale ⇒ no accrual, lastUpdateBlock advanced (no retroactive accrual); block-number time base; once per block (`lastUpdateBlock == block.number` early return).
- **Oracle ring:** at most one checkpoint per 200-block bucket, written only on a touch. `observe` returns the checkpoint at or before the target, and consumers use the real ΔG, so a caller choosing `blocksAgo` only picks real history. `averageFundingRate` ∈ [−cap, cap] by |ΔF| ≤ cap·ΔG.
- **Margin/liquidation:** IM/MM/reserve ↑; upnl ↓; released toward +∞; taker notional ↑ buy / ↓ sell; liquidation at mark with the liquidator taking the position; penalty ≤ positive equity; keeper ↓; IF share (sub-token dust → fees); bad debt as negative collateral repaid by deposits (decision 5); OI cap on the order's net result; pause/stale block only increases; reduce-only blocks flips.
- **Swaps:** `net` = one floor division; `kDelta` once per maker fill, taker = −Σ via transient `_kAcc` (ΣK = 0); snapshot exactly once (`_snapped`); liquidation K share truncates identically for both sides; fee ↑ / rebate ↓ in APR·τ; no increases after maturity.
- **Economic E1 (premium spoofing):** EMA α = 0.002/block, spread ≤ 2 % gate, ±5 % sample clamp, δ-cap (≥ 2,000 blocks for a full swing). Moving the 8 h average by x APR points needs x points of premium sustained for hours with real resting two-sided depth. OK.
- **E9 (MM share):** the MM's fills are `isMaker = true` from known addresses, so the indexer can separate MM volume. B reports the MM's volume share at launch (B8).

## Handoff
- **A:** B-01 and B-02 before **Mon 5 Oct 18:00** (fix + remove the `REVIEW_B_POC` gate so the PoCs run in CI); B-05/B-06/B-07/B-08 at A's discretion (all no-ABI); B-03 decision; CR-007: my recommendation is above.
- **C:** fold into `docs/outputs/SECURITY_REVIEW.md`.
- **B (me):** RUNBOOK rule for B-06; keeper `settle` sweep after maturity (B-07 mitigation); watcher alerts for B-04 and B-09.
