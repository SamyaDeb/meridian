# WS-04 — Delta-neutral vault (ERC-4626) + Kuru hedger

**Founder:** B

**Goal:** One-tap AUSD "skew absorber" basis vault: spot MON (via Kuru Flow / Kuru) + short MON-PERP, L = 1.5, earning per-block funding. Its short is capped by other traders' net long skew, it hedges only when the oracle's 8 h funding pays for costs, and NAV is valued at the oracle index (MATH_SPEC §5).

## Owned paths
`contracts/src/vault/**` (MeridianVault, KuruHedger), `contracts/test/unit/{MeridianVault,KuruHedger}*.t.sol`, `contracts/test/fuzz/MeridianVault*.t.sol`, `contracts/test/fork/Kuru*.t.sol`, `contracts/test/invariant/handlers/VaultHandler.sol`.

## Interfaces
Provides: `IMeridianVault`, `IKuruHedger`. Consumes: `IClearingHouse` (deposit, withdraw, getAccount, getPosition, fundingState), `IOrderBook` (placeMarketOrder), `IOracleAdapter` (index), external `IKuruOrderBook`/`IKuruMarginAccount`/`IKuruRouter`, WMON. Mocks: `MockClearingHouse` + `MockOrderBook` + `MockKuruHedger` + `MockOracleAdapter`.

## Task checklist (ordered)
1. [x] Kuru reality check, done by planning (R17–R19c): ABI fixed (CR-001) and fork-tested on MON/USDC. **MON/AUSD on Kuru is dead**, so the spot leg goes through Kuru Flow per **CR-002 (applied)**: `buySpot/sellSpot(…, route)` and `rebalanceWithRoute`. Seed fork tests: `contracts/test/fork/KuruFork.t.sol`, `AusdPermit.t.sol` (run with `MONAD_RPC_URL` set).
2. [ ] `KuruHedger.sol`: stateless buy/sell via `placeAndExecuteMarketBuy/Sell` (IOC/FOK semantics per Kuru docs, `_isMargin=false` unless required), precision conversion (↓ on outputs), minOut enforcement, return tokens to the vault, `bestBidAsk` in WAD.
3. [ ] `MeridianVault.sol` (OZ ERC4626, `_decimalsOffset = 12`): `totalAssets` = NAV per MATH_SPEC §5.3 (index valuation), deposit cap, idle-only deposits.
4. [ ] `shortCapacity` (skew rule §5.2) + `needsRebalance` / `shouldExitHedge` (§5.3: enter iff r̄·7d > 2c; exit iff r̄·3d < −c; hold in between), with reason codes incl. `SkewCap`. Hedge size h = min(N/P, shortCapacity); spot always equals h.
5. [ ] `rebalance()` / `rebalanceWithRoute(route)` actions in ≤ `maxSliceAssets` slices: Deploy, DeltaDrift, MarginLow, ExitHedge, EnterHedge, SkewCap; each with slippage bounds from index; keeper-gated (`setKeeper`); events `Rebalanced`, `NavSnapshot`.
6. [ ] Withdraw path: idle first; else bounded pro-rata unwind (1 spot sell + 1 reduce-only perp buy + CH withdraw); withdrawal fee 5 bps retained; `maxWithdraw` reflects it.
7. [ ] Integration on real CH/OB (after CP1) with MockKuruHedger; then fork test with the real KuruHedger.
8. [ ] `VaultHandler` for invariants I8, I10.

## Acceptance criteria
- MATH_SPEC §5.5 example: 10,000 AUSD at L = 1.5, P = 0.029 ⇒ spot ≈ 206,897 MON, short ≈ −206,897 MON (±1 lot) when capacity allows; with capacity below that, short = capacity and spot matches (netDelta/N < θ).
- Vault never shorts beyond `shortCapacity()`; skew falling triggers `SkewCap` reduction.
- Entry rule off ⇒ vault stays idle and `hedgeState().hedged == false`.
- Price ±20% leaves NAV unchanged within fees (index valuation) and the vault is not liquidatable.
- Positive funding raises share price every block (with MockClearingHouse.mockAccrueFunding and the real CH).
- Negative smoothed funding past threshold ⇒ `ExitHedge` flattens both legs; hysteresis prevents flapping.
- Inflation attack test (first depositor donation) fails to steal > 1 wei-equivalent.
- No keeper action can move > maxSlippage from index.

## Required tests
Unit, fuzz (deposit/withdraw rounding, NAV math), fork (Kuru), invariant handler.

## Out of scope
PT/YT (WS-05), keeper scheduling (WS-03), UI.

## Day budget
D2 Kuru check · D3 hedger · D4 vault on mocks · D5 CP1 · D6 hedger fork tests · D7 vault on real CH/OB, rebalance/exit · D8 withdraw path · D9 CP2 · D10–13 fixes.

## Kickoff prompt
```
You are the engineer for WS-04 (Delta-neutral ERC-4626 vault + Kuru hedger) of Meridian.
Read CLAUDE.md, docs/TEAM_PLAN.md, docs/PRD.md, docs/MATH_SPEC.md (§5 is normative), docs/ARCHITECTURE.md (§0 R16–R19c, §2.5), docs/INTERFACES.md, docs/RISKS.md (T1, T3, E5–E7) and docs/workstreams/WS-04-vault.md.
Work only in your owned paths on branch ws-04-vault.
Task 1 is done (Kuru ABI fixed + fork-tested; MON/AUSD dead ⇒ Kuru Flow route per CR-002). Start from contracts/test/fork/KuruFork.t.sol; never invent Kuru addresses or function names.
Then write tests first and build against MockClearingHouse, MockOrderBook, MockKuruHedger and MockOracleAdapter until WS-01/02 merge.
NAV must be valued at the oracle index for both legs. Shares round down on mint, up on burn.
```
