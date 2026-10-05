# MAINNET DAY: Thu 8 Oct 2026 (Meridian on Monad 143)

The run sheet a second engineer can follow alone. Every command was rehearsed on a **mainnet fork @ block 110,560,579** (anvil, chain id 143, 5 Oct; `docs/standup/PHASE3_LOOP.md` P2–P5). The "expected" outputs come from that fork, and **fork addresses will differ on 143**. Gas and MON numbers are **anvil-fork estimates, not Monad-metered**. Nothing here was broadcast to 143 or 10143.

Roles: **A** = deployer (runs the broadcast) · **B** = ops (keeper, MMs, watcher, seeding) · **C** = app + indexer (Phase 2 lane) · **Safe** = any 2 of the 3 founders.
All times are local, Thu 8 Oct. Contract code freeze: **18:00**.

---

## 0. Go / no-go (A reads it out at 09:30; every line must be ✅ or the launch moves to Sat 10 Oct, WIN_PLAN §3)

| # | Gate | Check (command or evidence) | Owner |
|---|---|---|---|
| H3 | Safe 2-of-3 on 143 exists | `cast call $SAFE "getThreshold()(uint256)"` = 2, `getOwners()` = the 3 founders (the preflight does both) | B |
| H4 | Mainnet hot keys: deployer, keeper, perp MM, swap MM (4 distinct, never the anvil dev keys: they carry 7702 delegations on 143) | addresses written in the go/no-go thread; preflight checks they're distinct | B |
| H5 | Paid RPC, one endpoint per process | each process's env file has its own `RPC_URL`; `cast chain-id` = 143 | B |
| H6 | Pyth Hermes key (optional) | without it: sponsored pushes only, `maxStalenessSec` stays 60 (config); `oracle_old` warns are expected | B |
| H8 | Capital in wallets | deployer ≥ **12 MON** (preflight); keeper ≥ 12 h × ≈ 6 MON/h; perp MM ≥ 12 h × ≈ 25 MON/h; swap MM ≥ 12 h × ≈ 50 MON/h (RUNBOOK §4 projections; re-measure in hour 1); AUSD: IF 1–2k, keeper ≥ 500 (perp) + 200 (swap), perp MM ≥ 3k, swap MM ≥ 800, vault ≤ 1,200 | founders |
| H16 | ToS + jurisdiction list signed by all three | sign-off recorded in `docs/standup/C.md`; `/terms` DRAFT banner gone | all |
| H17 | Explorer verifier | sourced from docs.monad.xyz (fetched 5 Oct, §3 below). A verifies **one** contract right after the deploy before batching | A |
| H18 | Owner's "go" | said explicitly in A's session at 10:00 | owner |
| P | `config/143.json` audited, owner = Safe written in | `docs/outputs/MAINNET_CONFIG_AUDIT.md`; `forge test --match-path test/script/Config143.t.sol` 11/11 | A |
| P | Fork rehearsal green | `VerifyDeployment` 44/44 and smoke OK on the fork (PHASE3_LOOP P2) | A |
| P | Launch decisions taken | F-1 gas ×200 · F-3/F-4 the MM starts **flat** and `MAX_INVENTORY_LOTS` < 250 · F-5 swap MM `REQUOTE_BPS=1000 TICK_EVERY_BLOCKS=33 LEVELS=1` · A-01 vault **idle** (decision 17) · any `fix/*` branch merged or explicitly deferred | owner |
| P | `main` green | `forge test` + invariants CI profile, keepers / mm-bot / bench vitest + tsc | A |

**No-go triggers:** a missing Safe (H3) or deployer MON (H8); the preflight refusing for any reason; a red test on `main`.

---

## 1. Timeline

| Time | Who | Step | § |
|---|---|---|---|
| 08:00 | A | Pull reviewed `main`; write the Safe address into `config/143.json` `owner`; commit; record `shasum -a 256 contracts/script/config/143.json` as `EXPECTED_CONFIG_SHA256` in the thread | 2.1 |
| 08:30 | B | Each process gets its own env file from `keepers/143.env.example` (values from the secret store) | RUNBOOK §1 |
| 09:00 | A | `forge test` (no regressions); **preflight** | 2.2 |
| 09:30 | all | Go / no-go (§0) | 0 |
| 10:00 | owner | "go" | — |
| 10:00 | A | `cast base-fee`; **broadcast DeployPulse** | 2.3 |
| 10:15 | A | `cast code` at every address; **VerifyDeployment** (44 checks); commit `deployments/143.json` + the broadcast record | 2.4, 2.5 |
| 10:30 | A | Explorer verification: one contract first, then the batch | 3 |
| 10:45 | A → C | **Hand-off** (§7): C runs `sync-mainnet` / `gen-config 143`, deploys app + indexer | 7 |
| 11:00 | B | **Seed**: IF, keeper (perp + swap), perp MM, swap MM, vault (≤ 1,200) | 4 |
| 11:30 | B | Start keeper → perp MM → swap MM → (≥ 30 s) → watcher; first `/health` | 5 |
| 12:00 | A + B | **Smoke on 143 with tiny size** | 6 |
| 12:30 | B | `pnpm tx-cost` over the first hour → set balance floors | 5 |
| 14:00 | founders | First trades (excluded from user counts) | — |
| 15:00 | all | Outreach wave 1 | — |
| **18:00** | A | **Contract code freeze** (§9) | 9 |

---

## 2. Deploy

### 2.1 Config (08:00)
```bash
cd contracts
jq --arg o "$SAFE" '.owner = $o' script/config/143.json > /tmp/143.json && mv /tmp/143.json script/config/143.json
jq 'del(._owner)' script/config/143.json > /tmp/143.json && mv /tmp/143.json script/config/143.json   # the VERIFY note is resolved
forge test --match-path test/script/Config143.t.sol      # expected: 11 passed (owner set ⇒ the non-null branch)
git commit -am "chore(ws-00): 143.json owner = Safe <addr>"; shasum -a 256 script/config/143.json   # → EXPECTED_CONFIG_SHA256
```

### 2.2 Preflight (09:00): refuses unless everything matches
```bash
RPC_URL=<A's paid 143 endpoint> DEPLOYER_ADDRESS=<deployer> SAFE_ADDRESS=<Safe> SAFE_OWNERS=<a>,<b>,<c> \
KEEPER_ADDRESS=<keeper> MM_ADDRESS=<perp MM> EXPECTED_CONFIG_SHA256=<hash from 2.1> bash script/preflight-143.sh
```
Expected: `PASS` lines for chain id 143, "RPC is not an anvil fork", config sha256, 10 config invariants, Safe code / threshold 2 / 3 owners (= `SAFE_OWNERS`), roles distinct, deployer ≥ 12 MON, no existing record → **`PREFLIGHT OK`**. On the fork (stand-in owner): 16 PASS + Safe checks SKIPPED (EOA stand-in). It refused all 7 deliberately wrong setups (`script/fork/test-preflight.sh`).

### 2.3 Broadcast (10:00, after "go")
```bash
cast base-fee --rpc-url $RPC_URL          # 4–5 Oct: 100 gwei; gas price 102 gwei. If it moved, adjust --with-gas-price
DEPLOYER_PK=<from the secret store, this shell only> KEEPER_ADDRESS=<keeper> MM_ADDRESS=<perp MM> \
DEPLOY_VAULT=1 DEPLOY_SWAPS=1 SWAP_MATURITY_IN_SEC=0 DEPLOY_CONFIG= REUSE_DEPLOYMENT= DEPLOY_CRE_RECEIVER=false \
  forge script script/DeployPulse.s.sol --rpc-url $RPC_URL --broadcast --slow --code-size-limit 131072 \
  --gas-estimate-multiplier 200 --with-gas-price 102gwei --priority-gas-price 2gwei
```
- **`--gas-estimate-multiplier 200` (F-1):** at ×120, tx 6 `ClearingHouse.setOrderBook` ran out of gas on the fork. ×200 passed. Cost: 55.1 M gas limit ≈ **5.6 MON** at 102 gwei (Monad bills the limit); ×1 would be ≈ 2.8 MON.
- **Expected output (fork):** "Estimated total gas used for script: 55062918" (a similar figure), 24 transactions (5 creates for the perp: IF, factory, oracle adapter, CH, OB; then `setOrderBook`, `setMarketAuthorized`, `registerMarket`, `KuruHedger`, `PulseVault`, `setVault`, `setKeeper`, `setSkewProvider`, `FundingSwapMarket`, swap `OrderBook`, swap `setOrderBook`, `setMarketAuthorized`, 7 × `transferOwnership`), **`ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`**, logs `deployer / owner <deployer> <Safe>`, `ClearingHouse runtime bytes 26470`. Per-tx gas: `bench/out/deploy_gas_143fork.csv`.
- **If the script stops midway:** the hand-over is the last step, so the deployer still owns whatever got created. **Don't reuse a partial deployment.** Fix the cause, re-run the preflight (it only checks `deployments/143.json`, which forge already wrote during the simulation, so move that file aside first: `mv ../deployments/143.json ../deployments/143.partial.json`) and broadcast again. Fresh addresses come from the next nonce.

### 2.4 Check every address, then verify (10:15)
```bash
for a in $(jq -r '.contracts[]' ../deployments/143.json); do echo "$a $(cast code $a --rpc-url $RPC_URL | wc -c)"; done   # all > 3
DEPLOYMENTS_FILE=143.json EXPECTED_OWNER=<Safe> DEPLOYER_ADDRESS=<deployer> KEEPER_ADDRESS=<keeper> MM_ADDRESS=<perp MM> \
  forge script script/VerifyDeployment.s.sol --rpc-url $RPC_URL     # read-only; refuses --broadcast
```
Expected (fork): **`checks passed / failed 44 0`**. Ownership × 7 = Safe; the OrderBooks have code (no owner); the deployer isn't a keeper; the keeper is a vault keeper; the MM is skew provider #0 (exactly one); `hedger.vault() == vault`; CH↔OB, swap↔OB, IF authorises both, factory registry, CH not paused; Risk / Funding / Vault / Swap params == config (all fields); depositCap 1,200 AUSD; skewCapacity 0, shortCapacity 0, needsRebalance None; maturity = deploy time + 30 d; mark bound 0.5 pt; oracle params / Pyth / feed id / Chainlink guard == config; **a fresh live price** (fork: 0.03388 USD, age 0 s). Any FAIL → §8.

### 2.5 Record (10:20)
```bash
git add deployments/143.json contracts/broadcast/DeployPulse.s.sol/143/run-latest.json
git commit -m "feat(ws-00): Meridian live on Monad 143 (DeployPulse, owner = Safe <addr>)"
```
`deployments/143.json` is what C and the bots read. Never hand-edit it. Never commit `contracts/cache/` (forge's "sensitive values" file).

---

## 3. Explorer verification (10:30)
Source: docs.monad.xyz "Verify a smart contract → Foundry", fetched 5 Oct 2026 (H17). MonadVision is Sourcify-based and needs no API key; Monadscan uses the Etherscan verifier and needs a key (> VERIFY: whether we have one).
```bash
# one contract first (H17 acceptance), then the rest; --guess-constructor-args reads the creation tx from the RPC
forge verify-contract <InsuranceFund addr> src/clearing/InsuranceFund.sol:InsuranceFund --chain 143 \
  --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/ --rpc-url $RPC_URL --guess-constructor-args
```
| key in 143.json | contract path:name |
|---|---|
| InsuranceFund | `src/clearing/InsuranceFund.sol:InsuranceFund` |
| MarketFactory | `src/clearing/MarketFactory.sol:MarketFactory` |
| OracleAdapter | `src/oracle/PythChainlinkOracleAdapter.sol:PythChainlinkOracleAdapter` |
| ClearingHouse | `src/clearing/ClearingHouse.sol:ClearingHouse` |
| OrderBook, SwapOrderBook | `src/orderbook/OrderBook.sol:OrderBook` |
| KuruHedger | `src/vault/KuruHedger.sol:KuruHedger` |
| PulseVault | `src/vault/PulseVault.sol:PulseVault` |
| FundingSwapMarket | `src/swaps/FundingSwapMarket.sol:FundingSwapMarket` |
Not rehearsed: Sourcify can't verify a local fork. If `--guess-constructor-args` fails, pass `--constructor-args $(cast abi-encode …)` built from `transactions[i].arguments` in the broadcast record. Verification is cosmetic; it never blocks seeding.

---

## 4. Seed (11:00): RUNBOOK §10b, each line from the key named
Exact `cast` lines are in `keepers/RUNBOOK.md` §10b (rehearsed on the fork). Approve **exact** amounts, gas limit = estimate × 1.2.
| Seed | Call | Fork result |
|---|---|---|
| Insurance fund | `IF.fund(amt)` (any key) | `IF.balance()` 1,500 AUSD |
| Keeper, perp | `CH.deposit(amt)` (keeper) | 500 AUSD |
| Keeper, swap | `swap.deposit(amt)` (keeper), or `depositFor(keeper, amt)` from any key | 200 AUSD |
| Perp MM | `CH.deposit(amt)` (perp MM). **Start flat**: no inventory (F-3/F-4) | 3,000 AUSD |
| Swap MM | `swap.deposit(amt)` (swap MM) | 800 AUSD |
| Vault (idle) | `vault.deposit(amt, receiver)`, total ≤ 1,200 | 1,000 AUSD, `maxDeposit` 200 left |

---

## 5. Start the bots (11:30): RUNBOOK §2, §8
Order: **keeper → perp MM → swap MM → wait ≥ 30 s → watcher** (a watcher started in the same second pages `keeper_stalled` then RESOLVED). Each runs with `env -i PATH="$PATH" HOME="$HOME"` plus its own env file. Launch values (RUNBOOK §1, §4):
- keeper: `VAULT_REBALANCE=1` (idle ⇒ sends nothing), `SWAP_MARK_POKE_EVERY_BLOCKS=20`, `HEALTH_PORT=8797`;
- perp MM: defaults (3 levels, `MAX_INVENTORY_LOTS=200` < 250);
- swap MM: `MARKET=swap REQUOTE_BPS=1000 TICK_EVERY_BLOCKS=33 LEVELS=1` (defaults cost ≈ 441 MON/h on the fork; decision D13). Env file from `keepers/143.swap-mm.env.example` (values filled). The MM **refuses to start** with `REQUOTE_BPS` < 1000 for `MARKET=swap` on 143 unless `ALLOW_HIGH_BURN=1` (never set it on mainnet day);
- watcher: the real channel (`PAGE_DISCORD_WEBHOOK_URL` or Telegram), **never** `PAGE_LOCAL_WEBHOOK_URL`.

Expected (fork, 22 min): keeper `/health` `ok: true`, `maxFundingGapBlocks` ≤ 20 (fork: 19), `errors` 0; MM `quoted` lines two-sided, `errors` 0; watcher `OK block N` every 15 s. Right after launch the swap MM may quote **nothing** while the perp's current rate × YEAR is ≤ −100% APR. `mm_empty` (swap) is expected then and resolves by itself.
At 12:30: `ADDRS=keeper=…,mm-perp=…,mm-swap=… GAS_PRICE_GWEI=<cast gas-price> FROM_BLOCK=<start> pnpm tx-cost` (read-only) → set the `WATCH_BALANCES` floors to MON/h × 12 h.

---

## 6. Smoke on 143, tiny size (12:00; a founder wallet, excluded from user counts)
| Step | Call | Expected |
|---|---|---|
| 1 | approve + `CH.deposit(5e6)` (5 AUSD) | `collateralOf` = 5e18 |
| 2 | `OB.placeMarketOrder(true, 1, <best ask + 5 ticks>, 1, false)` (1 lot = 100 MON ≈ $3.4) | position +100 MON, `Trade` event, the MM requotes |
| 3 | wait ≥ 1 block; `CH.getAccount(me)` | `pendingFunding` moves every block (per-block funding live) |
| 4 | `OB.placeMarketOrder(false, 1, 1, 1, true)` (reduce-only close) | size 0 |
| 5 | `CH.withdraw(<collateral in token units>)` | AUSD back minus fees |
| 6 | approve + `vault.deposit(1e6, me)` then `vault.redeem(shares, me, me)` | 1 AUSD in and out (idle vault serves from idle) |
| 7 | app on 143 shows the trade, the funding ticker, Earn "Waiting for route" (skewCapacity 0) | C confirms |
The swap market smoke is optional (1 lot = 1,000 MON notional ≈ $34). If run: `swap.deposit(10e6)`, 1 lot at the MM's ask, close reduce-only.

---

## 7. Hand-off to lane C (10:45): what the app and the indexer need
C's own scripts read the record. **Nothing is copied by hand.**
- **Record:** `deployments/143.json` on `main` (2.5). Keys: `chainId` 143, `startBlock`, `owner` (Safe), `symbol` "MON-PERP", `oracleKind` "pyth", `mockContracts` [], and `contracts.{AUSD, WMON, InsuranceFund, MarketFactory, OracleAdapter, ClearingHouse, OrderBook, KuruHedger, PulseVault, FundingSwapMarket, SwapOrderBook}`.
- **App:** `node app/scripts/sync-mainnet.mjs` bundles it into `src/config/mainnet.generated.ts` (it uses `ClearingHouse, OrderBook, FundingSwapMarket, SwapOrderBook, PulseVault`). Env: `NEXT_PUBLIC_CHAIN_ID=143`, `NEXT_PUBLIC_MONAD_RPC_URL` (**a public, keyless RPC only**: never a paid key in `NEXT_PUBLIC_*`), `NEXT_PUBLIC_INDEXER_URL` (mainnet indexer), `NEXT_PUBLIC_DATA_SOURCE`, `NEXT_PUBLIC_LOG_SPAN=100` (public RPC cap, R2), `NEXT_PUBLIC_LOG_LOOKBACK`; leave `NEXT_PUBLIC_VAULT_ROUTE_PENDING` unset (the chain says skewCapacity 0); never `NEXT_PUBLIC_DEPLOYMENT_OVERRIDE` / `LOCAL_*` on 143. Server-side: `GEO_COUNTRY_HEADER` (> VERIFY per host), `GEO_BLOCKED_COUNTRIES` (H16), `GEO_BLOCK_MODE`.
- **Indexer:** `node indexer/scripts/gen-config.mjs 143` → `config.mainnet.yaml` (HyperSync `https://143.hypersync.xyz`, R20; `start_block` = `startBlock`; every contract key above that has events). `ENVIO_API_TOKEN` for hosted.
- **Do not** point anything at `deployments/dry-run/143-fork.json`: it's a labelled fork record (`"fork": true`).

---

## 8. Abort, pause, rollback

| Situation | Action | Who signs |
|---|---|---|
| Preflight refuses / no-go | Don't broadcast. Fix, or move to Sat 10 Oct | A |
| Deploy stops midway | §2.3: abandon the partial set (the deployer still owns it; nothing is live for users), re-preflight, redeploy | A |
| `VerifyDeployment` FAIL on ownership / params | **Don't seed, don't hand off.** Wrong owner: if the deployer still owns it, `transferOwnership(Safe)`; if a wrong address owns it, abandon and redeploy (non-upgradeable) | A |
| Oracle wrong / stale, exploit suspected, depeg (`ausd_depeg`) | `touch $KILL_FILE` on every MM; Safe: `ClearingHouse.setPaused(true)` + `FundingSwapMarket.setPaused(true)`. Keep the keeper running (liquidations work while paused) | **Safe 2-of-3** |
| Exposure must shrink | Safe: `setRiskParams` with lower `maxOpenInterest` / `maxPositionSize` | Safe |
| Keeper key leaked / misbehaving vault keeper | Safe: `PulseVault.setKeeper(<keeper>, false)`; rotate the bot key; `setKeeper(<new>, true)` | Safe |
| Resume | Cause fixed and the oracle fresh → `setPaused(false)`, `rm $KILL_FILE`, watch for 30 min | Safe |
| "Rollback" | Contracts are non-upgradeable (ARCHITECTURE §6): pause → reduce-only → users close/withdraw → deploy v2 markets → C points the app at v2 | Safe + A |

Pause rehearsed on the fork (stand-in owner): `setPaused(true)` makes a new order revert `Paused()` (`0x9e87fac8`); a reduce-only market order still reaches matching; a non-owner reverts `OwnableUnauthorizedAccount` (`0x118cdaa7`); `setPaused(false)` restores trading.

**Safe transactions (none is needed to go live; the hand-over is inside DeployPulse).** Build them in the Safe UI's transaction builder from these rows. A Safe Transaction Builder JSON isn't provided: its format wasn't verified from Safe's docs.
| Purpose | Target (143.json key) | Function | Args |
|---|---|---|---|
| Pause perp | ClearingHouse | `setPaused(bool)` | `true` (resume: `false`) |
| Pause swaps | FundingSwapMarket | `setPaused(bool)` | `true` / `false` |
| Caps (raise together, decision 12) | ClearingHouse | `setRiskParams((uint256,uint256,uint256,int256,uint256,uint256,uint256,uint256))` | `(imr, mmr, takerFee, makerFee, liqPenalty, keeperShare, maxOpenInterest, maxPositionSize)`, current values from `riskParams()`, only the caps changed |
| Vault cap / enable hedging after CR-010 | PulseVault | `setVaultParams((uint256,…))` (12 fields, `VaultParams`) | current `vaultParams()` with `depositCap` or `skewCapacity` (0.8e18) changed |
| Second MM key (F-3) | PulseVault | `setSkewProvider(address,bool)` | `(<MM2>, true)` |
| Revoke a keeper (review A-09) | PulseVault | `setKeeper(address,bool)` | `(<keeper>, false)` |
| Oracle params (only with a Hermes key, B decides) | OracleAdapter | `setOracleParams(uint256,uint256)` | `(maxStalenessSec, maxDeviationWad)` |
| Collect fees | ClearingHouse / FundingSwapMarket | `collectFees(address)` | `(<treasury>)` |

---

## 9. 18:00 contract code freeze
After 18:00 no change to `contracts/src/**` and no redeploy, except for an incident that the Safe-signed actions in §8 can't contain. That needs the owner's explicit call, and it's logged in `docs/standup/A.md`. Offchain code (keeper, MM, app, indexer), params via the Safe, and docs stay open.

---

## 10. Rehearsal evidence (fork, labelled)
`deployments/dry-run/143-fork.json` · `bench/out/deploy_gas_143fork.csv` · `bench/out/crash_demo_143fork.csv` · `keepers/RUNBOOK.md` §4 (bot costs), §10b (seeding) · `docs/standup/PHASE3_LOOP.md` P2–P5.
