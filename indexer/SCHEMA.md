# Pulse indexer: GraphQL schema for the app (WS-06 → WS-07)

Source of truth: [`schema.graphql`](schema.graphql). This page is the contract for WS-07. Changes are announced in the WS-06 PR description.
Engine: Envio HyperIndex 3.12.1 (Hasura GraphQL). Networks: 31337 (local anvil via `DeployLocal`, RPC), 10143 and 143 (HyperSync, no RPC mode).

| Network | Config | Public GraphQL URL |
|---|---|---|
| 31337 local | `config.yaml` | `http://localhost:8080/v1/graphql` (`pnpm dev`) |
| 10143 testnet | `config.testnet.yaml`; Envio Cloud uses `config.hosted.testnet.yaml` (branch `ws-06-envio-live`, Root Directory `indexer`) | `https://indexer.dev.hyperindex.xyz/9395e07/v1/graphql` (Envio Cloud, Development plan, deployment `af7e9cf`, read from the dashboard 6 Oct 2026). **On this plan every deployment gets a new URL** (`35ed19f` was `…/8ba06c6/…`); a stable one needs "Promote to production", which is a paid-plan feature. Every push to `ws-06-envio-live` is a new deployment (3 per indexer on the free plan, 2 used): after one, update `NEXT_PUBLIC_INDEXER_URL` wherever the app runs |
| 143 mainnet | `config.mainnet.yaml` (`pnpm gen-config 143`) | > VERIFY: hosted URL after CP3 |

## Conventions (read first)
- **Every BigInt arrives as a decimal string in JSON.** Parse with `BigInt(x)`. Money math stays in bigint, and floats are for display only.
- Suffixes: `*Wad` = 1e18 fixed point. `*Token` = AUSD token units (6 dp). `rate` = per-second WAD. `*AprWad` = APR as WAD (`0.1e18` = 10%): display `Number(aprWad) / 1e18`.
- Addresses are EIP-55 checksummed strings. Ids are per chain (`disable_default_cross_chain`), so every row also has `chainId`. Always filter on `chainId`.
- Signs follow INTERFACES §2.8: `size > 0` long. `fundingPaid > 0` = the account paid. `fee < 0` = rebate.
- Event-derived mirrors (`AccountMarket`, `SwapPosition`) are for lists and history. For the live, exact position (pending funding at mark, margin), call the contract views (`getAccount`, `previewFundingState`, swap `getAccount`).

## Entities
| Entity | Id | Key fields | Screen |
|---|---|---|---|
| `Market` | ClearingHouse address | `symbol`, **`testMarket`** (labelled TEST market: deployments `demoMarket` or a `-DEMO` symbol, e.g. testnet `MON-PERP-DEMO` — show "test market", never mix into product stats), `lastRate`, `lastRateAprWad`, `lastCumFunding` (F), `lastCumIndexTime` (G), `lastMarkPrice`, `lastIndexPrice`, `realizedApr1hWad / 8hWad / 24hWad`, `lastTradePrice`, `volumeQuoteWad`, `openInterestLongWad / ShortWad`, `feesWad`, `paused`, `blockTimeMs` | Trade header, Stats |
| `FundingTick` | `<market>-<block>` | `block`, `timestamp`, `rate`, `rateAprWad`, `premium`, `emaPremium`, `cumFunding`, **`cumIndexTime`**, `index`, `mark` | per-block funding chart |
| `FundingCheckpoint` | `<market>-<block/200>` | `slot`, `blockNumber`, `cumFunding`, `cumIndexTime`, `realizedApr1h/8h/24hWad` | oracle APR history (~60 s) |
| `Order` | `<book>-<orderId>` | `kind` (Perp/Swap), `market`, `maker`, `isBid`, `tick`, `lots`, `remainingLots`, `filledLots`, `status` (Open/PartiallyFilled/Filled/Cancelled/Evicted) | open orders |
| `MakerFillSkip` | `<block>-<logIndex>` | `kind`, `book`, `market`, `orderId`, `order` (Order id), `maker`, `timestamp`, `txHash`. CR-007: the engine refused a fill on a resting order because the market refuses new risk (paused / oracle stale); the `Order` stays Open and unchanged, matching stopped at it (an `OrderEvicted` instead closes it as Evicted) | MM ops, Stats |
| `Trade` | `<block>-<logIndex>` | `kind`, `market` (perp) / `swapMarket`, `maker`, `taker`, `takerIsBid`, `priceWad`, `sizeWad`, `notionalWad`, `aprWad` (swap), `timestamp`, `txHash` | trade tape |
| `Candle1m`, `Candle1h` | `<market>-<bucketStart>` | `open/high/low/close` (WAD), `volumeBaseWad`, `volumeQuoteWad`, `trades` | price chart (perp only) |
| `Account` | address | `firstSeenBlock`, `tradeCount`, `volumeQuoteWad`, `countedExternal` | — |
| `AccountMarket` | `<market>-<account>` | `size`, `openNotional`, `entryPrice`, `collateralWad`, `fundingPaid`, `realizedPnl`, `feesPaid`, `reservedOrderMargin`, `lastCumFunding`, `liquidationCount` | Positions |
| `Liquidation` | `<block>-<logIndex>` | `kind`, `account`, `liquidator`, `sizeTransferred`, `markPriceWad` / `markAprWad`, `penalty`, `badDebt` | Positions history, Stats |
| `Vault` | vault address | `navToken`, `totalShares`, `sharePriceWad`, `hedged`, `apy24hWad`, `apy7dWad`, `lastRebalanceReason`, `userCount` | Earn |
| `VaultSnapshot` | `<block>-<logIndex>` | `navToken`, `sharePriceWad`, `fundingAccruedWad`, `timestamp` | NAV chart |
| `VaultUser` | `<vault>-<user>` | `shares`, `depositedToken`, `withdrawnToken` | Earn (my position) |
| `VaultRebalance`, `HedgeTrade` | `<block>-<logIndex>` | reason, deltas, Kuru fills | Earn activity |
| `SwapStats` | swap market address | `markAprWad` (last traded), `realizedApr8hWad`, `openInterestWad`, `volumeWad`, `matured`, `cumFundingAtMaturity` | Fix |
| `SwapPosition` | `<swapMarket>-<account>` | `size` (q), `fixedAprNotional` (K), `avgFixedAprWad`, **`lockedSpread`**, `netAccrued`, `floatingReceived`, `fixedPaid`, `collateralWad` | Fix (my swap) |
| `SwapTrade` | `<block>-<logIndex>` | `sizeDelta`, `newSize`, `aprWad`, `fee`, `isMaker` | Fix history |
| `OraclePrice`, `OracleGuardTrip` | `<block>-<logIndex>` | index price pushes, deviation trips | Stats / ops |
| `InsuranceFund`, `BadDebtEvent` | address / `<block>-<logIndex>` | `fundedToken`, `coveredToken` | Stats |
| `ProtocolStats` | `"protocol"` | **product stats** (test markets excluded): `externalUsers`, `users`, `perpVolumeQuoteWad`, `perpVolumeMmQuoteWad`, `swapVolumeWad`, `feesWad`, `tvlToken`, `trades`, `liquidations`, `fundingTicks`, `updatedBlock` | Stats (metrics dashboard) |
| `KeeperReport` | `<block>-<logIndex>` | CRE `action`, `success`, `workflowId` | ops |
| `AdminEvent` | `<block>-<logIndex>` | `name`, `data` (JSON, bigints as strings) | ops |

## Derived values (bigint, unit-tested in `test/math.test.ts`)
- **Bad-debt split (PHASES 36, 6 Oct).** Liquidation bad debt runs IF → accrued protocol fees → uncovered. Perp: `BadDebtSocialized(requested, coveredByInsurance, uncovered)` (WAD) fires whenever the IF falls short; **fee-covered part = `requested − coveredByInsurance − uncovered`** (no separate event; can be > 0 with `uncovered = 0`). No event ⇒ the IF covered all of `Liquidated.badDebt`. Swap: no `BadDebtSocialized` on `IFundingSwapMarket`; derive from `SwapLiquidated.badDebt` and the InsuranceFund's `BadDebtCovered(market, requestedToken, coveredToken)` in the same tx: IF part = `min(coveredToken·1e12, badDebt)`, fees + uncovered = the rest (split them by reading `totalBadDebt()` at that block if needed). `BadDebtEvent` should store `feeCoveredWad` for the perp.
- **Realized funding APR (oracle), MATH_SPEC §1.8.** `avgRate = (F₂ − F₁)·1e18 / (G₂ − G₁)`, `aprWad = avgRate · 31,536,000`, display `aprWad / 1e18`. (F₂, G₂) comes from the latest `FundingUpdated`. (F₁, G₁) is the `FundingCheckpoint` at or before `block − window`, with `window = seconds·1000/blockTimeMs` (1 h = 12,000 blocks at 300 ms). This is the same semantics and operation order as `averageFundingApr(blocksAgo)`. It is `null` until the window has history.
- **Rate APR:** `rateAprWad = rate · 31,536,000`.
- **Vault APY:** simple annualized share-price change vs the hourly price 24 h / 7 d back: `(sp₁ − sp₀)·1e18·YEAR / (sp₀·Δt)`. `null` means not enough history, so the app shows "Waiting for funding…" (never a fake APY).
- **Swaps:** `aprWad = priceWad − 1e18`. `K += Δq·A/1e18`. `avgFixedAprWad = K·1e18/q`. **`lockedSpread = (q == 0 && K != 0)`**: show "locked +x AUSD until maturity", not zero.
- **Perp mirror:** `openNotional` follows MATH_SPEC §3.1 (released rounds toward +∞). `entryPrice = |ON|·1e18/|q|`.
- **TVL** (`tvlToken`) = net AUSD deposited into the perp ClearingHouse + swap market + the vault's last NAV (event-derived).
- **Product stats (C5, RISKS E9).** Events of a labelled test market never change `ProtocolStats` (they stay on that `Market`). `externalUsers` counts an account once, at its first product-market activity, unless it is the vault or an operator account. Operators come only from the deploy record: `deployments/<chain>.json` optional `mmAccounts` and `keeperAccounts` arrays, plus `owner` (`scripts/gen-config.mjs` → `OPERATOR_ACCOUNTS`). `perpVolumeMmQuoteWad` is the part of `perpVolumeQuoteWad` where an `mmAccounts` address was maker or taker (counted once), so the dashboard can show "MM share". `updatedBlock` = the last block that changed any of these numbers.

## Example queries
```graphql
# Trade header + funding ticker (poll or subscribe; the app also calls previewFundingState() per block)
query Market($chainId: Int!, $ch: String!) {
  Market(where: { chainId: { _eq: $chainId }, id: { _eq: $ch } }) {
    symbol lastRate lastRateAprWad lastMarkPrice lastIndexPrice lastFundingBlock
    realizedApr1hWad realizedApr8hWad realizedApr24hWad openInterestLongWad openInterestShortWad
  }
}
# Per-block funding chart (last 600 blocks ≈ 3 min)
query Ticks($chainId: Int!, $ch: String!) {
  FundingTick(where: { chainId: { _eq: $chainId }, market_id: { _eq: $ch } }, order_by: { block: desc }, limit: 600) {
    block timestamp rate rateAprWad cumFunding cumIndexTime mark index
  }
}
# My positions
query Me($chainId: Int!, $me: String!) {
  AccountMarket(where: { chainId: { _eq: $chainId }, account_id: { _eq: $me } }) {
    market_id size openNotional entryPrice collateralWad fundingPaid realizedPnl feesPaid
  }
  SwapPosition(where: { chainId: { _eq: $chainId }, account_id: { _eq: $me } }) {
    swapMarket size fixedAprNotional avgFixedAprWad lockedSpread netAccrued collateralWad
  }
  VaultUser(where: { chainId: { _eq: $chainId }, user: { _eq: $me } }) { vault shares depositedToken withdrawnToken }
}
# Earn: vault + NAV chart
query Earn($chainId: Int!) {
  Vault(where: { chainId: { _eq: $chainId } }) { id navToken sharePriceWad hedged apy24hWad apy7dWad lastRebalanceReason }
  VaultSnapshot(where: { chainId: { _eq: $chainId } }, order_by: { block: desc }, limit: 500) { timestamp sharePriceWad navToken }
}
# Stats
query Stats($chainId: Int!) {
  ProtocolStats(where: { chainId: { _eq: $chainId } }) { externalUsers users perpVolumeQuoteWad perpVolumeMmQuoteWad swapVolumeWad feesWad tvlToken trades liquidations fundingTicks updatedBlock }
}
```
Root fields (introspected on the 10143 Envio Cloud endpoint, 6 Oct 2026): one list field per entity (`Market`, `Trade`, `Candle1m`, …) plus `<Entity>_by_pk`; **no `_aggregate` fields**. Every entity has `chainId`. Relations are exposed as `<field>_id` on `FundingTick`, `Trade` (`market_id`), `AccountMarket`; `Candle1m` / `Candle1h` store the market as a plain `market` string (no `market_id`).

## Event coverage checklist (acceptance: every interface event is handled)
Enforced by `test/config.test.ts`, which diffs `abis/*.json` and `contracts/src/interfaces/*.sol` against the config, and every configured event against a handler.

| Contract (config name) | Events | Handler |
|---|---|---|
| ClearingHouse (`IClearingHouse` + `IFundingRateOracle`) | Deposited, Withdrawn, FundingUpdated, FundingSettled, PositionChanged, Liquidated, BadDebtSocialized, OrderMarginChanged, FeesCollected, RiskParamsUpdated, FundingParamsUpdated, PausedSet, FundingCheckpoint | `src/handlers/clearingHouse.ts` |
| OrderBook, SwapOrderBook (`IOrderBook`) | OrderPlaced, OrderCancelled, OrderEvicted, MakerFillSkipped, Trade | `src/handlers/orderBook.ts` |
| FundingSwapMarket | Deposited, Withdrawn, SwapPositionChanged, SwapAccrualSettled, SwapLiquidated, MaturitySettled, SwapParamsUpdated | `src/handlers/fundingSwap.ts` |
| PulseVault (`IPulseVault` + ERC-4626) | Deposit, Withdraw, Transfer, Rebalanced, HedgeExited, HedgeEntered, NavSnapshot, VaultParamsUpdated, KeeperUpdated (`Approval` intentionally skipped) | `src/handlers/vault.ts` |
| KuruHedger | SpotBought, SpotSold | `src/handlers/vault.ts` |
| OracleAdapter | PriceUpdated, DeviationGuardTripped, OracleParamsUpdated | `src/handlers/periphery.ts` |
| InsuranceFund | Funded, BadDebtCovered, MarketAuthorized | `src/handlers/periphery.ts` |
| MarketFactory | MarketRegistered (also registers the new OB/CH/oracle), MarketStatusChanged | `src/handlers/periphery.ts` |
| PulseKeeperReceiver | ReportExecuted, ForwarderUpdated | `src/handlers/periphery.ts` |

**Replay evidence on real chain data** (handlers via `createTestIndexer` simulate): `test/replay.test.ts` = the Phase 2 perp stack (`fixtures/anvil-e2e.json`); `test/replay-fullstack.test.ts` = the Phase 4 full-stack rehearsal (`fixtures/anvil-fullstack-10143.json`: perp + vault + hedger + funding swaps, 97k blocks of funding history, keeper rebalances incl. SkewCap, a crash liquidation, swap maturity). It checks every vault/hedger/swap event type recorded, and entities against the contracts' own answers at the same block: `VaultSnapshot.sharePriceWad` = `sharePrice()`, `VaultUser.shares` = `balanceOf`, Σ shares = `totalSupply`, `SwapPosition` q/K = `getPosition`, Σq = ΣK = 0, OI, the maturity snapshot, and realized 8 h APR = `FundingSwapMarket.realizedApr(96,000)` = `averageFundingApr(96,000)`. `SwapLiquidated`, `Withdrawn` (swap), `Withdraw` / `HedgeExited` (vault) did not occur in the rehearsal; they are covered by the unit tests with synthetic events.

Not indexed yet: Kuru OrderBook trade events (WS-06 "Consumes"; > VERIFY ABI at docs.kuru.io/contracts/Integration).

## Known approximations (tell WS-07)
- `AccountMarket.collateralWad` doesn't credit a liquidator's `keeperReward`: whether it's paid into CH collateral or as tokens isn't specified (> VERIFY with WS-02).
- `SwapStats.markAprWad` is the last traded APR. The contract's `markApr` is a median with book mid and realized 8 h (MATH_SPEC §6.3), so read `markApr()` for margin-grade values.
- `SwapTrade` is one row per `SwapPositionChanged` (maker and taker legs), so there are 2 per book fill; the book's `Trade` rows have `kind: "Swap"`.
- The local mock deployment (31337) has no MarketFactory / FundingSwapMarket / SwapOrderBook / KeeperReceiver yet. Those contracts get indexed once they're in `deployments/<chainId>.json`: rerun `pnpm gen-config <chainId>`.

## Commands
```bash
pnpm install                  # repo root (pnpm workspace)
cd indexer
pnpm gen-config 31337             # regenerate config.yaml + src/deployments.gen.ts from deployments/
pnpm test                     # codegen + vitest (handlers via simulate, math, config)
pnpm dev                      # local indexer against anvil (needs Docker for Postgres/Hasura)
```
