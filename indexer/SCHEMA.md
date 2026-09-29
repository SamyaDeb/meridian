# Pulse indexer: GraphQL schema for the app (WS-06 → WS-07)

Source of truth: [`schema.graphql`](schema.graphql). This page is the contract for WS-07. Changes are announced in the WS-06 PR description.
Engine: Envio HyperIndex 3.12.1 (Hasura GraphQL). Networks: 31337 (local anvil via `DeployLocal`, RPC), 10143 and 143 (HyperSync, no RPC mode).

| Network | Config | Public GraphQL URL |
|---|---|---|
| 31337 local | `config.yaml` | `http://localhost:8080/v1/graphql` (`pnpm dev`) |
| 10143 testnet | `config.testnet.yaml` (`pnpm gen-config 10143` once `deployments/10143.json` exists) | > VERIFY: hosted URL after the CP2 deploy |
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
| `Market` | ClearingHouse address | `symbol`, `lastRate`, `lastRateAprWad`, `lastCumFunding` (F), `lastCumIndexTime` (G), `lastMarkPrice`, `lastIndexPrice`, `realizedApr1hWad / 8hWad / 24hWad`, `lastTradePrice`, `volumeQuoteWad`, `openInterestLongWad / ShortWad`, `feesWad`, `paused`, `blockTimeMs` | Trade header, Stats |
| `FundingTick` | `<market>-<block>` | `block`, `timestamp`, `rate`, `rateAprWad`, `premium`, `emaPremium`, `cumFunding`, **`cumIndexTime`**, `index`, `mark` | per-block funding chart |
| `FundingCheckpoint` | `<market>-<block/200>` | `slot`, `blockNumber`, `cumFunding`, `cumIndexTime`, `realizedApr1h/8h/24hWad` | oracle APR history (~60 s) |
| `Order` | `<book>-<orderId>` | `kind` (Perp/Swap), `market`, `maker`, `isBid`, `tick`, `lots`, `remainingLots`, `filledLots`, `status` (Open/PartiallyFilled/Filled/Cancelled/Evicted) | open orders |
| `Trade` | `<block>-<logIndex>` | `kind`, `market` (perp) / `swapMarket`, `maker`, `taker`, `takerIsBid`, `priceWad`, `sizeWad`, `notionalWad`, `aprWad` (swap), `timestamp`, `txHash` | trade tape |
| `Candle1m`, `Candle1h` | `<market>-<bucketStart>` | `open/high/low/close` (WAD), `volumeBaseWad`, `volumeQuoteWad`, `trades` | price chart (perp only) |
| `Account` | address | `firstSeenBlock`, `tradeCount`, `volumeQuoteWad` | — |
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
| `ProtocolStats` | `"protocol"` | `users`, `perpVolumeQuoteWad`, `swapVolumeWad`, `feesWad`, `tvlToken`, `trades`, `liquidations`, `fundingTicks` | Stats |
| `KeeperReport` | `<block>-<logIndex>` | CRE `action`, `success`, `workflowId` | ops |
| `AdminEvent` | `<block>-<logIndex>` | `name`, `data` (JSON, bigints as strings) | ops |

## Derived values (bigint, unit-tested in `test/math.test.ts`)
- **Realized funding APR (oracle), MATH_SPEC §1.8.** `avgRate = (F₂ − F₁)·1e18 / (G₂ − G₁)`, `aprWad = avgRate · 31,536,000`, display `aprWad / 1e18`. (F₂, G₂) comes from the latest `FundingUpdated`. (F₁, G₁) is the `FundingCheckpoint` at or before `block − window`, with `window = seconds·1000/blockTimeMs` (1 h = 12,000 blocks at 300 ms). This is the same semantics and operation order as `averageFundingApr(blocksAgo)`. It is `null` until the window has history.
- **Rate APR:** `rateAprWad = rate · 31,536,000`.
- **Vault APY:** simple annualized share-price change vs the hourly price 24 h / 7 d back: `(sp₁ − sp₀)·1e18·YEAR / (sp₀·Δt)`. `null` means not enough history, so the app shows "Waiting for funding…" (never a fake APY).
- **Swaps:** `aprWad = priceWad − 1e18`. `K += Δq·A/1e18`. `avgFixedAprWad = K·1e18/q`. **`lockedSpread = (q == 0 && K != 0)`**: show "locked +x AUSD until maturity", not zero.
- **Perp mirror:** `openNotional` follows MATH_SPEC §3.1 (released rounds toward +∞). `entryPrice = |ON|·1e18/|q|`.
- **TVL** (`tvlToken`) = net AUSD deposited into the perp ClearingHouse + swap market + the vault's last NAV (event-derived).

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
  ProtocolStats(where: { chainId: { _eq: $chainId } }) { users perpVolumeQuoteWad swapVolumeWad feesWad tvlToken trades liquidations fundingTicks }
}
```
> VERIFY: the exact Hasura root-field names (`Market` vs `Market_by_pk`, `chainId` column) against the local `pnpm dev` console before WS-07 wires them (CP1, Day 5).

## Event coverage checklist (acceptance: every interface event is handled)
Enforced by `test/config.test.ts`, which diffs `abis/*.json` and `contracts/src/interfaces/*.sol` against the config, and every configured event against a handler.

| Contract (config name) | Events | Handler |
|---|---|---|
| ClearingHouse (`IClearingHouse` + `IFundingRateOracle`) | Deposited, Withdrawn, FundingUpdated, FundingSettled, PositionChanged, Liquidated, BadDebtSocialized, OrderMarginChanged, FeesCollected, RiskParamsUpdated, FundingParamsUpdated, PausedSet, FundingCheckpoint | `src/handlers/clearingHouse.ts` |
| OrderBook, SwapOrderBook (`IOrderBook`) | OrderPlaced, OrderCancelled, OrderEvicted, Trade | `src/handlers/orderBook.ts` |
| FundingSwapMarket | Deposited, Withdrawn, SwapPositionChanged, SwapAccrualSettled, SwapLiquidated, MaturitySettled, SwapParamsUpdated | `src/handlers/fundingSwap.ts` |
| PulseVault (`IPulseVault` + ERC-4626) | Deposit, Withdraw, Transfer, Rebalanced, HedgeExited, HedgeEntered, NavSnapshot, VaultParamsUpdated, KeeperUpdated (`Approval` intentionally skipped) | `src/handlers/vault.ts` |
| KuruHedger | SpotBought, SpotSold | `src/handlers/vault.ts` |
| OracleAdapter | PriceUpdated, DeviationGuardTripped, OracleParamsUpdated | `src/handlers/periphery.ts` |
| InsuranceFund | Funded, BadDebtCovered, MarketAuthorized | `src/handlers/periphery.ts` |
| MarketFactory | MarketRegistered (also registers the new OB/CH/oracle), MarketStatusChanged | `src/handlers/periphery.ts` |
| PulseKeeperReceiver | ReportExecuted, ForwarderUpdated | `src/handlers/periphery.ts` |

Not indexed yet: Kuru OrderBook trade events (WS-06 "Consumes"; > VERIFY ABI at docs.kuru.io/contracts/Integration).

## Known approximations (tell WS-07)
- `AccountMarket.collateralWad` doesn't credit a liquidator's `keeperReward`: whether it's paid into CH collateral or as tokens isn't specified (> VERIFY with WS-02).
- `SwapStats.markAprWad` is the last traded APR. The contract's `markApr` is a median with book mid and realized 8 h (MATH_SPEC §6.3), so read `markApr()` for margin-grade values.
- The local mock deployment (31337) has no MarketFactory / FundingSwapMarket / SwapOrderBook / KeeperReceiver yet. Those contracts get indexed once they're in `deployments/<chainId>.json`: rerun `pnpm gen-config <chainId>`.

## Commands
```bash
pnpm install                  # repo root (pnpm workspace)
cd indexer
pnpm gen-config 31337             # regenerate config.yaml + src/deployments.gen.ts from deployments/
pnpm test                     # codegen + vitest (handlers via simulate, math, config)
pnpm dev                      # local indexer against anvil (needs Docker for Postgres/Hasura)
```
