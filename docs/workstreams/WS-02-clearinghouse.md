# WS-02 — ClearingHouse: margin, funding, mark, liquidation, insurance

**Founder:** A (Samya)

**Goal:** Per-market isolated-margin accounting with O(1) per-block funding (two indices: F and G), a public funding-rate oracle (checkpoint ring buffer, IFundingRateOracle), (EMA premium, clamp, δ-cap, cumulative index), median-of-three mark, liquidation with keeper reward, insurance fund and bad-debt path. This is the core judges will read, so it has to be exact, rounded against the user, and heavily tested.

## Owned paths
`contracts/src/clearing/**` (ClearingHouse, InsuranceFund, MarketFactory), `contracts/src/libs/**` (FundingLib, MarkPriceLib, MarginLib, SignedMath helpers), `contracts/test/unit/{ClearingHouse,Funding,Mark,Margin,Liquidation,InsuranceFund,MarketFactory}*.t.sol`, `contracts/test/fuzz/{Funding,Margin,Mark}*.t.sol`, `contracts/test/invariant/handlers/ClearingHouseHandler.sol`.

## Interfaces
Provides: `IClearingHouse` (is `IMarginEngine` + `IFundingRateOracle`), `IInsuranceFund` (authorize both CH and the swap market), `IMarketFactory`. Consumes: `IOrderBook` views (`midPrice`, `lastTrade`), `IOracleAdapter.tryGetIndexPrice`, `MeridianTypes`. Build against `MockOrderBook` + `MockOracleAdapter` (prank as the OB for hooks).

## Task checklist (ordered)
1. [ ] `libs/FundingLib.sol`: pure `update(state, params, index, fairPrice, blocksElapsed) → newState` per MATH_SPEC §1.2 (F **and G**; δ-clamp then cap-clamp; single fullMulDiv per index; interest default 10.95% APR) including exact `αeff = 1 − (1−α)^n` (pow by squaring in WAD, ↑ on the power), rate clamp, δ·n cap, F accrual with Δt from blocks. `owed(q, F_now, F_entry)` ceil-rounded (§1.4).
2. [ ] `libs/MarkPriceLib.sol`: median-of-three with fallbacks + index band (§2); `fairBookPrice` (§2.2).
3. [ ] `libs/MarginLib.sol`: position update on fill (§3.1), equity/IM/MM (§3.2), liquidation price.
4. [ ] `ClearingHouse.sol` storage (packed funding slot, ARCHITECTURE §3), constructor (AUSD, oracle, IF, params with bounds checks), `setOrderBook` one-shot.
5. [ ] `_touchFunding()` once per block + `updateFunding()` + `FundingUpdated`; stale-oracle behaviour (§1.6). Oracle checkpoint ring buffer (§1.8: 200-block buckets, 1440 slots) + `latestObservation/observe/averageFundingRate/averageFundingApr`.
6. [ ] deposit / depositFor / withdraw (IM check, CEI, SafeERC20, nonReentrant).
7. [ ] OB hooks: reserve/release, `settleMakerFill` (returns false instead of reverting on margin failure), `settleTakerFill` (IM or reduce-only, OI caps, position caps, fees).
8. [ ] `liquidate` (§3.3): partial, liquidator takes position at mark, penalty split, IF surplus transfer, bad debt → `IF.coverBadDebt`, `totalBadDebt`, events.
9. [ ] Views: `getAccount` (AccountView, incl. liquidationPrice), `previewFundingState`, `markPrice`, `indexPrice`, OI, fees.
10. [ ] `InsuranceFund.sol`, `MarketFactory.sol` (registry).
11. [ ] Admin setters with hard bounds (e.g. `mmr < imr ≤ 50%`, `rateCap ≤ 1%/h`, `blockTimeMs ∈ [100, 2000]`), pause, `collectFees`.
12. [ ] `ClearingHouseHandler` for WS-08 invariants I1–I5 and I11 (oracle).

## Acceptance criteria
- **No loop anywhere in CH or libs** except `pow` by squaring (≤ 64 iterations).
- Funding: F written at most once per block (test: two touches in one block leave F and emit once); longs pay when mark > index; worked example MATH_SPEC §1.7 reproduced to 1 wei.
- Rounding: fuzz proves `owed` ≥ exact value, realized pnl ≤ exact, IM ≥ exact, withdraw conversion ↓.
- Funding conservation: fuzz over random positions and ΔF shows `0 ≤ Σ owed ≤ N` wei.
- Liquidation: price drop makes an account liquidatable, `liquidate` succeeds, keeper gets its share, IF gets the rest; underwater account → IF covers; IF empty → `BadDebtSocialized`.
- Gas: first funding touch incremental < 30k including the checkpoint write; later touch < 3k.
- `averageFundingApr(w)` equals ΔF/ΔG·YEAR computed from emitted events (test).

## Required tests
Unit (each function + revert), fuzz (FundingLib, MarginLib, MarkPriceLib incl. fallbacks and median property), invariant handler, integration test with the real OrderBook after WS-01 merges (`test/unit/Integration.t.sol`).

## Out of scope
Cross-margin, ADL execution (only `totalBadDebt` tracking), multi-collateral, order matching, oracle implementation.

## Day budget
D1 libs · D2 accounts/deposit/withdraw · D3 hooks + funding touch · D4 liquidation + IF + factory · D5 CP1 · D6 rounding fuzz · D7 handlers · D8–13 fixes.

## Kickoff prompt
```
You are the engineer for WS-02 (ClearingHouse: margin, funding, mark, liquidation, insurance) of Meridian.
Read CLAUDE.md, docs/TEAM_PLAN.md, docs/PRD.md, docs/MATH_SPEC.md (all of §0–§3, §1.8 and §7 are normative), docs/ARCHITECTURE.md, docs/INTERFACES.md and docs/workstreams/WS-02-clearinghouse.md.
Work only in your owned paths on branch ws-02-clearinghouse.
Start with the task checklist and write tests first: reproduce the MATH_SPEC §1.7 worked example and the rounding-direction fuzz tests before implementing FundingLib/MarginLib.
Implement IClearingHouse (incl. IMarginEngine + IFundingRateOracle), IInsuranceFund and IMarketFactory exactly; use MockOrderBook and MockOracleAdapter until WS-01/WS-03 merge.
O(1) funding, no loops over accounts, round against the user everywhere, CEI + nonReentrant on value flows.
If you need an interface change, add a CR to docs/CHANGE_REQUESTS.md and continue.
```
