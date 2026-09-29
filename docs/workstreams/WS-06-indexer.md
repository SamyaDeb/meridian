# WS-06 — Indexer (Envio HyperIndex)

**Founder:** C

**Goal:** Index every Pulse event into entities that power the app: per-block funding history (F, G), oracle APR windows, positions, trades/candles (perp + swap books), liquidations, vault NAV/APY, swap positions/accrual, and protocol metrics for the demo.

## Owned paths
`indexer/**`.

## Interfaces
Consumes: events in `contracts/src/interfaces/*.sol` (INTERFACES §3 entity map), ERC-4626 `Deposit/Withdraw`, Kuru OrderBook trade events (VERIFY ABI at docs.kuru.io/contracts/Integration). ABIs from `abis/` (exported by WS-00). Provides: a GraphQL schema consumed by WS-07 (document it in `indexer/SCHEMA.md`, keep it stable, and announce changes to WS-07 in the PR).

## Task checklist (ordered)
1. [x] Envio supports 143 and 10143 **with HyperSync** (`https://143.hypersync.xyz`, `https://10143.hypersync.xyz`), verified. [ ] Get an Envio API token (app.envio.dev) and check hosted-plan limits. Public RPC `eth_getLogs` is capped at 100 blocks, so don't use RPC mode.
2. [ ] `envio init` (TS handlers), `config.yaml` with networks 31337 (local anvil via DeployLocal), 10143, 143; contract addresses from `deployments/<chainId>.json`.
3. [ ] `schema.graphql`: `Market`, `FundingTick(id=market-block, block, rate, premium, emaPremium, cumFunding, index, mark, timestamp)`, `Trade`, `Candle1m`, `Candle1h`, `Order`, `Account`, `AccountMarket(collateral, size, openNotional, fundingPaid, realizedPnl, feesPaid)`, `Liquidation`, `VaultSnapshot`, `VaultUser`, `FundingCheckpoint`, `SwapPosition`, `SwapTrade`, `SwapStats(markApr, realizedApr, OI)`, `ProtocolStats(users, volume, fees, tvl)`.
4. [ ] Handlers on mock events: run `DeployLocal` + a script that emits every event type; snapshot tests.
5. [ ] Derived fields: realized funding APR over 1 h / 8 h / 24 h = ΔF/ΔG·YEAR (MATH_SPEC §1.8), vault 24h/7d APY from `NavSnapshot`, swap fixed APR = price − 1.
6. [ ] Hosted deployment on testnet (CP2), then mainnet (CP3). Export a public GraphQL URL for the write-up.

## Acceptance criteria
- Local: every event type in the interfaces is handled (a checklist in `indexer/SCHEMA.md`).
- Funding ticks for every block in which `FundingUpdated` fired, with no gaps (compare counts with `eth_getLogs`).
- Indexer lag < 2 s p95 on testnet (log it for B8).
- `ProtocolStats` numbers match an independent `eth_getLogs` recount on a sample block range.

## Required tests
Envio handler unit tests (mock events → entities) for every handler; a replay test on a recorded testnet block range.

## Out of scope
Frontend; offchain liquidation logic (the keeper may query you).

## Day budget
D1 schema · D2 handlers on mocks · D3 local-node indexing · D5 CP1 · D6 vault entities · D7 swap + oracle entities · D9 CP2 · D10 hosted testnet · D11 mainnet config · D12 CP3 live.

## Kickoff prompt
```
You are the engineer for WS-06 (Envio HyperIndex indexer) of Pulse.
Read CLAUDE.md, docs/TEAM_PLAN.md, docs/PRD.md, docs/INTERFACES.md (especially §3 event→entity map and the verbatim event definitions), docs/ARCHITECTURE.md (§0 R20) and docs/workstreams/WS-06-indexer.md.
Work only in indexer/ on branch ws-06-indexer.
First verify Envio support for Monad chain 143/10143 from docs.envio.dev. Then design schema.graphql and write handler tests against the frozen event signatures; run against a local anvil deployment from WS-00's DeployLocal script (or emit events from a tiny local script if it isn't ready yet).
Publish indexer/SCHEMA.md so WS-07 can build against it.
```
