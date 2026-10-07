# MFI: Meridian Funding Index (design note, v0)

Owner: lane D (WS-09). Status: design for the offchain v0 (`mfi/` service). A second engineer should be able to build the service from this note alone; the numbers in §8 are checked by `node docs/mfi/worked-examples.mjs`.

## 1. Definition

The **Meridian Funding Index (MFI)** is one annualized funding rate for MON perpetuals on Monad. It is the open-interest-weighted mean of the funding rate on each live venue:

```
MFI = Σ_v (OI_v · APR_v) / Σ_v OI_v          v ∈ live venues ⊆ {meridian, perpl}
```

- `APR_v`: the venue's funding rate as an annualized WAD rate (0.1e18 = 10% APR). Sign: **positive ⇒ longs pay shorts**.
- `OI_v`: one-sided open interest notional in AUSD, WAD.
- Unit of the index: annualized WAD (`int256` semantics, served as a decimal string).
- v0 venues: Meridian MON-PERP (our ClearingHouse) and Perpl's MON market (> VERIFY: Perpl lists a MON perp; resolve the market by symbol from `GET /v1/pub/context`, never by a hard-coded id).

## 2. Sources

| Venue | Rate | OI and mark | Source |
|---|---|---|---|
| Meridian | `IFundingRateOracle.averageFundingApr(W_blocks)` on the ClearingHouse (ΔF/ΔG × 365 d, MATH_SPEC §1.8) | `IClearingHouse.openInterest()` → `longOI` (base WAD, per side) × `IClearingHouse.markPrice()` (WAD) via viem `readContract`, or the indexer | `deployments/<chainId>.json` (10143 now, 143 after launch) |
| Perpl | newest `FundingEvent.rate` from `GET /v1/market-data/:market_id/funding/:from-:to` | `MarketState.oi`, `MarketState.mrk` from `GET /v1/market-data/:market_id/ticker` | Perpl API docs, `github.com/PerplFoundation/api-docs` @ `25ab6e2` (2026-09-25): `README.md`, `rest-endpoints.md`, `types.md` |

Perpl facts used here, from those docs:
- REST base URL: mainnet `https://app.perpl.xyz/api`, testnet `https://testnet.perpl.xyz/api` (README "Configuration"). Market-data endpoints need no auth.
- `Market.funding_interval_sec` and `Market.funding_interval_blocks` are published per market in `/v1/pub/context`. **The interval is read at runtime, never hard-coded.** Third-party sources say 1 h (orbitperpscreener); our ARCHITECTURE R27 says 8,571 blocks ≈ 43 min; the context endpoint is authoritative.
- `FundingEvent { at: {b, t(ms)}, feb, rate: Micros (10^-6), idx, ppl, sum, div }`; `at` is when the rate **applies**; the newest event can sit up to ~1 min ahead of the head with an estimated `at.t`, republished with the same `feb` once final.
- `MarketState { at, orl, mrk, lst, mid, bid, ask, prv, dv, dva, oi, tvl }`; prices/sizes are scaled integers (`price_decimals`, `size_decimals` from the market config).
- Ticker returns `503` while state is not available yet; REST limits are unpublished: treat `429` as the signal and back off exponentially.

**Resolved from real recordings (5 Oct 2026, `mfi/fixtures/recorded/{testnet,mainnet}/`, replay test `mfi/test/recorded.test.ts`):**
- (a) ✅ `FundingEvent.rate` is micros (10⁻⁶) of notional **per funding interval**: on all 66 recorded events (33 testnet, 33 mainnet) `ppl = trunc(rate · idx / 10^(6 − funding_sum_scaling_exp))` and the cumulative `sum` moves by exactly `ppl`. `units.ts` already assumed this; no change. Recorded rates stay within ±40 micros per interval (≈ ±48.9% APR at 2580 s).
- (b) ⚠ Consistent with "positive ⇒ longs pay": on mainnet the mark (32316) was below the oracle (32405) while recent rates were ≤ 0. One snapshot, so supportive, not proof. > VERIFY against Perpl's docs or a recorded long/short settlement.
- (c) > VERIFY (unresolved): the API gives one `oi` number (testnet 2,838,157 MON, mainnet 3,120,588 MON at size_decimals 0); the recording can't tell one-sided from long + short. The weighting still assumes one-sided (§4).
- (d) ✅ Testnet: market **64**, `symbol "MON"`, price_decimals 5, size_decimals 0. **Mainnet: market 10, `symbol ""` (empty) and `name "MON"`**, price_decimals 6, size_decimals 0 (BTC is listed the same way). Lookup by symbol alone fails on mainnet, so `matchMarket` falls back to `name` for markets with an empty symbol (`mfi/src/perpl/client.ts`, tested). Funding interval **2580 s (8,571 blocks, ≈ 43 min)** on both networks: ARCHITECTURE R27 is right, the 1 h third-party figure is not.

## 3. Normalization to one unit (annualized WAD)

`YEAR = 31_536_000 s` (365 d, `SECONDS_PER_YEAR` in MeridianConstants).

### 3.1 Meridian (per block → APR)
Meridian accrues every block; the oracle already returns `averageFundingApr(blocksAgo) = ΔF/ΔG · YEAR` (WAD). The MFI uses the window **W = 1 h = 12,000 blocks** (`blockTimeMs = 300`, MATH_SPEC §1.1), so both venues are measured over the same horizon as Perpl's interval. If the ring buffer is younger than W (`ObservationTooOld`), use the oldest available checkpoint and report the actual window in `windowBlocks`.

```
APR_meridian = averageFundingApr(12_000)          // MATH_SPEC §1.8, rounds as the contract does
```

### 3.2 Perpl (per interval → APR)
```
APR_perpl = rate_micros · 1e12 · YEAR / funding_interval_sec      // rounds neutral (toward zero)
```
`1e12` takes micros (1e-6) to WAD (1e-18). One multiplication chain, one division, in bigint.

### 3.3 OI notional (weights)
```
OI_meridian = longOI · markPrice / 1e18                                            // floor
OI_perpl    = oi · 10^(18 − size_decimals) · mrk · 10^(18 − price_decimals) / 1e18   // floor
```
(requires `size_decimals, price_decimals ≤ 18`; reject the market otherwise.)

## 4. Weights and rounding

### 4.1 Weight input: 1 h minimum OI
To make the weight expensive to push around (§6), the weight of a venue is the **minimum** of its sampled `OI_v` over the last hour (samples every 60 s, ≤ 60 samples, bounded). During warm-up (< 1 h of samples) use the samples available and set `warmup: true`.

### 4.2 Index
```
if live = ∅:            MFI = null, stale = true
elif Σ OI_v = 0:        MFI = Σ APR_v / |live|            weighting = "equal"
else:                   MFI = Σ (OI_v · APR_v) / Σ OI_v   weighting = "oi"
weightBps_v = OI_v · 10_000 / Σ OI_v                       // floor; display only (may sum to 9,999)
```

### 4.3 Overflow
`OI_v` ≤ ~1e33 (1e15 AUSD), `|APR_v|` ≤ ~1e20 (100× APR): products stay < 2^255. JS `bigint` has no overflow; the onchain publisher (roadmap) uses `fullMulDiv`.

### 4.4 Rounding direction
The MFI is a reference rate, not a payment: no user is credited or debited from it, so every division **rounds neutral = truncates toward zero** (bigint `/`), which makes a negative and a positive rate of equal size round symmetrically. Weights floor. Tests assert the direction (T6). If MFI is later used to settle (roadmap), the settling contract chooses its own direction per CONTRIBUTING.md §2.

## 5. Staleness and outages

| Condition | Rule (defaults, configurable) | Effect |
|---|---|---|
| Meridian RPC/indexer unreachable, or `latestObservation().blockNumber` behind the RPC head by > 200 blocks (~60 s) | venue `stale` | excluded |
| Meridian oracle reverts `OracleStale` (market paused by stale index) | venue `stale` (reason `oracle-stale`) | excluded |
| Perpl request fails after retries (timeout 5 s, 3 attempts, backoff 250 ms × 2^n + jitter; `429`/`503`/5xx retried, other 4xx not) | venue `unavailable` | excluded |
| Perpl newest funding event `at.t` older than `funding_interval_sec + 120 s` | venue `stale` | excluded |
| Perpl ticker `at.t` older than 120 s | weight input stale | excluded |
| Perpl payload fails schema validation | venue `invalid` | excluded, logged with the raw body hash |

- The index is **never silently wrong**: every response carries `venues[]` with `included`, `status` and `reason`, and the top-level `venuesIncluded` list. Meridian-only output is a valid MFI with `venuesIncluded: ["meridian"]`.
- `stale: true` at the top level when no venue is included, or the newest included input is older than 120 s. A stale response keeps the last good value in `index` with `stale: true` and `updatedAt` of that value.
- The service never extrapolates a missing venue and never reuses a venue's old value after its stale threshold.

## 6. Manipulation resistance

1. **Meridian rate:** ΔF/ΔG over 1 h; F moves only at the δ-capped, clamped per-block rate (MATH_SPEC §1.2, §1.8). Moving the 1 h average by x APR points needs a sustained premium for the hour at real cost.
2. **Perpl rate:** set by Perpl once per interval; we read the settled event (same `feb` deduplicated, estimated `at.t` ignored for staleness until final).
3. **Weights:** 1 h minimum OI (§4.1). Inflating a venue's weight means holding extra OI (margined, funding-paying) for a full hour; a spike moves nothing. Self-trades raise OI only while both legs stay open.
4. **No single read:** each cycle reads both venues independently; a venue failing validation is excluded, not zeroed.
5. **Limits (stated honestly):** v0 trusts Perpl's API (not its contracts) and our own RPC. A compromised API can move the Perpl component; the per-venue breakdown makes that visible. The onchain publisher (roadmap) would read Perpl's contracts directly.

## 7. Public JSON (read-only API, `mfi/`)

All amounts are **decimal strings** of integers (WAD or token units), never floats. `aprWad` "105439534777780673" = 10.5439…% APR.

### `GET /v1/mfi` (current)
```json
{
  "version": "mfi-v0",
  "chainId": 10143,
  "index": { "aprWad": "105439534777780673", "weighting": "oi" },
  "stale": false,
  "warmup": false,
  "updatedBlock": "41234567",
  "updatedAt": 1791234567000,
  "venuesIncluded": ["meridian", "perpl"],
  "venues": [
    { "id": "meridian", "included": true, "status": "ok", "aprWad": "109499999992992000", "oiNotionalWad": "93173850000000000000000",
      "weightBps": 729, "windowBlocks": 12000, "asOfBlock": "41234567", "asOfMs": 1791234567000 },
    { "id": "perpl", "included": true, "status": "ok", "aprWad": "105120000000000000", "oiNotionalWad": "1184000000000000000000000",
      "weightBps": 9270, "marketId": 0, "fundingIntervalSec": 3600, "rateMicros": 12, "fundingEventBlock": 0, "asOfMs": 1791234560000 }
  ]
}
```
(`marketId`, `fundingEventBlock` above are placeholders; the example numbers are §8 A, synthetic.)
- `updatedBlock`: Meridian chain block of the cycle (the RPC head when Meridian is down). `status` ∈ `ok | stale | unavailable | invalid | oracle-stale`; `reason` (string) present when not `ok`. `index` is `null` only when no venue was ever included.

### `GET /v1/mfi/history?from=<ms>&to=<ms>&limit=<n≤1000>`
```json
{ "version": "mfi-v0", "points": [ { "updatedBlock": "41234567", "updatedAt": 1791234567000, "aprWad": "105439534777780673",
  "meridianAprWad": "109499999992992000", "perplAprWad": "105120000000000000", "venuesIncluded": ["meridian","perpl"], "stale": false } ] }
```
One point per cycle (60 s), oldest first; `perplAprWad: null` when Perpl wasn't included. Bounded by `limit` (default 500).

### `GET /healthz`
`{ "ok": true, "lastCycleMs": …, "venues": { "meridian": "ok", "perpl": "unavailable" } }`

CORS: `GET` only, any origin. No auth, no writes.

## 8. Worked examples (synthetic inputs, verified by `node docs/mfi/worked-examples.mjs`)

**A. Both venues live.** Meridian rate 3,472,222,222 /s WAD (the 10.95% interest floor) ⇒ `APR_m = 3_472_222_222 × 31_536_000 = 109_499_999_992_992_000` (10.950000%). Perpl `rate = 12` micros per 3,600 s ⇒ `APR_p = 12 × 1e12 × 31_536_000 / 3_600 = 105_120_000_000_000_000` (10.512000%). OI: Meridian 3,150,000 MON × 0.029579 = 93,173.85 AUSD (`93_173_850e18`); Perpl `oi = 4_000_000_000` (size_decimals 2 ⇒ 40,000,000 MON) × `mrk = 296_000` (price_decimals 7 ⇒ 0.0296) = 1,184,000 AUSD. Weights 729 / 9,270 bps. **MFI = 105_439_534_777_780_673 (10.543953%)**.

**B. Perpl unavailable.** Same Meridian inputs ⇒ **MFI = APR_m = 109_499_999_992_992_000**, `venuesIncluded: ["meridian"]`, Perpl `status: "unavailable"`.

**C. Negative Perpl rate, non-hour interval, rounding toward zero.** `rate = −7` micros per 2,571 s (≈ 8,571 blocks × 0.3 s; the interval is whatever context reports) ⇒ exact −85,862,310,385,064,177.2… ⇒ **APR_p = −85_862_310_385_064_177** (toward zero). With A's OI: **MFI = −71_610_015_286_148_356 (−7.161002%)**.

**D. Zero OI everywhere.** Equal weights ⇒ **MFI = (APR_m + APR_p) / 2 = 107_309_999_996_496_000**, `weighting: "equal"`.

**E. No venue fresh.** `index` keeps the last value (or `null`), `stale: true`.

An independent exact-rational recomputation (Python `fractions`) gives the same integers for A–D.

## 9. History storage and the Envio entity

**Decision (owner D7, 5 Oct 2026): option A.** The service persists history as append-only JSONL (`MFI_HISTORY_PATH`, default `mfi/data/history.jsonl`), reloads it on start and keeps 7 days (`mfi/src/mfi/historyStore.ts`).

Envio HyperIndex indexes onchain events; the MFI is offchain data. Options:

| | How | Pros | Cons |
|---|---|---|---|
| **A. Service store (v0 default)** | `mfi/` keeps its own history (append-only JSON lines / SQLite, bounded retention) and serves `/v1/mfi/history` | Simple, no indexer coupling, works when the indexer lags | Two read paths for the app (indexer + MFI API) |
| **B. Envio Effect** | On each `FundingCheckpoint` event (every 200 blocks ≈ 60 s), the handler calls an Envio `createEffect` (available in envio 3.12.1, `index.d.ts`; rate-limited, `cache: true`) that fetches the Perpl rate in force at the checkpoint's timestamp (`/funding/:t-:t` returns the rate in force) and writes an `MfiSnapshot` entity | One GraphQL source; reorg-safe; history back-fillable for the Perpl **rate** | Perpl OI history isn't in the API (ticker is current only), so back-filled snapshots lack weights; ties indexer sync to Perpl's API availability |
| **C. Onchain publisher (roadmap)** | A keeper posts `MfiPublished(aprWad, venues…)`; Envio indexes the event | Fully onchain, composable | New contract after the 8 Oct freeze: not in scope |

**Proposed entity** (for B, or C later):
```graphql
type MfiSnapshot @index(fields: [["blockNumber", "DESC"]]) {
  id: ID!                    # "<chainId>-<blockNumber>"
  blockNumber: BigInt!
  timestamp: BigInt!         # seconds
  aprWad: BigInt             # null when no venue included
  weighting: String!         # "oi" | "equal" | "none"
  meridianAprWad: BigInt!
  meridianOiNotionalWad: BigInt!
  perplAprWad: BigInt        # null when Perpl not included
  perplOiNotionalWad: BigInt
  perplRateMicros: Int
  perplFundingIntervalSec: Int
  venuesIncluded: [String!]!
  source: String!            # "service" | "effect" | "onchain"
}
```
**Recommendation:** A for v0 (the app reads `/v1/mfi/history`), and Envio stores the **Meridian component** history it already has (FundingCheckpoint) plus, if the owner agrees, B for the Perpl rate. **Decision needed (T7).**

## 10. Claim limits for the write-up

- "MFI v0 is computed offchain by an open-source service from Meridian's onchain oracle and Perpl's public API." Not: "an onchain index", "a decentralized oracle", "the Monad benchmark rate".
- The onchain publisher, more venues and settlement on MFI are **roadmap**.
- Perpl numbers shown are read from Perpl's API at the time shown; we don't claim partnership or endorsement.
- Until a real Perpl response is recorded, any Perpl figure in tests or screenshots is labelled `synthetic`.
