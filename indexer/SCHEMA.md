# Meridian indexer: GraphQL schema for the app (WS-06 → WS-07)

Source of truth: [`schema.graphql`](schema.graphql). This page is the contract for WS-07. Changes are announced in the WS-06 PR description.
Engine: Envio HyperIndex 3.12.1 (Hasura GraphQL). Networks: 31337 (local anvil via `DeployLocal`, RPC), 10143 and 143 (HyperSync, no RPC mode).

| Network | Config | Public GraphQL URL |
|---|---|---|
| 31337 local | `config.yaml` | `http://localhost:8080/v1/graphql` (`pnpm dev`) |
| 10143 testnet (+ Perpl on 143) | `config.testnet.yaml` (local); Envio Cloud uses **`config.hosted.testnet.yaml`**: Meridian + Perpl on 10143 from block 68,739,694, and Perpl on mainnet 143 from block 109,336,000 (multichain, lean Perpl profile) | **K2 deployment: > VERIFY, filled in after the owner deploys** (new Envio Cloud indexer on `SamyaDeb/meridian`, Root Directory `indexer`). Previous: `https://indexer.dev.hyperindex.xyz/9395e07/v1/graphql` (private repo's `ws-06-envio-live`, older contracts). On the Development plan every deployment gets a new URL, 3 deployments per indexer, and soft limits of **100,000 processed events / 5 GB / 7 days without queries** (then 7 days' grace, 3 days read-only, deletion) plus a hard 30-day lifespan (docs.envio.dev "Deploying Your Indexer", read 7 Oct 2026). The lean Perpl profile keeps the whole indexer at a few thousand events |
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
| `VaultRedeemRequest` (CR-014) | `<vault>-<requestId>` | `owner`, `receiver`, `shares`, `status` (Pending / Claimable / Claimed / Cancelled), `assets` + `unwindCost` (set at fulfilment), `requestedBlock`, `fulfilledBlock`, `claimedBlock` | Earn: my pending withdrawals, Claim button |
| `SwapStats` | swap market address | `markAprWad` (last traded), `realizedApr8hWad`, `openInterestWad`, `volumeWad`, `matured`, `cumFundingAtMaturity` | Fix |
| `SwapPosition` | `<swapMarket>-<account>` | `size` (q), `fixedAprNotional` (K), `avgFixedAprWad`, **`lockedSpread`**, `netAccrued`, `floatingReceived`, `fixedPaid`, `collateralWad` | Fix (my swap) |
| `SwapTrade` | `<block>-<logIndex>` | `sizeDelta`, `newSize`, `aprWad`, `fee`, `isMaker` | Fix history |
| `OraclePrice`, `OracleGuardTrip` | `<block>-<logIndex>` | index price pushes, deviation trips | Stats / ops |
| `InsuranceFund`, `BadDebtEvent` | address / `<block>-<logIndex>` | `fundedToken`, `coveredToken` | Stats |
| `ProtocolStats` | `"protocol"` | **product stats** (test markets excluded): `externalUsers`, `users`, `perpVolumeQuoteWad`, `perpVolumeMmQuoteWad`, `swapVolumeWad`, `feesWad`, `tvlToken`, `trades`, `liquidations`, `fundingTicks`, `updatedBlock` | Stats (metrics dashboard) |
| `KeeperReport` | `<block>-<logIndex>` | CRE `action`, `success`, `workflowId` | ops |
| **`FundingWindow`** (K2.1) | market address | `apr1hWad`, `apr8hWad`, `apr24hWad`, **`apr7dWad`**, `fromBlock1h/8h/24h/7d` (the checkpoint each window starts at), `rateAprWad`, `block` | Trade funding tooltip and ticker, Rates KPIs (`useMarket` overlays them on the contract values) |
| `FundingRingSlot` | `<market>-<slot>` | mirror of the ClearingHouse's 1,440-slot checkpoint ring (`blockNumber`, `cumFunding`, `cumIndexTime`); bounded | internal (window lookups) |
| **`FundingPayment`** | `<block>-<logIndex>` | `account`, `payment` (+ = paid), `cumFunding`, `timestamp`, `txHash` | Positions → Funding tab (whole history) |
| `AccountMarket` (+K2.1) | `<market>-<account>` | as above, plus **`lastTradeBlock`**. Same totals as the brief's names: `fundingPaid` = fundingPaidWad, `realizedPnl` = realizedPnlWad, `feesPaid` = feesPaidWad, `liquidationCount` = liquidations | Positions → all-time row |
| **`InsuranceFundEvent`** | `<block>-<logIndex>-<step>` | `flow` (Funded / PenaltyIn / CoveredByInsurance / CoveredByFees / Uncovered), `direction` (In / Out / None), `kind`, `market`, `account`, `amountWad`, `amountToken`, `requestedWad`, `balanceAfterToken`, `txHash` | K5 waterfall chart |
| `InsuranceFund` (+K2.1) | fund address | plus `penaltyToken`, `balanceToken` (funded + penalties − covered) | Rates |
| **`ProtocolDaily`** | `<dayStart unix s>` | the day's `perpVolumeQuoteWad`, `perpVolumeMmQuoteWad`, `swapVolumeWad`, `feesWad`, `trades`, `liquidations`, `fundingTicks`, `newUsers`, `newExternalUsers`, **`activeExternalUsers`**, and closes `tvlTokenClose`, `perpCollateralTokenClose`, `vaultNavTokenClose`, `perpOpenInterest{Long,Short}WadClose`, `swapOpenInterestWadClose` | K6 metrics page |
| `ProtocolStats` (+K2.1) | `"protocol"` | plus `perpOpenInterestLongWad`, `perpOpenInterestShortWad`, `swapOpenInterestWad` | Stats |
| `VaultRedeemRequest` (+K2.1) | `<vault>-<requestId>` | plus `fulfilledAt`, `fulfilTxHash`, `claimedAt`, `claimTxHash`, `cancelledBlock`, `cancelledAt` | Earn (reader `portfolio.ts`) |
| **`PerplMarket`** (K2.2) | perpId | `name`, `known`, `isMon`, decimals, `lastAprWad`, `lastRatePct100k`, `lastFundingEventBlock`, `lastMarkWad`*, OI*, `liquidations` | Rates |
| **`PerplFunding`** | `<perpId>-<fundingEventBlock>` | `ratePct100k`, `aprWad`, `fundingPriceWad`, `paymentPNS`, `sumPNS`, `overwrites` | Rates, K5 |
| **`PerplLiquidation`** | `<block>-<logIndex>` | `accountId`, `address` (if created in the window), `side`, `liqLots`, `markPriceWad`, `liqPriceWad`, pnl, funding | K5 |
| `PerplAccount` | accountId | `address`, `createdBlock`, collateral totals* | K5 |
| `PerplPosition`* | `<perpId>-<accountId>` | `side`, `lots`, `sizeWad`, `entryPricePNS` (the exchange's own), `depositCNS`, pnl / funding / fees, `open` | K5 (full profile only) |
| **`CrossVenueFunding`** | `<hourStart unix s>` | `meridianAprWad` (realized 1 h), `perplAprWad` (MON rate in force, annualized), `spreadAprWad`, blocks | Rates → "Meridian vs Perpl funding" |
| `AccountDay` | `<dayStart>-<account>` | marker (one active-user count per day) | internal |

\* Filled only by the **full** Perpl profile (positions, mark, collateral events: tests / local / a paid plan). The hosted config uses the **lean** profile (`FundingEventCompleted`, `PositionLiquidated`, `AccountCreated`) to stay under the free plan's 100,000-event soft limit; units and event checks are in [`PERPL_EVENTS.md`](PERPL_EVENTS.md).
| `AdminEvent` | `<block>-<logIndex>` | `name`, `data` (JSON, bigints as strings) | ops |

## Derived values (bigint, unit-tested in `test/math.test.ts`)
- **Bad-debt split (PHASES 36, 6 Oct).** Liquidation bad debt runs IF → accrued protocol fees → uncovered. Perp: `BadDebtSocialized(requested, coveredByInsurance, uncovered)` (WAD) fires whenever the IF falls short; **fee-covered part = `requested − coveredByInsurance − uncovered`** (no separate event; can be > 0 with `uncovered = 0`). No event ⇒ the IF covered all of `Liquidated.badDebt`. Swap: no `BadDebtSocialized` on `IFundingSwapMarket`; derive from `SwapLiquidated.badDebt` and the InsuranceFund's `BadDebtCovered(market, requestedToken, coveredToken)` in the same tx: IF part = `min(coveredToken·1e12, badDebt)`, fees + uncovered = the rest (split them by reading `totalBadDebt()` at that block if needed). `BadDebtEvent` should store `feeCoveredWad` for the perp.
- **Realized funding APR (oracle), MATH_SPEC §1.8.** `avgRate = (F₂ − F₁)·1e18 / (G₂ − G₁)`, `aprWad = avgRate · 31,536,000`, display `aprWad / 1e18`. (F₂, G₂) comes from the latest `FundingUpdated`. (F₁, G₁) is the `FundingCheckpoint` at or before `block − window`, with `window = seconds·1000/blockTimeMs` (1 h = 12,000 blocks at 300 ms). This is the same semantics and operation order as `averageFundingApr(blocksAgo)`. It is `null` until the window has history.
- **Rate APR:** `rateAprWad = rate · 31,536,000`.
- **Vault v2 queue (CR-014).** `Vault.pendingRedeemShares` = shares escrowed by Pending requests (they stay in `totalShares` until fulfilment; the vault's own share balance is NOT a `VaultUser` and doesn't count in `userCount`). `Vault.claimableToken` = AUSD owed to Claimable requests (held by the vault, excluded from `navToken`). A claim adds `assets` to the owner's `VaultUser.withdrawnToken` and to `Vault.withdrawnToken` (the async path emits no ERC-4626 `Withdraw`). Status changes are idempotent: a duplicate fulfil / claim log for an id not in the expected state is ignored. `EmergencyUnwind` (owner/Safe) increments `Vault.emergencyUnwinds` and is logged as an `AdminEvent`.
- **Vault APY:** simple annualized share-price change vs the hourly price 24 h / 7 d back: `(sp₁ − sp₀)·1e18·YEAR / (sp₀·Δt)`. `null` means not enough history, so the app shows "Waiting for funding…" (never a fake APY).
- **Swaps:** `aprWad = priceWad − 1e18`. `K += Δq·A/1e18`. `avgFixedAprWad = K·1e18/q`. **`lockedSpread = (q == 0 && K != 0)`**: show "locked +x AUSD until maturity", not zero.
- **Perp mirror:** `openNotional` follows MATH_SPEC §3.1 (released rounds toward +∞). `entryPrice = |ON|·1e18/|q|`.
- **TVL** (`tvlToken`) = net AUSD deposited into the perp ClearingHouse + swap market + the vault's last NAV (event-derived).
- **Product stats (C5, RISKS E9).** Events of a labelled test market never change `ProtocolStats` (they stay on that `Market`). `externalUsers` counts an account once, at its first product-market activity, unless it is the vault or an operator account. Operators come only from the deploy record: `deployments/<chain>.json` optional `mmAccounts` and `keeperAccounts` arrays, plus `owner` (`scripts/gen-config.mjs` → `OPERATOR_ACCOUNTS`). `perpVolumeMmQuoteWad` is the part of `perpVolumeQuoteWad` where an `mmAccounts` address was maker or taker (counted once), so the dashboard can show "MM share". `updatedBlock` = the last block that changed any of these numbers.

## K2 derived values
- **Realized windows match `averageFundingApr` even on a quiet market.** The indexer mirrors the checkpoint ring (`FundingRingSlot`, ≤ 1,440 rows per market) and looks up "the checkpoint at or before block − window" exactly like `observe()`: newest, then the bucket shortcut, then a binary search (≤ 11 reads). A window is `null` where the contract would revert `ObservationTooOld`. Replay tests compare against the contract's answers at recorded blocks.
- **Bad-debt waterfall:** step 1 is `InsuranceFund.BadDebtCovered` (IF pays what it can); steps 2 and 3 come from `BadDebtSocialized` (`CoveredByFees` = requested − covered − uncovered, then `Uncovered`), emitted only when the IF fell short. The liquidation penalty's IF share (`toInsurance / 1e12`, rounded down) reaches the fund by plain transfer and is recorded as `PenaltyIn`. Swaps have no `BadDebtSocialized`: only their IF part and penalties are evented.
- **ProtocolDaily:** each change to `ProtocolStats` also lands in the event's UTC day (flows = the day's change of the counters, closes = values after the day's last change). `activeExternalUsers` counts a non-operator account once per day.
- **Funding conservation (property, recorded perp stack):** Σ over accounts of (`fundingPaid` + q·(F − lastCumFunding)) = 0 within one wei per settlement.
- **Perpl:** APR = `ratePct100k`·1e13·31,536,000 / interval (2,580 s), checked against Perpl's API on 28 + 35 funding events. Positions replay to the exchange's `getPosition` exactly (lots, side, collateral, entry). CrossVenueFunding is written by whichever venue updates first in an hour and carries the other venue's latest value.

## Queries behind each screen (exact text, from `app/src/data/indexer/*`)
Every K2 query filters on `chainId` (the indexer also holds Perpl's mainnet rows).

| Screen | Reader → query |
|---|---|
| Trade: funding tooltip / ticker / Rates KPIs (realized 1 h · 8 h · 24 h · 7 d) | `funding.ts` → `FUNDING_WINDOW_QUERY` (merged over the contract values by `useMarket`) |
| Trade: price chart | `candles.ts` → `candlesQuery("Candle1m" \| "Candle1h")`; mark / index source: `prices.ts` → `MARK_QUERY`, `INDEX_QUERY` |
| Trade / Positions: history tabs | `account.ts` → `ACCOUNT_HISTORY_QUERY`; Funding tab → `funding.ts` → `FUNDING_PAYMENTS_QUERY` |
| Positions: all-time row | `portfolio.ts` → `PORTFOLIO_QUERY` |
| Earn: share-price chart, deposits / users / APY | `vault.ts` → `VAULT_HISTORY_QUERY` |
| Rates: Meridian vs Perpl funding | `funding.ts` → `CROSS_VENUE_QUERY`; Perpl detail → `perpl.ts` → `perplQuery(monPerpId)` |
| Rates: liquidation distance, insurance fund | `risk.ts` → `RISK_QUERY` |
| Stats | `stats.ts` → `STATS_QUERY` |
| K6 metrics / K5 waterfall (data layer) | `protocol.ts` → `PROTOCOL_DAILY_QUERY`, `INSURANCE_QUERY` |

### `STATS_QUERY` (data/indexer/stats.ts)
```graphql
query MeridianStats {
  ProtocolStats(where: { id: { _eq: "protocol" } }) {
    externalUsers users perpVolumeQuoteWad perpVolumeMmQuoteWad swapVolumeWad feesWad tvlToken trades liquidations updatedBlock
  }
  Market(where: { testMarket: { _eq: false } }) {
    id symbol lastFundingBlock realizedApr1hWad realizedApr8hWad realizedApr24hWad
  }
}
```

### `RISK_QUERY` (data/indexer/risk.ts)
```graphql
query MeridianRisk($market: String!) {
  AccountMarket(where: { market_id: { _ilike: $market }, size: { _neq: "0" } }, limit: 1000) { size entryPrice collateralWad }
  InsuranceFund { fundedToken coveredToken }
}
```

### `INDEX_QUERY` (data/indexer/prices.ts)
```graphql
query MeridianIndex($oracle: String!, $limit: Int!) {
  OraclePrice(where: { oracle: { _ilike: $oracle } }, order_by: { block: desc }, limit: $limit) { priceWad publishTime }
}
```

### `MARK_QUERY` (data/indexer/prices.ts)
```graphql
query MeridianMark($market: String!, $limit: Int!) {
  FundingTick(where: { market_id: { _ilike: $market } }, order_by: { block: desc }, limit: $limit) { mark timestamp }
}
```

### `ACCOUNT_HISTORY_QUERY` (data/indexer/account.ts)
```graphql
query MeridianAccountHistory($a: String!, $limit: Int!) {
  Trade(where: { kind: { _eq: "Perp" }, _or: [{ maker: { _ilike: $a } }, { taker: { _ilike: $a } }] }, order_by: { block: desc }, limit: $limit) {
    id maker taker takerIsBid priceWad sizeWad notionalWad block timestamp txHash
  }
  Order(where: { kind: { _eq: "Perp" }, maker: { _ilike: $a } }, order_by: { updatedBlock: desc }, limit: $limit) {
    id orderId isBid tick lots filledLots remainingLots flags status placedBlock updatedBlock
  }
  Liquidation(where: { kind: { _eq: "Perp" }, account: { _ilike: $a } }, order_by: { block: desc }, limit: $limit) {
    id sizeTransferred markPriceWad penalty badDebt block timestamp txHash
  }
}
```

### `FUNDING_WINDOW_QUERY` (data/indexer/funding.ts)
```graphql
query MeridianFundingWindow($chainId: Int!, $market: String!) {
  FundingWindow(where: { chainId: { _eq: $chainId }, market: { _ilike: $market } }, limit: 1) {
    block apr1hWad apr8hWad apr24hWad apr7dWad rateAprWad
  }
}
```

### `CROSS_VENUE_QUERY` (data/indexer/funding.ts)
```graphql
query MeridianCrossVenue($chainId: Int!, $limit: Int!) {
  CrossVenueFunding(where: { chainId: { _eq: $chainId } }, order_by: { hour: desc }, limit: $limit) {
    hour meridianAprWad perplAprWad spreadAprWad
  }
}
```

### `FUNDING_PAYMENTS_QUERY` (data/indexer/funding.ts)
```graphql
query MeridianFundingPayments($chainId: Int!, $a: String!, $limit: Int!) {
  FundingPayment(where: { chainId: { _eq: $chainId }, account: { _ilike: $a } }, order_by: { block: desc }, limit: $limit) {
    block timestamp payment txHash
  }
}
```

### `PROTOCOL_DAILY_QUERY` (data/indexer/protocol.ts)
```graphql
query MeridianProtocolDaily($chainId: Int!, $limit: Int!) {
  ProtocolDaily(where: { chainId: { _eq: $chainId } }, order_by: { day: desc }, limit: $limit) {
    day perpVolumeQuoteWad perpVolumeMmQuoteWad swapVolumeWad feesWad trades liquidations newExternalUsers activeExternalUsers
    tvlTokenClose vaultNavTokenClose perpOpenInterestLongWadClose perpOpenInterestShortWadClose swapOpenInterestWadClose
  }
}
```

### `INSURANCE_QUERY` (data/indexer/protocol.ts)
```graphql
query MeridianInsuranceFlows($chainId: Int!, $limit: Int!) {
  InsuranceFundEvent(where: { chainId: { _eq: $chainId } }, order_by: [{ block: desc }, { id: desc }], limit: $limit) {
    id flow direction kind market account amountWad requestedWad balanceAfterToken block timestamp txHash
  }
}
```

### `VAULT_HISTORY_QUERY` (data/indexer/vault.ts)
```graphql
query MeridianVaultHistory($chainId: Int!, $vault: String!, $limit: Int!) {
  Vault(where: { chainId: { _eq: $chainId }, id: { _ilike: $vault } }, limit: 1) {
    id depositedToken withdrawnToken userCount apy24hWad apy7dWad pendingRedeemShares claimableToken
  }
  VaultSnapshot(where: { chainId: { _eq: $chainId }, vault_id: { _ilike: $vault } }, order_by: { block: desc }, limit: $limit) {
    id navToken totalShares sharePriceWad fundingAccruedWad block timestamp
  }
}
```

### `PORTFOLIO_QUERY` (data/indexer/portfolio.ts)
```graphql
query MeridianPortfolio($chainId: Int!, $a: String!) {
  AccountMarket(where: { chainId: { _eq: $chainId }, account_id: { _ilike: $a } }) {
    market_id fundingPaid realizedPnl feesPaid liquidationCount depositedToken withdrawnToken lastTradeBlock
  }
  VaultRedeemRequest(where: { chainId: { _eq: $chainId }, owner: { _ilike: $a } }, order_by: { requestId: desc }, limit: 50) {
    requestId shares status assets unwindCost requestedAt fulfilledAt claimedAt cancelledAt txHash
  }
}
```

### `candlesQuery(table)` (data/indexer/candles.ts) and `perplQuery(monPerpId)` (data/indexer/perpl.ts)
Built per table / per chain's MON id (from `deployments/perpl.json`); see those files for the exact text.

## Example queries (hand-written)
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
  Vault(where: { chainId: { _eq: $chainId } }) { id navToken sharePriceWad hedged apy24hWad apy7dWad lastRebalanceReason pendingRedeemShares claimableToken }
  VaultRedeemRequest(where: { chainId: { _eq: $chainId }, owner: { _eq: $me }, status: { _in: [Pending, Claimable] } }, order_by: { requestId: desc }) { requestId shares status assets unwindCost requestedAt receiver }
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
| MeridianVault (`IMeridianVault` + ERC-4626) | Deposit, Withdraw, Transfer, Rebalanced, HedgeExited, HedgeEntered, NavSnapshot, VaultParamsUpdated, KeeperUpdated, RedeemRequested, RedeemCancelled, RedeemFulfilled, RedeemClaimed, EmergencyUnwind (CR-014; `Approval` intentionally skipped) | `src/handlers/vault.ts` |
| KuruHedger | SpotBought, SpotSold | `src/handlers/vault.ts` |
| OracleAdapter | PriceUpdated, DeviationGuardTripped, OracleParamsUpdated | `src/handlers/periphery.ts` |
| InsuranceFund | Funded, BadDebtCovered, MarketAuthorized | `src/handlers/periphery.ts` |
| MarketFactory | MarketRegistered (also registers the new OB/CH/oracle), MarketStatusChanged | `src/handlers/periphery.ts` |
| MeridianKeeperReceiver | ReportExecuted, ForwarderUpdated | `src/handlers/periphery.ts` |

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
