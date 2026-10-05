# RUNBOOK — Pulse keeper + market maker (testnet 10143 / mainnet 143)

Two processes per market: the **keeper** (`keepers/ts-fallback`: oracle pushes, funding pokes, liquidations, `/health`) and the **MM** (`mm-bot`: Avellaneda–Stoikov, 3 levels per side, kill switch). Testnet also has the labelled **MON-PERP-DEMO** test market (`MARKET=demo`), used only for the crash/liquidation demo.

## 1. Environment (`.env`, never committed)
**The bots read only their process environment (no dotenv).** Give each process its own gitignored env file built from `keepers/143.env.example` (names only), with its own key and its own RPC endpoint, and load it in that process's shell with `set -a; source <file>; set +a`. To make sure nothing leaks in from your login shell, start each process with `env -i PATH="$PATH" HOME="$HOME" … pnpm start` (fork rehearsal, 5 Oct).
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
| `VAULT_ROUTE` | opt | `direct` | `flow` on mainnet (Phase 5 B4): each rebalance with a spot leg reads the vault's exact `buySpot`/`sellSpot` amount from a `debug_traceCall` of `rebalanceWithRoute(0x00)` (the RPC must serve `debug_traceCall` + `callTracer`: the public mainnet RPC does, the Alchemy free tier doesn't), quotes Kuru Flow for it minus the haircut (hedger = `userAddress`), refuses any route whose target isn't the hedger's `flowEntrypoint` or whose value ≠ 0, then sends `rebalanceWithRoute`. `direct` = `rebalance()` (testnet MockKuruHedger) |
| `KURU_FLOW_JWT` / `KURU_API_KEY` | flow | — | Kuru auth: a pre-issued JWT or an API key (`X-API-Key`); unset ⇒ the keeper calls `/generate-token` for the hedger address and caches the JWT until 60 s before `expires_at`. Kuru allows **1 rps** (burst 1): calls are spaced ≥ 1.05 s |
| `KURU_FLOW_HAIRCUT_BPS` | flow | 10 | quote this much under the vault's amount (the route may pull at most the exact approval; the hedger returns leftovers). Must stay well under the vault's `maxSlippage` (50 bps), or the output misses minOut |
| `KURU_FLOW_SLIPPAGE_BPS` | flow | 50 | `slippageTolerance` sent to Kuru (advisory: the vault's index ∓ maxSlippage minOut + the hedger's balance-delta check bind) |
| `READ_RPC_URL` | — | opt | reads/estimates/receipts on a second endpoint (default `RPC_URL`); sends always go to `RPC_URL` |
| `TICK_EVERY_BLOCKS` | — | opt | default 1; **2–3 on testnet** (300–400 ms blocks) |
| `FULL_REFRESH_TICKS` | — | opt | default 20: `getOrder` on every resting id every N ticks (otherwise only ids a `Trade`/`OrderEvicted` log mentioned) |
| `ESTIMATE_BLOCK_TAG` | — | opt | `pending` (default; anvil includes the block's first funding touch in every estimate) or `latest`. > VERIFY Monad's `eth_estimateGas` "pending" semantics; with `latest` the MM adds `TOUCH_ALLOWANCE_GAS` (default 60k) per tx |
| `CONFLICT_BUFFER_GAS` | — | opt | default 45,000: added to a tx whose side an earlier tx of the batch wrote (capped at the old batch-max rule) |
| `REQUOTE_BPS` / `LEVELS` / `LOTS_PER_LEVEL` | — | opt | index-move threshold (2), levels per side (3), lots (20). Budget runs: `LEVELS=1 REQUOTE_BPS=10`. **`MARKET=swap`: the threshold is in APR bps, and the anchor (perp rate × YEAR before 8 h of history) moves up to δ·YEAR = 175 APR bps per block, so the default 2 requotes every block: 4,464 txs in 23 min on the fork ≈ 441 MON/h at 102 gwei on 1 s blocks. Set `REQUOTE_BPS=100` or more for the swap MM (§4c measurement)** |
| `MAX_INVENTORY_LOTS` | — | opt | default 200 lots = 20,000 MON. Keep it **below `maxPositionSize` / lot (250 at the launch caps)**: past the cap the MM's asks are evicted when hit, and at its limit the MM quotes one side only (the book goes bid-only, the premium goes negative and funding heads to −cap). Never seed the MM's own inventory to the cap (fork rehearsal: a smoke left it at 25,000 MON) |
| `RECOVER_LOOKBACK_BLOCKS` | — | opt | restart re-adoption scan (default 5,000; small on a fresh key) |
| `SWAP_DUTIES` | opt | — | funding-swap duties run inside the MAIN keeper whenever deployments has `FundingSwapMarket` (`0` = off) |
| `SWAP_FULL_EVERY_BLOCKS` | opt | — | default 10: read every tracked swap account every N blocks (changed and "hot" accounts, equity < 2·MM, every block) |
| `SWAP_LIQ_MAX_SIZE_WAD` | opt | — | cap per swap liquidation (default: whole position). The keeper takes the position and must pass IM afterwards |
| `SWAP_MARK_POKE_EVERY_BLOCKS` | opt | — | default 20 (= the contract's `MARK_MAX_ELAPSED_BLOCKS`); `0` = off. While any swap account is hot, `settle(keeper)` once per N blocks without other swap activity, so the bounded mark keeps converging (B-01, PHASES 18) |
| `POLL_MS` | opt | opt | new-block polling interval: keeper 250 (sees every block), MM 250 × `TICK_EVERY_BLOCKS`. `eth_blockNumber` polling is the largest single RPC cost left |
| `KILL_FILE` | — | opt | MM kill switch file |
| `PAGE_LOCAL_WEBHOOK_URL` | watcher | — | **rehearsal stand-in only**: a localhost receiver (`pnpm page-receiver`) that proves pages are delivered. Refused together with a real channel; never set on mainnet day |

## 2. Start / stop
**Order:** keeper → perp MM → swap MM → wait ≥ 30 s → watcher. A watcher started in the same second as the keeper pages `keeper_stalled` (no tick yet) and then `RESOLVED` 15 s later (fork rehearsal, 5 Oct).
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

**Mainnet-fork rehearsal, 5 Oct** (anvil fork of 143 @ block 110,560,579, 1 s interval mining, idle vault; measured from blocks + receipts by `pnpm tx-cost`; gas price 102 gwei = `cast gas-price` on 143 at 21:17Z; **anvil-fork estimate, not Monad-metered**):
| bot (config) | window | txs | Σ limit / Σ used | MON/h on the fork (1 s blocks) | Monad projection (300 ms blocks) |
|---|---|---|---|---|---|
| keeper (defaults, no Hermes key) | 23.2 min | 53 | 1.20 | 1.78 | ≈ 5.9 (funding pokes are per-block: × 3.33); + ≈ 0.9 with Hermes pushes (testnet feed-only, §11); testnet measured 9.2 at lag 6 |
| perp MM (3 levels, `REQUOTE_BPS=2`) | 23.2 min | 300 | 2.10 | 21.3 (19.1 and 12.8 in the later 5 min windows) | ≈ 20–25 (requotes follow index moves, not blocks); testnet measured ≈ 24 |
| swap MM (2 levels, **defaults**) | 23.2 min | 4,464 | 1.65 | **440.8** | ≈ 1,470: unaffordable |
| swap MM, `REQUOTE_BPS=100` | 5.1 min | 564 | 1.74 | 273.5 | ≈ 910: unaffordable |
| swap MM, `REQUOTE_BPS=1000 TICK_EVERY_BLOCKS=10` | 5.6 min | 100 | 1.84 | **47.6** | ≈ 158 at 10 blocks; **≈ 48 with `TICK_EVERY_BLOCKS=33`** (same ≈ 10 s cadence) |
Launch settings for the swap MM (decision D13): `REQUOTE_BPS=1000 TICK_EVERY_BLOCKS=33`, and `LEVELS=1` to halve it again; the env file is `keepers/143.swap-mm.env.example`. **Guard:** on chain 143 the MM refuses `MARKET=swap` with `REQUOTE_BPS` < 1000 unless `ALLOW_HIGH_BURN=1` (`mm-bot/src/launch.ts`, test `launch.test.ts`). That's a projection, not a measurement. Re-measure in the first hour on 143 (`pnpm tx-cost`), and set the balance floors (§8) from the measured MON/h.

## 4b. Funding swaps (keeper, Phase 4)
- **One process:** swap liquidations and `settleMaturity` are an extra step of the main keeper (shared tick, log scan, nonce, polling). The keeper key needs **collateral in the swap market** too (`FundingSwapMarket.depositFor(keeper, …)` from the deployer), since the liquidator takes over the position (and its K stream) and must pass IM. Without it, every swap liquidation reverts `InsufficientMargin` (`lastError`).
- Accounts are tracked from `SwapPositionChanged` and kept after `newSize = 0` (a closed position at another APR keeps a K ≠ 0 locked-spread stream that can still be liquidated, MATH_SPEC §6.4). They're dropped only when a read shows size 0, no stream value, MM 0 and no collateral.
- **`settleMaturity()` is called exactly once:** at chain time ≥ `maturity()`, only if `maturitySnapshot().snapped` is false and no call of ours is in flight. `isMatured()` can't be the signal: it is simply `block.timestamp ≥ maturity`. Any touch at/after maturity snapshots lazily and emits `MaturitySettled`; the keeper sees it in its log scan and never calls. After the snapshot, accrual is frozen and position-increasing orders revert `Matured` (reduce-only). The pre-check uses a chain-clock offset refreshed every 300 blocks, never the bare local clock.
- Not implemented: periodic `settle(account)` for idle accounts. `getAccount().accruedNet` already previews the unsettled accrual in the view, so the UI never needs a settle tx.
- **Short test maturities can't be liquidated by a price shock:** the worst-case horizon is `min(liqHorizon, τ)`, so with τ = 10 min the MM of a 106 tAUSD notional is 0.03 tAUSD. The rehearsal ran liquidation on a 30-day market and reached maturity with `evm_increaseTime` (anvil only).
- **Swap mark poke (B-01, PHASES 18):** the swap mark moves ≤ 0.5 APR pt per block from a per-block anchor, credited for ≤ 20 blocks, and only a touch stores it (a reverted `liquidate` stores nothing). In a quiet market a genuine regime change therefore reaches the liquidation mark only as fast as the market is touched. While any account is hot the keeper sends `settle(<keeper>)` once every `SWAP_MARK_POKE_EVERY_BLOCKS` quiet blocks (≈ 0.5 pt/block, ≈ 6 s per poke, no gas while every account is healthy). Manual equivalent: `cast send <swap> "settle(address)" <any account>` from any key.
- `/health`: `swapMarket`, `swapTracked`, `swapAccountReads`, `swapLiquidations`, `swapMarkPokes`, `swapLiquidationLatency {n,p50,p95,max,withinThreeBlocks}`, `maturity`, `maturitySettled`, `maturitySettledByKeeper`.

## 4c. Funding-swap book (MM, `MARKET=swap`, Phase 4)
- Quotes `SwapOrderBook` with `FundingSwapMarket` as the margin engine. The same A–S model runs in **absolute APR bps** around the anchor (MATH_SPEC §4): anchor = `realizedApr(8 h)` (8 h = 96,000 blocks at the CH's `blockTimeMs`). Until the perp has 8 h of checkpoints (`realizedApr` reverts), the anchor is the perp's current funding rate × YEAR, and the MM logs `anchor: perp current funding APR (no 8 h history yet)`. Price = 1 + APR, tick 1e14 = 1 bp; bid snaps ↓, ask ↑.
- Inventory limit = swap `maxPositionSize × SWAP_INVENTORY_FRACTION_BPS` (default 80%); one-sided at the limits. σ comes from the anchor's own series (absolute changes, 8 h window), fallback `SWAP_SIGMA_BPS` = 1 APR bp/√s ⇒ δ ≈ 4.56 APR bps at the §4 defaults (the spec gives no APR-axis σ default; operator choice). `LEVEL_SPACING_BPS` is in APR bps here. `REQUOTE_BPS` compares the anchor in whole APR bps.
- Kill switch, SIGINT drain and stale-oracle pull work as on the perp (the stale check uses the main perp oracle). **At maturity the MM pulls all quotes** (the market is reduce-only). The MM key needs collateral in the swap market (`FundingSwapMarket.depositFor(mm, …)`).
- **Anchor at or below −100% APR (price = 1 + APR ≤ 0):** no level can be priced, so the MM quotes nothing and the watcher pages `mm_empty` for the swap MM until the anchor recovers. This happens right after launch: the perp has no 8 h history, so the anchor is the perp's *current* rate × YEAR, which ranges over ±cap (±1,752% APR). On the fork it read −131% after a one-sided perp book. Before the fix (`mm-bot` `buildAprLadder`, 5 Oct), the ask side then sent tick 0 and every requote reverted `InvalidTick()` (`0xce8ef7fc`).
- **Requote threshold:** `REQUOTE_BPS` is in APR bps here. Use **≥ 100** (see the `REQUOTE_BPS` row in §1 and the cost table in §4).
- Start: `MARKET=swap MM_PK=<own key> LEVELS=2 LOTS_PER_LEVEL=3 REQUOTE_BPS=100 KILL_FILE=/tmp/KILL-swap pnpm start` (1 lot = 1,000 MON).

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

## 8. Monitoring and paging (TEAM_PLAN §7; paging Phase 5 B6)
```bash
cd keepers/ts-fallback && CHAIN_ID=143 RPC_URL=<watcher's own endpoint> DEPLOYMENTS=../../deployments/143.json \
  KEEPER_HEALTH=http://localhost:8797/health,http://localhost:8798/health \
  WATCH_BALANCES=deployer=0x…:2,keeper=0x…:<floor>,mm=0x…:<floor>,mmswap=0x…:<floor> \
  WATCH_MM=perp=<MM perp address>,swap=<MM swap address> \
  CHAINLINK_AUSD_USD=0xE20751C7B5867bCBef815ffc1b284c3f412a9e13 CHAINLINK_MON_USD=0xBcD78f76005B7515837af6b50c7C52BCf73822fb \
  PAGE_DISCORD_WEBHOOK_URL=<from .env>   # or PAGE_TELEGRAM_BOT_TOKEN + PAGE_TELEGRAM_CHAT_ID (ONE channel)
  pnpm watch
# ONCE=1 → one check, exit 2 on any critical alert (cron/CI)
```
Run it as a **long-lived process next to the bots** (its own terminal / tmux / `nohup … > watch.log &`), on its own RPC endpoint. Startup prints `paging via discord|telegram|none`.

One line per finding: `ALERT <critical|warn> <code> <message>` (`src/alerts.ts`, unit-tested).
| Code | Sev | Fires when | First response |
|---|---|---|---|
| `oracle_stale` | crit | adapter says stale ⇒ funding frozen, increases blocked | keeper push loop / Pyth; §6 |
| `funding_gap` | crit | no funding touch for > 100 blocks | keeper down? restart; §2 |
| `if_drop` | crit | IF > 20% below its peak | check liquidations / bad debt |
| `vault_margin` | crit | hedged and perp margin ratio < 30% | keeper `rebalance` (MarginLow) |
| `vault_share_drop` | crit | share price > 50 bps under its peak (review A-09) | check the last `Rebalanced` fills; if unexplained **revoke the keeper** (`setKeeper(k, false)` from the Safe) |
| `mm_empty` | crit | an MM has had 0 open orders > 60 s (eviction storm B-04, crash, kill switch left on) | MM logs; restart / remove KILL file |
| `maturity_unsettled` | crit | swap matured > 60 s ago with OI and no snapshot | `cast send <swap> "settleMaturity()"` from any key |
| `ausd_depeg` | crit | Chainlink AUSD/USD < 0.99 (RISKS E4) | §10: pause deposits / markets per incident flow |
| `keeper_down` / `keeper_stalled` | crit | `/health` unreachable or `ok: false` | restart that bot |
| `watcher_error` | crit | the watcher's own read failed | its RPC |
| `oracle_old` | warn | oracle age > 30 s | — |
| `maturity_soon` | warn | swap maturity < 24 h with OI | confirm the keeper runs swap duties |
| `ausd_feed_old` / `guard_feed_old` | warn | Chainlink AUSD/USD or MON/USD > 2 h old (depeg monitor blind / the Pyth deviation guard is off, review A-15) | — |
| `keeper_balance` | warn | a wallet below its floor (`label=addr:MON`; default 5 MON) | top it up (§4 costs) |
| `indexer_lag` | warn | > 30 s (`INDEXER_LAG_URL` returning `{"lagSec"}`; > VERIFY the Envio endpoint before wiring it) | — |

**Paging (`src/paging.ts`, unit-tested):** a code pages when it starts firing, again every 15 min (critical) / 2 h (warn) while it keeps firing, and once as `✅ RESOLVED` when it clears. Everything due in one cycle goes out as **one** message; at most 6 messages per minute, and the overflow is folded into the next message, never dropped. Provider shapes: Discord "Execute Webhook" `POST /webhooks/{id}/{token}` `{"content"}` ≤ 2,000 chars; Telegram `https://api.telegram.org/bot<token>/sendMessage` `{"chat_id","text"}`. A delivery failure prints `PAGE_FAILED <detail>` (secret redacted) and the watcher keeps going. **The team picks ONE channel** (both set = startup error). The webhook URL / bot token is a secret: `.env` only.
**Balance floors:** = MON/h of that bot (§4, scaled to the mainnet gas price) × 12 h of runway, so a page leaves half a day to refill.

## 9. Swap keeper duties, swap MM, vault rebalancing (Phase 4)
- **Keeper:** swap liquidations + `settleMaturity` run inside the main keeper whenever the deployment has `FundingSwapMarket` (section 4b). Vault: `VAULT_REBALANCE=1` (needsRebalance every 20 blocks and after each oracle push). **Mainnet launch (PHASES 17): the vault is idle** (`skewCapacity = 0` ⇒ `needsRebalance()` is always `None`, so the keeper sends nothing; `enterHedge` reverts `NothingToDo`). Leave `VAULT_REBALANCE=1`: it starts working by itself when the Safe raises `skewCapacity` after CR-010. The keeper key needs collateral in the CH **and** the swap market, and must be registered as the vault keeper (`DeployPulse` does it via `KEEPER_ADDRESS`).
- **Swap MM:** `MARKET=swap` with its own key and swap-market collateral (section 4c). Stop with SIGINT; it pulls its quotes at maturity by itself.
- **Testnet vault spot leg** is the labelled `MockKuruHedger` at a settable price. The vault checks spot vs index ± 0.5%, so sync it before rebalancing on testnet: `cast send <KuruHedger> "setPrice(uint256)" <index>` (anyone can; testnet mock only).
- **Entry rule:** the vault hedges only when `averageFundingRate(8 h)` × 7 d > 2c (≈ 15.6% APR), so it needs 8 h of continuous checkpoints. On testnet that is ≈ 9 MON/h × 8 h of pokes at lag 6; plan the MON, or use the keeper-only `enterHedge()` for a labelled forced entry.
- `SkewCap` fires only when the short exceeds capacity **plus one lot** (hysteresis). A slice buys back ⌈excess⌉ lots with `minFilled` = all, so it reverts `SlippageExceeded` if the book offers less within 0.5%; that is the protection working, not a bug.

## 10. Incident flow
1. **Contain:** `touch $KILL_FILE` on every MM (quotes pulled). If the market itself is unsafe (oracle wrong, exploit suspected), the owner calls `ClearingHouse.setPaused(true)` / `FundingSwapMarket.setPaused(true)`: increases are blocked, reduce-only, cancels, deposits and liquidations keep working (MATH_SPEC §1.6).
2. **Reduce-only period:** keep the keeper running (liquidations must continue while paused). Lower `maxOpenInterest` / `maxPositionSize` with `setRiskParams` if exposure must shrink. Never change `maxStaleness` to hide an oracle problem.
3. **Communicate:** status line in the app + the team channel: what is paused, what still works (withdrawals, closing), next update time. Write the timeline into `docs/standup/<you>.md`.
4. **Resume:** `setPaused(false)` after the cause is fixed and the oracle is fresh; `rm $KILL_FILE`; watch `pnpm watch` for 30 min.

## 10b. Seeding on 143 (rehearsed on the mainnet fork, 5 Oct)
Permissionless, after `DeployPulse` and `VerifyDeployment` pass. Addresses come from `deployments/143.json` (`jq -r .contracts.<Name>`). AUSD has 6 dp (R9), so `1000000000` = 1,000 AUSD. **Approve exact amounts, never `max`, on mainnet.** Each line runs from the key named, in that process's own shell; gas limit = estimate × 1.2 (cast does this with `--gas-limit $(( $(cast estimate …) * 12 / 10 ))`).
```bash
A=$(jq -r .contracts.AUSD $D); IF=$(jq -r .contracts.InsuranceFund $D); CH=$(jq -r .contracts.ClearingHouse $D)
SW=$(jq -r .contracts.FundingSwapMarket $D); V=$(jq -r .contracts.PulseVault $D)      # D=deployments/143.json
# 1. insurance fund (any funded key; capital plan: 1–2k AUSD)
cast send $A "approve(address,uint256)" $IF <amt>;  cast send $IF "fund(uint256)" <amt>
# 2. keeper: perp collateral (it takes liquidated positions) + swap collateral (§4b)
cast send $A "approve(address,uint256)" $CH <amt>;  cast send $CH "deposit(uint256)" <amt>          # keeper key
cast send $A "approve(address,uint256)" $SW <amt>;  cast send $SW "deposit(uint256)" <amt>          # keeper key
# 3. perp MM collateral (MM key = MM_ADDRESS, the registered skew provider); 4. swap MM collateral (swap MM key)
cast send $A "approve(address,uint256)" $CH <amt>;  cast send $CH "deposit(uint256)" <amt>          # perp MM key
cast send $A "approve(address,uint256)" $SW <amt>;  cast send $SW "deposit(uint256)" <amt>          # swap MM key
# 5. vault (idle launch): total deposits ≤ depositCap 1,200 AUSD; maxDeposit(x) shows what is left
cast send $A "approve(address,uint256)" $V <amt>;   cast send $V "deposit(uint256,address)" <amt> <receiver>
# checks
cast call $IF "balance()(uint256)"; cast call $CH "collateralOf(address)(int256)" <acct>; cast call $SW "collateralOf(address)(int256)" <acct>
cast call $V "totalAssets()(uint256)"; cast call $V "maxDeposit(address)(uint256)" <any>          # 1,200 AUSD − deposits
```
Fork results with these calls (the keeper's swap collateral went in as `cast send $SW "depositFor(address,uint256)" <keeper> <amt>` from the deployer; both work): IF 1,500 AUSD; keeper 500 AUSD (CH) + 200 (swap); perp MM 3,000 (CH) + 1,000 (swap); swap MM 800 (swap); vault 1,000 AUSD with `maxDeposit` 200 left (the cap holds). The perp MM must start **flat** (no inventory) and stay under `MAX_INVENTORY_LOTS` (§1).

## 11. Lessons from Phases 3–4 (testnet, 30 Sep)
- **Monad bills the gas limit, and its receipts report `gasUsed` = the limit** (also in `debug_traceTransaction`). Execution gas isn't observable; `eth_estimateGas` is the proxy. At the 100 gwei floor: keeper ≈ **9.2 MON/h** at lag 6 (67 pokes + 31 pushes in 6 min), feed-only ≈ 0.93 MON/h, MM ≈ 24 MON/h at 3 levels (the demo MM at 1 level burned 0.35 MON in ≈ 5 min). Per op (billed): place ≈ 231k, replace ≈ 210k, cancel ≈ 140k, perp liquidation ≈ 214k, swap place ≈ 472–485k, `settleMaturity` ≈ 239k, vault `enterHedge`/`rebalance` see standup A, feed push ≈ 54k, funding poke ≈ 108k (≈ 153k when it also writes a checkpoint).
- **Oracle freshness on the main market:** the keeper-fed oracle stores the *source's* publish time (mainnet Pyth, often 20–30 s old at push time), so a heartbeat near `maxStaleness` (60 s) leaves stale windows. Keep `FEED_HEARTBEAT_SEC` ≤ 10 whenever anything trades. Budget runs with 40–50 s produced `OracleStale` reverts that looked like out-of-gas (`gasUsed == limit` on Monad for any failure). Replay the calldata at the parent block (`cast call --block N-1`) to see the real reason.
- **RPC:** Alchemy free tier `LOG_SPAN=10`; public RPC 100 blocks / ~25 rps. One endpoint per bot. The keeper needed no 429 retries at ≈ 440 calls/min on Alchemy (6 min run).
- **Inclusion lag:** testnet pokes land 3–4 blocks after the decision, so lag 6 is needed (gaps 17–20, max 20 over 1,201 blocks). Lag 2 gave gaps of 21–22 and lag 5 one gap of 21.
- **Liquidation latency on a free RPC:** 8 blocks after eligibility (estimate + send + receipt ≈ 3.2 s). The ≤ 3-block target needs the keeper on its own paid endpoint.
- **Per-process keys** (nonces): a forge broadcast failed "EOA nonce changed" while another process used the deployer key, and forge had already written the deployments JSON during the simulation. Check `cast code` for every recorded address.
- **Stop the MM only with SIGINT** and check `openOrderCount(mm) == 0`. Start bots from a directory that will still exist: `cast` panics ("could not determine project root") when its cwd was deleted, which silently killed a feeder loop.
- **Fork rehearsal, 5 Oct (mainnet fork of 143, anvil, `docs/standup/PHASE3_LOOP.md` P4):**
  - Anvil's public dev accounts carry **EIP-7702 delegations on Monad mainnet** (sweeper bots). On a fork, clear them with `anvil_setCode <addr> 0x`, and never use those keys on 143.
  - A fork has no sponsored Pyth pushes and its clock follows wall time, so the adapter goes stale 60 s after the fork starts. `pnpm fork-pyth-relay` replays the real signed mainnet updates onto the fork.
  - **One MM key = at most `maxPositionSize` of inventory** (25k MON). At the cap its asks are evicted, the book goes one-sided and funding swings toward −cap. With a stale bid wall left after an index move, the mark sits at index + 5% and liquidations wait (P3 crash demo).
  - **The MM's inventory skew sets the published funding rate:** a sustained 1 bp premium is 87.6% APR (T = 3,600 s). With the perp MM short 10k MON (q = −0.5), its A–S reservation of +3.8 bps took the rate to ≈ +454% APR within 20 min. On launch day, start the MM flat and watch the realized APR.
  - The deploy needs `--gas-estimate-multiplier 200`: ×1.20 ran `CH.setOrderBook` out of gas on the fork.
