# RUNBOOK — Pulse keeper + market maker (testnet 10143 / mainnet 143)

Two processes per market: the **keeper** (`keepers/ts-fallback`: oracle pushes, funding pokes, liquidations, `/health`) and the **MM** (`mm-bot`: Avellaneda–Stoikov, 3 levels per side, kill switch). Testnet also has the labelled **MON-PERP-DEMO** test market (`MARKET=demo`), used only for the crash/liquidation demo.

## 1. Environment (`.env`, never committed)
| Var | Keeper | MM | Notes |
|---|---|---|---|
| `CHAIN_ID` | ✓ | ✓ | 10143 testnet, 143 mainnet, 31337 anvil |
| `RPC_URL` | ✓ | ✓ | paid RPC for keepers/bots (public: 25–50 rps, `eth_getLogs` ≤ 100 blocks, R2/R29) |
| `KEEPER_PK` / `MM_PK` | ✓ | ✓ | separate hot keys; the keeper key must hold collateral in the market (the liquidator takes the position) |
| `DEPLOYMENTS` | opt | opt | default `deployments/<CHAIN_ID>.json` (a `deployed: false` placeholder is refused) |
| `MARKET` | opt | opt | `main` (default) or `demo`; MM also `swap` (funding-swap book on the APR axis, below) |
| `ORACLE_KIND` | opt | — | default from deployments: `keeper-fed` (TestnetKeeperOracle) or `pyth` |
| `MONAD_RPC_URL` | keeper-fed | — | **mainnet** RPC, read-only: source = mainnet Pyth MON/USD (R12); unset ⇒ Hyperliquid fallback only |
| `PYTH_MON_USD_FEED_ID` | ✓ | — | `0x3149…6cd1` (R12) |
| `PYTH_API_KEY` | pyth | — | Hermes (R24); without it `pyth` mode pushes nothing |
| `PRICE_FACTOR_FILE` | demo only | — | crash lever; refused with `MARKET=main` |
| `HEALTH_PORT` | opt | — | default 8787; **8787 is taken by another project on the lead's machine: use 8797 (main) / 8798 (demo)** |
| `INCLUSION_LAG_BLOCKS` | opt | — | default **per chain: 6 on 10143** (testnet pokes landed 3–4 blocks after the decision; lag 5 still left a 21-block gap), 2 elsewhere. The poke is sent this many blocks before the 20-block gap bound |
| `LOG_SPAN` | opt | opt | `eth_getLogs` chunk: 100 (public RPC, default), **10 on the Alchemy free tier** |
| `LOOKBACK_BLOCKS` | opt | — | initial log scan when `startBlock` is far back (default 10,000; keep small on a rate-limited key) |
| `FULL_SWEEP_EVERY_BLOCKS` | opt | — | default 50: full liquidation sweep cadence (between sweeps only changed / mark-exposed accounts are read) |
| `SWEEP_AFTER_PUSH_BLOCKS` | opt | — | default 4: full sweeps for this many blocks after every oracle push (the mark follows once the MM re-quotes) |
| `SOURCE_POLL_MS` | opt | — | default 1000: keeper-fed source read at most once per second (it publishes every 10–30 s) |
| `BALANCE_EVERY_BLOCKS` | opt | — | default 100: balance sample for `monPerHour` + the < 5 MON alert |
| `VAULT_REBALANCE` | opt | — | `1` = rebalance the vault (read every `VAULT_EVERY_BLOCKS`=20 and after every oracle push); main market only, Phase 4 |
| `READ_RPC_URL` | — | opt | reads/estimates/receipts on a second endpoint (default `RPC_URL`); sends always go to `RPC_URL` |
| `TICK_EVERY_BLOCKS` | — | opt | default 1; **2–3 on testnet** (300–400 ms blocks) |
| `FULL_REFRESH_TICKS` | — | opt | default 20: `getOrder` on every resting id every N ticks (otherwise only ids a `Trade`/`OrderEvicted` log mentioned) |
| `ESTIMATE_BLOCK_TAG` | — | opt | `pending` (default; anvil includes the block's first funding touch in every estimate) or `latest`. > VERIFY Monad's `eth_estimateGas` "pending" semantics; with `latest` the MM adds `TOUCH_ALLOWANCE_GAS` (default 60k) per tx |
| `CONFLICT_BUFFER_GAS` | — | opt | default 45,000: added to a tx whose side an earlier tx of the batch wrote (capped at the old batch-max rule) |
| `REQUOTE_BPS` / `LEVELS` / `LOTS_PER_LEVEL` | — | opt | index-move threshold (2), levels per side (3), lots (20). Budget runs: `LEVELS=1 REQUOTE_BPS=10` |
| `RECOVER_LOOKBACK_BLOCKS` | — | opt | restart re-adoption scan (default 5,000; small on a fresh key) |
| `SWAP_DUTIES` | opt | — | funding-swap duties run inside the MAIN keeper whenever deployments has `FundingSwapMarket` (`0` = off) |
| `SWAP_FULL_EVERY_BLOCKS` | opt | — | default 10: read every tracked swap account every N blocks (changed and "hot" accounts, equity < 2·MM, every block) |
| `SWAP_LIQ_MAX_SIZE_WAD` | opt | — | cap per swap liquidation (default: whole position). The keeper takes the position and must pass IM afterwards |
| `POLL_MS` | opt | opt | new-block polling interval: keeper 250 (sees every block), MM 250 × `TICK_EVERY_BLOCKS`. `eth_blockNumber` polling is the largest single RPC cost left |
| `KILL_FILE` | — | opt | MM kill switch file |

## 2. Start / stop
```bash
cd keepers/ts-fallback && pnpm start          # keeper (main market)
MARKET=demo PRICE_FACTOR_FILE=/tmp/demo-factor HEALTH_PORT=8788 KEEPER_PK=… pnpm start   # demo keeper (other key)
cd mm-bot && pnpm start                       # MM (main)
MARKET=demo MM_PK=… KILL_FILE=/tmp/KILL-demo pnpm start   # MM (demo)
```
Stop with **SIGINT** (Ctrl-C): the MM cancels its resting orders on SIGINT. Never SIGKILL the MM while it has orders resting (they stay on the book; on restart it re-adopts them from its `OrderPlaced` logs, `RECOVER_LOOKBACK_BLOCKS`).
Before the first testnet start: `pnpm --filter @pulse/keeper-ts check-source` prints what the keeper-fed oracle would push from each source.

## 3. Health
- `curl localhost:$HEALTH_PORT/health` → `ok` is false after 30 s without a completed tick. Fields: `lastBlock`, `fundingPokes`, `feedPushes` (+ `lastFeedSource`), `pythPushes`, `liquidations`, `liquidationLatency {n, p50, p95, max, withinThreeBlocks}`, `openPositions`, `errors`, `lastError`; Phase 4: **`monPerHour`** (balance decrease over the last 30 min, per hour), **`maxFundingGapBlocks`** (observed since start, from `FundingUpdated` logs), `lastFundingUpdateBlock`, `accountReads`, `fullSweeps`, **`rpcCallsPerMin`**, `rpcCalls`, **`rpcErrors`** (failed after retries), `rpcRateLimited` (429s seen), `rpcRetries`, `rpcByMethod`.
- The MM logs a `stats` line every 60 s (txs, Σ gas limit / used, rpc calls/min, errors, resting count).
- The keeper logs `ALERT keeper balance low` below 5 MON (checked every 100 blocks). Monad bills the **gas limit** (R6); every tx uses limit = estimate × 1.2.
- Evidence for a run (read-only): `OUT=… MARKET=main pnpm evidence sample` (every 60 s: best bid/ask + balances of `WATCH` addresses) and `FROM=<start block> pnpm evidence report` (max `FundingUpdated` gap from chunked `getLogs`, book two-sided/≤ 20 bps counts, MON spent).

## 4. Gas and RPC budget (Monad bills the gas LIMIT, R6; testnet floor 100 gwei)
**Measured costs.** Testnet, 30 Sep (Phase 3, before step 1): keeper ≈ **7.3 MON/h** (funding poke ≈ 108k gas limit every ~20 blocks + feed pushes), MM ≈ **24 MON/h** at 3 levels (place ≈ 334k limit, cancel ≈ 141k), ≈ ⅓ of that with `LEVELS=1 REQUOTE_BPS=10`. Budget every testnet run in MON first and stop the bots (SIGINT) when you're not collecting evidence.

**Phase 4 step 1 A/B rehearsal** (30 Sep, two anvils `--chain-id 10143 --block-time 1`, same DeployPulse, same keeper-fed source = live mainnet Pyth, same `INCLUSION_LAG_BLOCKS=2`, 20 min each, measured OUTSIDE the bots by `keepers/rpc/scripts/count-proxy.ts`; anvil = Ethereum gas schedule, so gas is relative, not a Monad number):
| | before (main) | after (step 1) | Δ |
|---|---|---|---|
| keeper RPC calls/min | 675 | 489 | −28% (−44% without the identical `eth_blockNumber` polling: 419 → 233) |
| keeper Σ gas limit/h | 19.95 M (351 tx/h) | 20.52 M (354 tx/h) | +3% = traffic noise: every keeper tx is a mandated poke or push |
| MM RPC calls/min | 960 | 625 | −35% (−47% without polling: 716 → 381) |
| MM Σ gas limit/h | 211.8 M (906 tx/h) | 190.0 M (864 tx/h) | −10% (per tx −6%); Σ limit / Σ used = 1.87 |
| FundingUpdated max gap | 19 (0 > 20) | 19 (0 > 20) | 1,224 blocks each |
Where the RPC went: keeper `eth_call` 229 → 95/min (account reads only on change / mark exposure / full sweep; source and oracle not read per block), `eth_getBlockByNumber` 74 → 21; MM `eth_call` 473 → 147 (getOrder only for ids a Trade/OrderEvicted log mentioned), `eth_getBlockByNumber` 91 → 32. **The largest remaining cost is `eth_blockNumber` polling (~250/min per bot at 250 ms)**: use `POLL_MS` (MM default 250 × `TICK_EVERY_BLOCKS`) or a websocket endpoint when one exists.

**MM gas limits.** Every tx of a pipelined re-quote used to get the batch's max estimate × 1.2. Now each tx gets its own estimate × 1.2, plus `CONFLICT_BUFFER_GAS` if an earlier tx in the batch wrote the same side, capped at the old max rule (so it never bills more). Estimates against `pending` (anvil) already include the block's first funding touch (≈ 70k), which only the first tx of a block pays. That is why limit/used stays ≈ 1.9. The real MON levers on testnet remain `TICK_EVERY_BLOCKS=2–3`, `REQUOTE_BPS=10`, `LEVELS=1`.

**RPC notes.** Alchemy free tier: `eth_getLogs` ≤ **10 blocks** (`LOG_SPAN=10`), bursts throttled (HTTP 429 / "HTTP request failed"). Public `https://testnet-rpc.monad.xyz`: ≤ 100 blocks, ~25 rps. Both bots now retry 429/5xx with capped exponential back-off + jitter (reads also after network errors; a send only after a 429, never after an ambiguous failure) and count everything (`rpcErrors`, `rpcRateLimited`). Give each bot its own endpoint/key. Never put a keyed RPC in the app's `NEXT_PUBLIC_*`.

## 4b. Funding swaps (keeper, Phase 4)
- **One process:** swap liquidations and `settleMaturity` are an extra step of the main keeper (shared tick, log scan, nonce, polling). The keeper key needs **collateral in the swap market** too (`FundingSwapMarket.depositFor(keeper, …)` from the deployer), since the liquidator takes over the position (and its K stream) and must pass IM. Without it, every swap liquidation reverts `InsufficientMargin` (`lastError`).
- Accounts are tracked from `SwapPositionChanged` and kept after `newSize = 0` (a closed position at another APR keeps a K ≠ 0 locked-spread stream that can still be liquidated, MATH_SPEC §6.4). They're dropped only when a read shows size 0, no stream value, MM 0 and no collateral.
- **`settleMaturity()` is called exactly once:** at chain time ≥ `maturity()`, only if `maturitySnapshot().snapped` is false and no call of ours is in flight. `isMatured()` can't be the signal: it is simply `block.timestamp ≥ maturity`. Any touch at/after maturity snapshots lazily and emits `MaturitySettled`; the keeper sees it in its log scan and never calls. After the snapshot, accrual is frozen and position-increasing orders revert `Matured` (reduce-only). The pre-check uses a chain-clock offset refreshed every 300 blocks, never the bare local clock.
- Not implemented: periodic `settle(account)` for idle accounts. `getAccount().accruedNet` already previews the unsettled accrual in the view, so the UI never needs a settle tx.
- **Short test maturities can't be liquidated by a price shock:** the worst-case horizon is `min(liqHorizon, τ)`, so with τ = 10 min the MM of a 106 tAUSD notional is 0.03 tAUSD. The rehearsal ran liquidation on a 30-day market and reached maturity with `evm_increaseTime` (anvil only).
- `/health`: `swapMarket`, `swapTracked`, `swapAccountReads`, `swapLiquidations`, `swapLiquidationLatency {n,p50,p95,max,withinThreeBlocks}`, `maturity`, `maturitySettled`, `maturitySettledByKeeper`.

## 4c. Funding-swap book (MM, `MARKET=swap`, Phase 4)
- Quotes `SwapOrderBook` with `FundingSwapMarket` as the margin engine. The same A–S model runs in **absolute APR bps** around the anchor (MATH_SPEC §4): anchor = `realizedApr(8 h)` (8 h = 96,000 blocks at the CH's `blockTimeMs`). Until the perp has 8 h of checkpoints (`realizedApr` reverts), the anchor is the perp's current funding rate × YEAR, and the MM logs `anchor: perp current funding APR (no 8 h history yet)`. Price = 1 + APR, tick 1e14 = 1 bp; bid snaps ↓, ask ↑.
- Inventory limit = swap `maxPositionSize × SWAP_INVENTORY_FRACTION_BPS` (default 80%); one-sided at the limits. σ comes from the anchor's own series (absolute changes, 8 h window), fallback `SWAP_SIGMA_BPS` = 1 APR bp/√s ⇒ δ ≈ 4.56 APR bps at the §4 defaults (the spec gives no APR-axis σ default; operator choice). `LEVEL_SPACING_BPS` is in APR bps here. `REQUOTE_BPS` compares the anchor in whole APR bps.
- Kill switch, SIGINT drain and stale-oracle pull work as on the perp (the stale check uses the main perp oracle). **At maturity the MM pulls all quotes** (the market is reduce-only). The MM key needs collateral in the swap market (`FundingSwapMarket.depositFor(mm, …)`).
- Start: `MARKET=swap MM_PK=<own key> LEVELS=2 LOTS_PER_LEVEL=3 KILL_FILE=/tmp/KILL-swap pnpm start` (1 lot = 1,000 MON).

## 5. Kill switch (MM)
`touch $KILL_FILE` → the MM cancels all its orders and stops quoting; `rm $KILL_FILE` → it quotes again on the next block. It also cancels everything by itself when the oracle is stale.

## 6. Incidents
| Symptom | Meaning | Action |
|---|---|---|
| `feedPushes` flat, `ALERT no usable price source` | mainnet Pyth unreadable/old (> 60 s) and Hyperliquid down | the test oracle goes stale after 60 s: CH freezes funding, blocks increases (MATH_SPEC §1.6), MM pulls quotes. Check `MONAD_RPC_URL`, run `check-source`. Nothing to undo afterwards |
| Oracle stale (main, `pyth` kind) | no Hermes pushes (key missing/expired) or Pyth down | same as above; fix the key; do **not** change `maxStaleness` to paper over it |
| **Eviction storm** (many `OrderEvicted` for the MM right after stale/paused) | while stale or paused, any taker order evicts the *increasing* makers it touches (≤ 32 per tx) for free: spec-consistent, CR-007 proposes a "skip" code | the MM re-quotes on its next tick (its resting set drops evicted ids via `getOrder`); if the market stays paused, `touch KILL_FILE` so the MM doesn't feed the storm; resume after `setPaused(false)` / oracle fresh |
| `liquidate … reverted` in the keeper log | someone else liquidated first, or the keeper's own margin is short (the liquidator must pass IM after taking the position) | top up the keeper's collateral in that market (`deposit`) |
| MM `errors` climbing, `pipelined:false` in logs | a re-quote step only estimates after an earlier one lands (e.g. partial fills mid-batch): the batch fell back to one tx per block | fine occasionally; if constant, check the book for a crossing order |
| `FundingUpdated` gap > 20 blocks | keeper stalled (RPC, nonce, balance). Fixed cause in Phase 3: a slow external price read blocked the whole tick (56-block gap); the oracle push now has its own loop and a 2 s source timeout | `/health`, restart the keeper; the funding oracle's O(1) path relies on ≤ 20-block gaps (MATH_SPEC §1.8) and falls back to its bounded search otherwise |
| `totalBadDebt` > 0 | cumulative "ever socialized" (not reduced when a later deposit repays negative collateral, PHASES decision 5) | expected after an IF-exhausting crash; top up the IF |

## 7. Demo crash (MON-PERP-DEMO only)
1. A test account opens a ≈ 4–5x long on the demo book (e.g. 30 tAUSD collateral, 50 lots).
2. `echo 0.85 > $PRICE_FACTOR_FILE` → the demo keeper pushes 85% of the source on the next block (publish time = now, demo only).
3. The mark (median of index-implied, book mid, last trade; clamped ±5% of the index) follows once the demo MM has re-quoted (one pipelined batch); the demo keeper liquidates within ≤ 3 blocks of eligibility and logs `liquidation latency` (B7).
4. `echo 1 > $PRICE_FACTOR_FILE` to recover. Never touch the main market's price or parameters for a demo.
