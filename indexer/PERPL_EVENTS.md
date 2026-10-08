# Perpl events: what the deployed exchange really emits (K2.0)

Perpl is another perp DEX on Monad. We index its exchange next to Meridian so the app can compare the two venues from one GraphQL endpoint (`CrossVenueFunding`, Perpl positions and liquidations).

**Rule:** an event is indexed only if it was seen **and** decoded on the deployed contract with the vendored ABI's exact signature. Recordings: HyperSync logs of the exchange proxy, decoded with viem against `abis/PerplExchange.json` (`scripts/record-perpl.mjs`, `scripts/check-perpl-funding.mjs`, `scripts/verify-perpl-positions.mjs`). Fixtures: `test/fixtures/perpl-{10143,143}/`.

| | Monad testnet (10143) | Monad mainnet (143) |
|---|---|---|
| Exchange (ERC-1967 proxy; indexed with the Exchange ABI) | `0x1964c32f0be608e7d29302aff5e61268e72080cc` | `0x34b6552d57a35a1d042ccae1951bd1c370112a6f` |
| Source | `GET https://testnet.perpl.xyz/api/v1/pub/context` (7 Oct 2026) | `GET https://app.perpl.xyz/api/v1/pub/context` (7 Oct 2026) |
| MON market | perp **64** (`symbol "MON"`), price_decimals 5, size_decimals 0 | perp **10** (`symbol ""`, `name "MON"`), price_decimals 6, size_decimals 0 |
| Funding interval | 2,580 s / 8,571 blocks | 2,580 s / 8,571 blocks |
| Collateral | AUSD, 6 dp | AUSD, 6 dp |
| `contract_version` | 1.7.5 | 1.7.5 |

Addresses and market metadata live in `deployments/perpl.json` (seeded by `scripts/seed-perpl.mjs`, rendered to `src/perpl.gen.ts` by `gen-config`). Handlers never hard-code or fetch them.

## Event inventory

**Unfiltered slice, testnet** (blocks 68,733,382 → 68,752,725, 407,989 logs): 34 event types decoded, **0 unknown topic0**. About 21 logs per block, mostly order-book traffic (`OrderRequestV2` 181,019, `OrderChanged` 134,646, `OrderBatchCompleted` 15,089, `OrderPlaced` 13,302, `RecycleFeeToAccount` 13,287, `OrderCancelled` 11,555). So the indexer filters on the events below; it never takes everything.

**Filtered, the whole Meridian window on testnet** (68,740,325 → 68,985,325, 245,000 blocks, 214,858 logs) and **250,000 mainnet blocks** (111,091,048 → 111,341,048, 280,518 logs):

| Event | 10143 | 143 | Indexed | Fields used → unit conversion |
|---|---:|---:|---|---|
| `FundingEventCompleted` | 420 | 464 | ✅ | `actualRatePct100k` → `aprWad = rate·1e13·YEAR/interval_sec`; `fundingPricePNS` → WAD (`·10^(18−pd)`); `fundingPaymentPNS`, `fundingSumPNS` raw; `fundingEventBlock` = the block the rate applies from |
| `MarkUpdated` | 108,571 | 131,546 | ✅ | `pricePNS` → WAD |
| `PositionOpenedV2` | 272 | 23,885 | ✅ | `positionType` (0 Long / 1 Short), `lotLNS` → size WAD (`·10^(18−sd)`), `pricePNS` = entry, `depositCNS` → WAD (`·1e12`), fees |
| `PositionIncreasedV2` | 52,488 | 45,127 | ✅ | `endLotLNS`, `endDepositCNS`, `pricePNS` = **the position's entry after the increase** (the exchange's own average, not the fill price) |
| `PositionDecreased` | 52,718 | 49,666 | ✅ | `endLotLNS`, `endDepositCNS`, `deltaPnlCNS`, `fundingCNS` |
| `PositionClosed` | 226 | 23,897 | ✅ | `deltaPnlCNS`, `fundingCNS` |
| `PositionInverted` | 15 | 5,781 | ✅ | `positionType` = **the new side**, `startLotLNS` = old side's lots, `endLotLNS` = new side's lots, `pricePNS` = new entry |
| `PositionLiquidated` | 10 | 42 | ✅ | `posAccountId`, `positionType`, `markPricePNS`, `liqPricePNS`, `liqLotLNS`, `posLotLNS` (remaining), `posDepositCNS`, pnl, funding |
| `IncreasePositionCollateral` | 47 (BTC, position recording) | 10 (MON, position recording) | ✅ | `positionDepositCNS` (margin added; lots unchanged) |
| `CollateralDeposit` / `CollateralWithdrawal` | 68 / 18 | 61 / 43 | ✅ | `amountCNS`, `balanceCNS` (account level) |
| `AccountCreated` | 52 | 6 | ✅ | `account` (address) ↔ `id` |
| `TakerOrderFilled(V2)`, `MakerOrderFilled(V2)` | seen | not checked | ❌ | not needed for funding / positions; the taker event carries no perpId or accountId. No `PerplTrade` entity (volume: ~60k maker fills per testnet window) |
| `PositionOpened`, `PositionIncreased` (v1) | 0 | 0 | ❌ | superseded by V2 on 1.7.5 |
| `PositionDeleveraged(V2)` | 0 | 0 | ❌ | never appeared |
| `InsurancePaymentForSettlement` | 0 | 0 | ❌ | never appeared |
| `PositionCollateralDecreased` | 0 | 0 | ❌ | never appeared (it would also move the entry price; add it the day it shows up) |
| `AccountLiquidationCredit`, `PositionLiquidationCredit`, `BuyToLiquidateSettled`, `FundingSumScalingExpUpdated` | 0 | 0 | ❌ | never appeared |

`scripts/record-perpl.mjs` prints this table's counts again for any window (`summary.json`).

## Units: verified, not assumed

1. **Funding rate.** The onchain field is `actualRatePct100k`: a fraction of notional **per funding interval, ×1e5**. Joined on `fundingEventBlock = feb` with Perpl's REST series (`/v1/market-data/:id/funding/:from-:to`, whose `rate` is micros per interval, docs/MFI.md §2):
   - testnet MON (64): **28/28** events have `rate_micros = actualRatePct100k · 10`, and `ppl = fundingPaymentPNS` and `sum = fundingSumPNS` exactly;
   - mainnet MON (10): **35/35**, same three identities.
   So `APR = actualRatePct100k · 1e13 · 31,536,000 / 2,580` (WAD). Example: −4 per 100k per interval ≈ −48.9 % APR. Rounding is neutral (truncate toward zero) because this is a reference value, never a payment. Evidence: `test/fixtures/perpl-{10143,143}/funding-check-*.json`.
2. **Prices / sizes / collateral.** `*PNS = int · 10^-price_decimals`, `*LNS = int · 10^-size_decimals`, `*CNS` = AUSD 6 dp. Decimals come from the seeded context snapshot. A perp missing from the snapshot (testnet emits funding for perps 304 and others that the context doesn't list) keeps raw values with `*Wad = null`.
3. **Position semantics**, from `scripts/verify-perpl-positions.mjs` over every position event of each window, with the result compared to the exchange's own `getPosition(perpId, accountId)` at the last block:

| Market | Window | Position events | Accounts | Lots breaks | Deposit breaks | Inversions | Accounts vs `getPosition` | Mismatches |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| testnet MON (64) | 68,746,869 → 68,994,866 | 12,525 | 8 | 0 | 0 | 5 | 4 | 0 |
| testnet BTC (16) | 68,747,764 → 68,995,754 | 11,752 | 85 | 0 | 0 | 9 | 13 (incl. 9 liquidations) | 0 |
| mainnet MON (10) | 111,202,564 → 111,352,347 | 7,381 | 50 | 0 | 0 | 91 | 11 | 0 |

"Breaks" means an event's `startLotLNS` / `startDepositCNS` differed from the previous event's end value. Zero breaks means no other event moves lots or position collateral, as long as `IncreasePositionCollateral` is indexed (it explained the only deposit gaps). The comparison covers lots, side, position collateral and entry price, all exact. `test/replay-perpl.test.ts` replays the same fixtures through the real handlers and asserts the same equalities.

`positionType` 0 = Long. Check: a type-0 position is liquidated when the mark (838,918) is below its liquidation price (839,779).

## Known limits
- **Addresses.** Positions are keyed by Perpl `accountId`. Only accounts created inside the indexed window have an address (`AccountCreated`). Older ones resolve with the exchange's `getAccountByAddr(address)` view (K5 can call it client-side).
- **Open interest.** `PerplMarket.openInterest*` sums the positions the indexer has seen. A position opened before the start block counts from its first event in the window; on a busy market the MM accounts trade within minutes, so it converges fast. For an exact figure read `getPerpetualInfo(perpId).{long,short}OpenInterestLNS` (at the recording blocks: testnet MON 2,841,581 lots per side, mainnet MON 3,172,883).
- **Entry price** is unknown (`entryPriceExact = false`, entry 0) only for a position opened before the window and only decreased since; the next increase or inversion carries it.
