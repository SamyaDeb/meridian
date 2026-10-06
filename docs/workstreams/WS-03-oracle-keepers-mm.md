# WS-03 — Oracle adapter, keepers (Chainlink CRE + TS fallback), MM bot

**Founder:** B

**Goal:** Fresh, guarded index prices onchain; a TS keeper for funding pokes, perp + swap liquidations, `settleMaturity` and vault rebalances (with Kuru Flow routes); an Avellaneda–Stoikov MM bot quoting the perp book and the swap book (around the oracle's realized APR). Chainlink CRE is **should-tier**: only if deploy access (gated) arrives by Day 7.

## Owned paths
`contracts/src/oracle/**`, `contracts/src/automation/**`, `contracts/test/unit/{Oracle,KeeperReceiver}*.t.sol`, `keepers/**`, `mm-bot/**`.

## Interfaces
Provides: `IOracleAdapter`, `IMeridianKeeperReceiver`. Consumes: `IClearingHouse` (updateFunding, liquidate, getAccount, isLiquidatable, averageFundingApr), `IFundingSwapMarket` (liquidate, settleMaturity, markApr), `IMeridianVault` (needsRebalance, rebalance, rebalanceWithRoute), `IOrderBook` (place/replace/cancel, views), external `IPythMinimal`, `AggregatorV3Interface`, `IKuruOrderBook` (vault spot leg / reviving Kuru MON/AUSD). Mocks: `MockAggregatorV3`, `MockClearingHouse`, `MockOrderBook`, `MockMeridianVault`.

## Task checklist (ordered)
1. [x] Verified by planning (ARCHITECTURE R11, R12, R14): Pyth MON/USD id `0x3149…6cd1` (sponsored push every 10–30 s), Chainlink MON/USD updates minutes apart (guard only), KeystoneForwarder addresses. Remaining: [ ] CRE deploy access for our org, [ ] `cre workflow supported-chains` capabilities, [ ] exact Chainlink heartbeat (data.chain.link).
1b. [ ] If CR-002 is approved: keeper fetches a Kuru Flow route (`POST ws.kuru.io/api/quote`, JWT via `/api/generate-token`, 1 rps) and passes it to `rebalanceWithRoute`.
1c. [ ] MM bot also quotes **Kuru MON/AUSD** (market `0x131a…0da9`, currently dead), hedging inventory on Kuru MON/USDC. This revives the market for the Kuru bounty and gives the vault a direct route.
2. [ ] `oracle/PythChainlinkOracleAdapter.sol`: Pyth primary (expo → WAD, reject `conf/price > 1%`), Chainlink secondary guard (`|p−s|/s ≤ maxDeviation`, else `PriceDeviation`; if Chainlink stale, primary alone is allowed), staleness `maxStaleness` (default 10 s primary). `updatePrice` pays the Pyth fee and refunds the excess (nonReentrant).
3. [ ] Unit tests with mock Pyth + `MockAggregatorV3`; fork test against mainnet Pyth/Chainlink (read-only).
4. [ ] `keepers/ts-fallback` (viem, TS strict): loops per block: (a) push Pyth update (Hermes API) when the onchain price is older than 3 s or moved > 5 bps; (b) `updateFunding` if no touch for 20 blocks; (c) liquidation scan using the indexer (fallback: recent `PositionChanged` accounts) → `liquidate`; (d) `vault.needsRebalance()` → `rebalance()`. Tight gas limits (gas-limit billing, ARCHITECTURE R6). Nonce manager. Health endpoint.
5. [ ] `mm-bot` (viem): A–S quoting per MATH_SPEC §4 **in bps units** (γ = 0.01/bps, k = 0.5/bps, T−t = 60 s ⇒ ≈ 5.9 bps spread at 100% vol) on Meridian MON-PERP (3 levels per side via `replaceOrder`); inventory limits; kill switch; then the funding-swap book (quote around the oracle's realized 8 h APR ± spread, inventory-skewed); optionally revive Kuru MON/AUSD hedged on Kuru MON/USDC.
6. [ ] `automation/MeridianKeeperReceiver.sol`: ERC-165 + `onReport` (only forwarder), action decoding per the interface NatSpec, bounded arrays (≤ 32), try/catch per action, `ReportExecuted`.
7. [ ] `keepers/cre`: CRE workflows (TS SDK): cron → rebalance check; log trigger/cron → liquidation scan; cron → oracle push. Simulate locally (`cre workflow simulate`), deploy to Monad testnet then mainnet. VERIFY CRE deploy access.
8. [ ] Runbooks `keepers/README.md`: env, start/stop, alerts.

## Acceptance criteria
- Adapter reverts on stale / deviating / non-positive / low-confidence prices; returns WAD for any Pyth expo in [−18, 0].
- TS keeper keeps the testnet market's `FundingUpdated` gap ≤ 20 blocks with zero organic traffic and liquidates a test account within ≤ 3 blocks of eligibility (log it for B7).
- MM bot keeps a two-sided book with spread ≤ 20 bps around index on testnet for 1 h unattended.
- A CRE workflow executes at least one `rebalance` and one `LIQUIDATE` report on testnet (`ReportExecuted` events).

## Required tests
Foundry unit + fork tests for the adapter and receiver; vitest for quoting math (A–S formulas vs. hand-computed values) and keeper decision functions (pure functions, no RPC).

## Out of scope
Contract logic of CH/OB/vault; frontend; indexer.

## Day budget
D1–2 adapter + tests · D3 TS keeper · D4 MM bot · D5 CP1 (bots on testnet) · D6 receiver + CRE · D7 CRE testnet · D8 CRE rebalance · D9 CP2 · D10 MM mainnet config · D11 runbooks · D12 CP3 bots live · D13 monitor.

## Kickoff prompt
```
You are the engineer for WS-03 (Oracle adapter, keepers with Chainlink CRE + TS fallback, MM bot) of Meridian.
Read CLAUDE.md, docs/TEAM_PLAN.md, docs/PRD.md, docs/ARCHITECTURE.md (§0 research table incl. R23–R25), docs/MATH_SPEC.md (§1.6, §4), docs/INTERFACES.md, docs/BOUNTY_MAP.md (Chainlink row) and docs/workstreams/WS-03-oracle-keepers-mm.md.
Work only in your owned paths on branch ws-03-oracle-keepers-mm.
Task 1 is verification: confirm the Pyth feed ID, Chainlink heartbeat, CRE forwarder and capabilities on Monad from official docs, and never guess them.
Then build the oracle adapter tests-first, then the TS keeper, then the MM bot (perp book, then swap book). Build the CRE receiver + workflows only if CRE deploy access was granted.
Use viem only, strict TypeScript, tight gas limits (Monad bills gas limit). Pyth Hermes needs an API key (R24); without one, use the sponsored onchain feed. Build against the mocks until WS-01/02/04 merge.
```
