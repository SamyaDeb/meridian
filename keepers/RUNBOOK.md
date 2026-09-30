# RUNBOOK — Pulse keeper + market maker (testnet 10143 / mainnet 143)

Two processes per market: the **keeper** (`keepers/ts-fallback`: oracle pushes, funding pokes, liquidations, `/health`) and the **MM** (`mm-bot`: Avellaneda–Stoikov, 3 levels per side, kill switch). Testnet also has the labelled **MON-PERP-DEMO** test market (`MARKET=demo`), used only for the crash/liquidation demo.

## 1. Environment (`.env`, never committed)
| Var | Keeper | MM | Notes |
|---|---|---|---|
| `CHAIN_ID` | ✓ | ✓ | 10143 testnet, 143 mainnet, 31337 anvil |
| `RPC_URL` | ✓ | ✓ | paid RPC for keepers/bots (public: 25–50 rps, `eth_getLogs` ≤ 100 blocks, R2/R29) |
| `KEEPER_PK` / `MM_PK` | ✓ | ✓ | separate hot keys; the keeper key must hold collateral in the market (the liquidator takes the position) |
| `DEPLOYMENTS` | opt | opt | default `deployments/<CHAIN_ID>.json` (a `deployed: false` placeholder is refused) |
| `MARKET` | opt | opt | `main` (default) or `demo` |
| `ORACLE_KIND` | opt | — | default from deployments: `keeper-fed` (TestnetKeeperOracle) or `pyth` |
| `MONAD_RPC_URL` | keeper-fed | — | **mainnet** RPC, read-only: source = mainnet Pyth MON/USD (R12); unset ⇒ Hyperliquid fallback only |
| `PYTH_MON_USD_FEED_ID` | ✓ | — | `0x3149…6cd1` (R12) |
| `PYTH_API_KEY` | pyth | — | Hermes (R24); without it `pyth` mode pushes nothing |
| `PRICE_FACTOR_FILE` | demo only | — | crash lever; refused with `MARKET=main` |
| `HEALTH_PORT` | opt | — | default 8787 (pick a free port per keeper) |
| `INCLUSION_LAG_BLOCKS` | opt | — | default 2: the poke is sent this many blocks before the 20-block gap bound (1 left 21-block gaps in the rehearsal) |
| `VAULT_REBALANCE` | opt | — | `1` = rebalance the vault (MarginLow every block, else every `VAULT_EVERY_BLOCKS`=20); main market only, Phase 4 |
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
- `curl localhost:$HEALTH_PORT/health` → `ok` is false after 30 s without a completed tick. Fields: `lastBlock`, `fundingPokes`, `feedPushes` (+ `lastFeedSource`), `pythPushes`, `liquidations`, `liquidationLatency {n, p50, p95, max, withinThreeBlocks}`, `openPositions`, `errors`, `lastError`.
- The keeper logs `ALERT keeper balance low` below 5 MON (checked every 100 blocks). Monad bills the **gas limit** (R6); every tx uses limit = estimate × 1.2.
- Evidence for a run (read-only): `OUT=… MARKET=main pnpm evidence sample` (every 60 s: best bid/ask + balances of `WATCH` addresses) and `FROM=<start block> pnpm evidence report` (max `FundingUpdated` gap from chunked `getLogs`, book two-sided/≤ 20 bps counts, MON spent).

## 4. Gas (Monad bills the limit, R6)
Keeper txs: limit = own estimate × 1.2. MM re-quotes are **pipelined** (one burst, consecutive nonces, receipts awaited together: 6 levels in 1 block instead of 6); every tx of a burst gets the burst's **max** estimate × 1.2 because later txs run on state changed by earlier ones. Rehearsal: limit 331,910 vs 122–184k used ⇒ up to ~2.5× the billed gas on re-quotes. Tuning item for mainnet: per-tx estimate × 1.5, or estimate against `pending` where the RPC supports it.

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
