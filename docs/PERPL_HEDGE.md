# Perpl hedge for the Meridian market maker (K3)

Meridian's market maker (`mm-bot`, Avellaneda–Stoikov) quotes MON-PERP on Meridian's onchain book. Without a hedge it carries all of its inventory itself: as the position builds, `q = inventory / maxInventory → ±1`, the reservation price shifts away from the index and at `|q| = 1` it quotes **one side only**. K3 lets it offload that leftover inventory to **Perpl**, the other perp on Monad, through Perpl's authenticated trading API, so it can quote tighter and on both sides. It also moves the Meridian Funding Index (MFI) onto Perpl's live market-data WebSocket and publishes the **Meridian–Perpl funding spread** (`/v1/mfi/spread`).

Status (7 Oct 2026): code and tests done; testnet run and before/after numbers pending the owner setup in §9 (PROOF §12 holds the evidence once run).

## 1. Design

```
             Meridian (10143)                                Perpl testnet (10143)
  ┌──────────────────────────────┐   merPos, index   ┌──────────────────────────────────────────────┐
  │ mm-bot main.ts               │ ────────────────► │ hedger.ts (runtime)                          │
  │  A–S quotes on q = Δ/maxInv  │ ◄──────────────── │  hedge.ts decideHedge(): hold | hedge | halt │
  │  (Δ = merPos + perplPos when │   quoteInventory  │  perpl/trading.ts  ── wss /ws/v1/trading ──► │ signed sign-in, mt 22 orders,
  │   the hedge is live)         │                   │                    ◄── mt 3/19/21/23-27/100  │ snapshots + streams
  └──────────────────────────────┘                   │  perpl/trading.ts  ── https POST /orders ──► │ REST fallback (signed)
                                                     │  mfi MarketDataSocket ── /ws/v1/market-data ►│ bid/ask, config, funding
  mfi service ── /ws/v1/market-data (funding) ──────►│                                              │
     /v1/mfi, /v1/mfi/spread ◄── REST backfill ──────┴──────────────────────────────────────────────┘
```

- **Net delta** `Δ = merPos + perplPos` (MON). The MM's A–S inventory term uses `q_net = Δ / maxInventory` while the hedge is live and its Perpl state is fresh; otherwise Meridian-only `q`, exactly as before (`hedge.ts quoteInventoryWad`). With `PERPL_HEDGE` unset there is no Perpl code path at all (`perplHedgeFromEnv` returns `undefined`).
- **One policy step per MM tick**, pure (`mm-bot/src/hedge.ts`, 28 unit + seeded-fuzz tests): hedge only when `|Δ − target| > band`; size `= |Δ − target| − residual`, capped per order and by total Perpl notional; **IOC** limit at Perpl mid ± `slippageBps`, rounded toward mid; size rounded **toward zero** to `size_decimals` (never over-hedge). Reducing the opposite Perpl position uses reduce-only `CloseLong`/`CloseShort`, clamped to the position (never inverts).
- **Price-divergence guard:** skip if `|perplMid / meridianIndex − 1| > maxDivergenceBps` (testnet venues aren't arbitraged; 7 Oct: Meridian index 0.02588, Perpl mid 0.02578, 39 bps apart).
- **Never trust an ack:** `code: 0` on `mt: 3` means "accepted for forwarding". The outcome is the first definitive `mt: 24` for the request id (dedup rules from websocket.md); fills come from `mt: 25`; positions from `mt: 26/27`. Until an order has an outcome, no new hedge is sent (`inFlight`).
- **Evidence:** every decision with inputs, rq, order id, outcome, fills and positions before/after → `HEDGE_EVIDENCE` (JSONL, secrets redacted).

## 2. Perpl API surface used (docs: [PerplFoundation/api-docs](https://github.com/PerplFoundation/api-docs), read 7 Oct 2026)

| What | Where in the docs | Our code |
|---|---|---|
| API-key auth, REST: `chain_id\nMETHOD\ntarget\nts_ms\nnonce\nsha256(body)` → Ed25519 → base64url in `X-API-Signature` (+ `X-API-Key`, `X-API-Timestamp`, `X-API-Nonce`) | [authentication.md](https://github.com/PerplFoundation/api-docs/blob/main/authentication.md) | `mm-bot/src/perpl/auth.ts` (fixed vectors + RFC 8032 + node:crypto cross-check in `test/perpl-auth.test.ts`) |
| Trading WS sign-in `mt: 29` ApiKeySignIn, first frame, signs `chain_id\ntrading-ws-signin\nts\nnonce`; failure ⇒ close 3401 | authentication.md "WebSocket authentication", [websocket.md](https://github.com/PerplFoundation/api-docs/blob/main/websocket.md) "API-key sign-in" | `trading.ts signIn` |
| Initial snapshots `mt: 19` wallet (`as[]`: `fw`, `lfr`, `b`, `lb`, `ft`), `mt: 23` orders, `mt: 26` positions | websocket.md "Initial Snapshots" | `state.ts` |
| Streams `mt: 21` account, `24` orders, `25` fills, `27` positions, `100` heartbeat (sequence from the wallet snapshot's `sn`, gap ⇒ reconnect) | websocket.md "Order/Fill/Position/Account Updates", "Heartbeat (Trading)" | `state.ts`, `trading.ts` |
| Orders `mt: 22` OrderRequest (`OrderSpec`): `rq = max(local, lfr) + 1`, unique `sn` ⇄ `cid`, `lb = head + order_ttl_blocks`, `t` 1–5, `fl: 4` IOC, `lv` hundredths | websocket.md "Placing Orders", [types.md](https://github.com/PerplFoundation/api-docs/blob/main/types.md) "OrderSpec" | `trading.ts place`, `hedge.ts` |
| Command status `mt: 3` (admission only); outcome dedup (first non-failure definitive) | websocket.md "Command Status", "Client-side deduplication" | `trading.ts onStatus`, `state.ts` |
| Order forwarding prerequisite: `fw` on the account; missing ⇒ `st: 7`, `sr: 34` | [README.md](https://github.com/PerplFoundation/api-docs/blob/main/README.md) "Enabling Order Forwarding" | `hedge.ts haltReasons` |
| REST order submission `POST /v1/trading/orders` (batch of one; per-order `statuses[]`) | [rest-endpoints.md](https://github.com/PerplFoundation/api-docs/blob/main/rest-endpoints.md) "Order Submission" | `trading.ts place` (fallback) |
| REST state `GET /v1/trading/{wallet,orders,positions}` (same shapes as the WS snapshots; 404 = no account) and `GET /v1/trading/order-history` | rest-endpoints.md "Trading State Endpoints", "Trading History" | `trading.ts restSnapshot`, `confirmOverRest` |
| Market data WS `/ws/v1/market-data`: `mt: 5` subscribe to `heartbeat@`, `market-config@`, `market-state@`, `funding@<chain>`; `mt: 6/8/9/10/100` | websocket.md "Market Data WebSocket" | `mfi/src/perpl/ws.ts` |
| REST market data: `/v1/pub/context` (markets, `order_ttl_blocks`, fees, collateral token), `/v1/market-data/:id/funding/:from-:to` (backfill), `/ticker` (fallback) | rest-endpoints.md "Public Endpoints" | `mfi/src/perpl/client.ts`, `live.ts` |
| Fees `maker_fee`/`taker_fee` (+ per-tier arrays), micros: `1000` = 0.1% | README "Fees & fee tiers" | `ws.ts feeForTier`, `/v1/mfi/spread` |
| Limits: trading 60 req/min (testnet), 4 connections per wallet; market data 10 req/min, 16 subscriptions; close codes 1001/1008/1011/1013/3401 | README "Rate Limits", "WebSocket Close Codes" | `ratelimit.ts` (≤ 50/min), one trading + one market-data connection, `reconnectDelayMs` |

## 3. Units

| Quantity | Perpl (testnet MON, market 64) | Ours |
|---|---|---|
| price | scaled int, `price_decimals` 5 (0.02578 = 2578) | WAD (`scaledPriceToWad`) |
| size | scaled int, `size_decimals` 0 (whole MON) | MON WAD; to Perpl **toward zero** (`wadToScaledSize`) |
| funding `rate` | micros of notional per interval (2,580 s, 8,571 blocks) | annualized WAD, rounds neutral (MFI.md §3.2) |
| fees | micros (`taker_fee` 345 = 3.45 bps, `maker_fee` 45) | WAD fraction (`× 1e12`) on `/v1/mfi/spread`; Meridian `RiskParams.takerFee` 5 bps, `makerFee` −1 bp |
| collateral `b`, `lb` | decimal string, collateral token units: **AUSD `0xa9012a…22dc`, 6 dp** per `/v1/pub/context` (see §8) | `availableCollateral = b − lb` (bigint) |
| leverage `lv` | hundredths (500 = 5×); MON `initial_margin` 300 ⇒ max ≈ 33× | `HEDGE_LEVERAGE` |
| `lb` | block, `head < lb ≤ head + order_ttl_blocks` (20 on MON) | `trading.ts lastExecBlock` |

`spreadApr = APR_meridian − APR_perpl` (annualized WAD, exact difference of two neutral-rounded rates); `null` unless both venues are included in that MFI cycle.

## 4. Risk limits (defaults; env in §7)

| Limit | Default | Why |
|---|---|---|
| band | 25% of `maxInventory` (5,000 of 20,000 MON) | hedge only real inventory, not noise |
| residual | 0 MON | hedge to flat |
| max per order | 5,000 MON | one IOC never walks far into Perpl's book |
| max Perpl notional | $500 | bounded exposure on a venue we don't control |
| slippage | 50 bps from mid | MON half-spread on Perpl testnet ≈ 31 bps (7 Oct) |
| max divergence | 300 bps | testnet prices aren't arbitraged |
| cool-down | 15 s between hedges | ≈ 4 orders/min worst case vs 60/min |
| rate | token bucket 50/min, burst 5 (orders, pings, sign-ins) | 1008 on overrun loses in-flight requests silently |
| connections | 1 trading + 1 market data | 4 per wallet, shared with browser sessions |

## 5. Failure modes and what happens

| Failure | Detection | Response |
|---|---|---|
| `fw` false (One-Click Trading off) | `Account.fw` on `mt: 19/21`; or `mt: 24` `st: 7 sr: 34` | **halt** (no orders), page; MM quotes unhedged |
| no exchange account | `GET /v1/trading/wallet` 404 / empty `as[]` | refuse at startup, logged with the fix |
| bad / revoked key | close 3401 / REST 401 | reconnect with a fresh signed sign-in; data goes stale ⇒ halt |
| trading WS drop (1006, 1008, 1011) | `onclose` | in-flight orders ⇒ "unknown", reconcile from snapshots; back-off 1→60 s ±25% |
| server going away (1001) | close code | reconnect at once |
| slow consumer (1013) | close code | 30 s pause, then back-off |
| heartbeat gap | `sn !== last + 1` | force reconnect (fresh snapshots) |
| idle timeout while signed in | close 1008 "idle timeout" | keep-alive tightened to 8 s (testnet idle window 10 s) |
| stale data (> 15 s) | last trading frame / market-state age | **halt**, cancel resting Perpl orders, page |
| N rejections in a row (3) | `mt: 3` non-zero, `mt: 24` failures, throttle | **halt** (circuit breaker) until restart |
| collateral below minimum | `b − lb` | **halt** |
| order with no status by `lb + 10` blocks | heartbeat head | "unknown" ⇒ reconcile; never assumed filled |
| venue prices diverge | `|perplMid/index − 1|` | hold (logged) |
| SIGINT/SIGTERM | signal | MM cancels its Meridian quotes, hedger cancels resting Perpl orders, **leaves positions** (logged) |

## 6. Measurement (K3.4)
`bench/perpl_hedge.ts` samples Meridian's book every 5 s (inner spread, depth within ±1% of the index per side, one-sided flag) and the MM's Meridian and Perpl positions; `report` turns a hedge-off CSV, a hedge-on CSV and the evidence JSONL into the before/after table (PROOF §12). Same house flow settings for both halves: `pnpm flow` from `mm-bot` with the RUNBOOK §2b settings.

## 7. Configuration
Root `.env.example` lists every variable (empty or safe defaults). `PERPL_HEDGE=1` enables; `PERPL_API_KEY`, `PERPL_API_KEY_SECRET` (never logged; X-API-* headers and the sign-in signature are redacted in logs and evidence). Startup **hard-fails** unless `PERPL_CHAIN_ID=10143` and both URLs are on `testnet.perpl.xyz`.

## 8. Verified live vs open (> VERIFY)
Verified on testnet, 7 Oct 2026:
- Market-data WS: the `mt: 6` reply listed `funding@10143` under **sid 3000** (market-state's), while funding frames (`mt: 10`) arrive on **sid 4000**: routing is by `mt` (fixture `mfi/fixtures/recorded/testnet/ws/control.jsonl`, test `ws.test.ts`). `mt: 8/9/10` carry `d: { [marketId]: … }` maps (not documented per type).
- Trading WS without sign-in closes **1008 "idle timeout" after 10.9 s**; a sign-in with an unknown key closes **3401 "unauthorized"** (1.5 s) — so our frame parses (a malformed one would be 1011).
- MFI served from the WS (`perpl:ok/ws`) with REST only for the first cycle; `/v1/mfi/spread` live: Meridian 266.4% APR, Perpl 36.7% APR, spread +229.7% APR (block 69,007,268).
- **One funding interval = two `mt: 10` frames** (16:50:25 and 16:50:49 UTC, feb 69,022,263, rate −10 micros ≈ −12.2% APR): the first with an estimated `at.t` ahead of the head, the second with the final `at.t`, exactly as types.md says. The feed classes them `new` then `final` (fixture `funding-interval-64.jsonl`).
- **Market-data sockets do drop:** one capture was closed by the server with `1008 "ping timeout"` within 50 min; a probe socket went **silent for 70 s** and then died `1006` after 37 min. Both are why the MFI socket has a 15 s silence watchdog and reconnects (and why REST stays as the fallback).
- **Collateral:** README lists testnet collateral `0xdf5b718d…c027` ("USD"), but `/v1/pub/context` on testnet returns token id 1 = **AUSD `0xa9012a055bd4e0edff8ce09f960291c09d5322dc`, 6 decimals**, `min_account_open_amount` 100 AUSD. The context endpoint is what the docs say to read at runtime; we follow it.

- **Read-only trading session (8 Oct, hedge account 969):** signed sign-in accepted; snapshots arrive 19 → 23 → 26; heartbeats every block with `sn` = wallet-snapshot `sn` + 1; **no pings for 45 s and the socket stayed open** (the 10 s idle timeout applies before sign-in only, so the documented 30 s keep-alive is enough). Fixture `mm-bot/fixtures/recorded/testnet/trading-session.jsonl`, test `perpl-recorded.test.ts`. Signed REST `GET /v1/trading/{wallet,orders,positions,fills}` → 200.
- **Account setup done by script (8 Oct):** test AUSD from Agora's testnet faucet `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C` (`requestFunds(address)`, 10,000 per call, ≤ 1/min, ≤ 100,000 held; `token()` = Perpl's collateral), then Perpl's documented calls: `approve`, `createAccount(5,000 AUSD)` → account **969**, `allowOrderForwarding(true)`; API key enrolled with `mm-bot/scripts/perpl-enroll.ts` (integrations.md flow, no Origin header; Perpl's typed data carries integers as strings such as `chainId: "0x279f"`, which must be hashed as numbers or enroll answers 400).

Open:
- > VERIFY (MFI.md §2 b): positive funding ⇒ longs pay. The optional funding bias stays off until a recorded settlement proves the sign.
- > VERIFY: per-account fee tier `ft` on our hedge account (fees on `/v1/mfi/spread` are the base tier).

## 9. Owner setup (one time)
1. New hedge wallet (not the MM key); ~1 testnet MON.
2. Test AUSD: `requestFunds(<hedge wallet>)` on Agora's faucet `0xd236…ee6C` (any sender may pay the gas). Then on the Perpl exchange: `approve` + `createAccount(amount)` (≥ 100 AUSD; ~5,000 recommended) and `allowOrderForwarding(true)` (= the UI's **One-Click Trading**). The testnet.perpl.xyz UI does the same.
3. API key with **trade** scope: testnet.perpl.xyz/apikeys, or `mm-bot/scripts/perpl-enroll.ts` ⇒ `PERPL_API_KEY`, `PERPL_API_KEY_SECRET` in the gitignored `.env`.
4. MON for the MM, keeper and flow for the run (RUNBOOK §2b: ≈ 15 MON/h for all three).
