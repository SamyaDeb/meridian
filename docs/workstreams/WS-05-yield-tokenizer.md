# WS-05 — Funding swap market (fixed-for-floating MON funding)

**Founder:** A (Samya). Hand off to B if WS-01/02 slip past CP1 (TEAM_PLAN §1).
*(File name kept for link stability. PT/YT is deferred per CR-003; its interfaces are in `contracts/src/interfaces/deferred/`.)*

**Goal:** A 30-day fixed-for-floating swap on MON-PERP funding. Long = receive floating, pay fixed. It trades on its own OrderBook instance (price = 1 + APR), accrues per block in O(1) from the perp's F and G indices, and is margined for 24 h of worst-case funding plus an APR shock. This is the "fix it" layer.

## Owned paths
`contracts/src/swaps/**` (FundingSwapMarket, SwapMarginLib), `contracts/test/unit/FundingSwap*.t.sol`, `contracts/test/fuzz/FundingSwap*.t.sol`, `contracts/test/invariant/handlers/FundingSwapHandler.sol`.

## Interfaces
Provides: `IFundingSwapMarket` (is `IMarginEngine`). Consumes: `IFundingRateOracle.latestObservation/observe/averageFundingRate` + `IClearingHouse.indexPrice` on the perp CH; `IOrderBook` (a second instance of WS-01's book); `IInsuranceFund`; `SwapParams/SwapPosition/SwapAccountView`. Mock: `MockClearingHouse.mockAccrue(ΔF, ΔG, rate)` + `MockOrderBook`.

## Task checklist (ordered)
1. [ ] Tests first from MATH_SPEC §6: accrual `net = q·ΔF/1e18 − K·ΔG/(1e18·YEAR)` rounded against the account; both §6.6 worked examples (+143.01 AUSD; locked spread +47.7 AUSD after offset); **fill rule `K += Δq·A` on every fill (never proportional)**; Σq = ΣK = 0 across counterparties; fee in APR·time.
2. [ ] `SwapMarginLib`: MM/IM per §6.4 (three terms incl. PRICE_SHOCK = 0.3 constant), value V per §6.3 (valid for q = 0 locked-spread accounts). Fuzz: margin ≥ 0 across rate paths bounded by cap/δ when liquidation runs within liqHorizon.
3. [ ] `FundingSwapMarket`: collateral (AUSD, same conversion rules), IMarginEngine hooks (price p → APR = p − 1e18), lazy settle on every touch, OI and position caps, `setOrderBook` one-shot.
4. [ ] markApr: median(book mid, last trade ≤ 30 s, realizedApr 8 h) clamped to ±50 APR points around realized.
5. [ ] Liquidation per §6.4: transfer x and K·x/q, equal-and-opposite cash transfer of V_x, then penalty; IF surplus/bad debt.
6. [ ] Maturity: `settleMaturity()` snapshots F, G; afterwards no accrual; only reducing trades; withdraw allowed. Test with a 1-hour maturity.
7. [ ] `FundingSwapHandler` for invariant I9.
8. [ ] Deploy wiring notes for WS-00's DeployPulse (tick 1e14 = 1 bp APR, lot 1,000 MON).

## Acceptance criteria
- Accrual equals `q·Σ I·Δt·(r − Ā)` for fuzzed rate/index paths (± N wei, N = settles).
- `longOI == shortOI`; Σ net accrual over settled accounts ≤ 0 (dust to protocol).
- MM ≈ 5.24% and IM ≈ 7.87% of notional at defaults (30 d, 12% fixed, q = 1); no loops; every entrypoint O(1).
- `ΣK == 0` and `Σq == 0` hold after any fuzzed fill/liquidation sequence.
- Post-maturity: accrual frozen; `Matured` reverts on position-increasing trades.
- Works on the real ClearingHouse + second OrderBook instance at CP2.

## Required tests
Unit, fuzz (accrual, margin, K bookkeeping, rounding), invariant handler, integration with the real CH + OB.

## Out of scope
PT/YT; multiple maturities/rollover; the vault's fixed-rate lock (should-tier, B, after CP2).

## Day budget
D6 accrual + margin (tests first) · D7 book integration, mark, liquidation · D8 maturity + handler · D9 CP2. Optional early start D3 on mocks if A has bandwidth.

## Kickoff prompt
```
You are the engineer for WS-05 (Funding swap market) of Pulse. Founder A owns this lane.
Read CLAUDE.md, docs/TEAM_PLAN.md, docs/PRD.md, docs/MATH_SPEC.md (§1.2, §1.8 and §6 are normative), docs/ARCHITECTURE.md (§2.6, §2.7), docs/INTERFACES.md and docs/workstreams/WS-05-yield-tokenizer.md.
Work only in your owned paths (contracts/src/swaps/**) on branch ws-05-swaps.
Tests first: reproduce the MATH_SPEC §6.6 worked example and the accrual/rounding fuzz tests using MockClearingHouse.mockAccrue, then implement FundingSwapMarket exactly per IFundingSwapMarket.
O(1) accrual from the perp's F and G indices; no loops; round against the account; CEI + nonReentrant on value flows.
If you need an interface change, add a CR to docs/CHANGE_REQUESTS.md and continue.
```
