# contracts/script

| Script | Chain | What it does |
|---|---|---|
| `DeployLocal.s.sol` | anvil 31337 | Real OrderBook + ClearingHouse + InsuranceFund + MarketFactory with MATH_SPEC defaults (`config/31337.json`); mocks for the oracle (`MockOracleAdapter`, MON = 0.029, settable), tAUSD (6 dp), WMON, vault, hedger. Writes `deployments/31337.json`. |
| `SmokeLocal.s.sol` | anvil 31337 | Shared end-to-end scenario: 3 funded accounts, 3 bids + 3 asks, a ~4.85x long crosses, oracle −15%, maker requotes; `liquidate()` (a later block) liquidates the long. |
| `DeployMeridian.s.sol` | 10143 / 143 | Testnet/mainnet deploy (`config/10143.json` has the verified testnet addresses). `DEPLOY_VAULT=1 DEPLOY_SWAPS=1 SWAP_MATURITY_IN_SEC=…` add the yield layers; `DEPLOYMENTS_OUT=anvil-10143.json` writes a local rehearsal elsewhere than the real `deployments/10143.json`. |
| `SmokeFull.s.sol` | local anvil (31337, or 10143 + `LOCAL_REHEARSAL=1`) | Full-stack rehearsal: seed, taker skew, premium book, swap fill, vault deposit; `push()`, `report()`, `skewDrop()`, `crashSetup()`, `crash()`, `liquidate()`. |
| `CrashDemo.s.sol` | fork simulation only (refuses broadcast) | DEMO_SCRIPT crash: ≈ 4.9x trader, vault hedged, −15% in one update, 20-block CSV (`bench-out/crash_demo_<chain>.csv`: index, mark, NAV, share price, swap markApr, IF, trader). |

## Local end to end
```bash
anvil --code-size-limit 131072 &          # Monad allows 128 KB code (ARCHITECTURE R7); ClearingHouse is ~25.9 KB
cd contracts
F="--fork-url http://localhost:8545 --broadcast --code-size-limit 131072 --gas-estimate-multiplier 200"
forge script script/DeployLocal.s.sol $=F   # zsh; in bash use $F
forge script script/SmokeLocal.s.sol  $=F   # steps 1–5 (leaves a liquidatable 5x long)
forge script script/SmokeLocal.s.sol  $=F --sig "liquidate()"   # step 6, OR let the keeper liquidate it
```
- `--code-size-limit 131072`: forge's own EIP-170 check otherwise stops at an interactive prompt.
- `--gas-estimate-multiplier 200`: the script simulates everything in one block, so it under-estimates the first
  touch of a new block (funding update + checkpoint). Keepers/bots/app estimate per tx against live state (× 1.2).
- The mark is cached once per block at the first touch (PHASES decision 2): run `liquidate()` in a later block
  than the oracle move.
- Expected `liquidate()` output: mark ≈ 0.024657, long equity ≈ 16.33 < maintenance ≈ 24.66, 10,000 MON moved,
  IF +1.232864 tAUSD, longOI = shortOI = 10,000 MON.

## Full-stack local rehearsal (Phase 4 step 4; dress rehearsal for the testnet run and CP2)
```bash
anvil --chain-id 10143 --block-time 1 --code-size-limit 131072 --prune-history 1000 --port 8546 &
cd contracts
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil dev keys only
export DEPLOYMENTS_OUT=anvil-10143.json LOCAL_REHEARSAL=1
DEPLOYER_PK=$K0 KEEPER_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 MM_ADDRESS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC \
  DEPLOY_VAULT=1 DEPLOY_SWAPS=1 SWAP_MATURITY_IN_SEC=3600 forge script script/DeployMeridian.s.sol --rpc-url http://127.0.0.1:8546 \
  --broadcast --code-size-limit 131072 --with-gas-price 102gwei --priority-gas-price 2gwei --gas-estimate-multiplier 115 --slow
git checkout -- broadcast/DeployMeridian.s.sol/10143/run-latest.json      # that file is the REAL testnet record
F="--rpc-url http://127.0.0.1:8546 --broadcast --code-size-limit 131072 --gas-estimate-multiplier 200 --slow"
forge script script/SmokeFull.s.sol $=F                                # seed (zsh: $=F; bash: $F)
BLOCKS=97000 bash script/local/mine8h.sh                           # 8 h of per-block funding history (see below)
forge script script/SmokeFull.s.sol $=F --sig "report()"               # realized 8 h APR > 15.6% ⇒ needsRebalance = Deploy
# keeper (vault + swap duties) and MMs (perp + swap), each with its own key:
(cd ../keepers/ts-fallback && CHAIN_ID=10143 RPC_URL=http://127.0.0.1:8546 KEEPER_PK=<anvil #1> DEPLOYMENTS=../../deployments/anvil-10143.json \
   HEALTH_PORT=8797 ORACLE_KIND=mock VAULT_REBALANCE=1 pnpm start)
(cd ../mm-bot && CHAIN_ID=10143 RPC_URL=http://127.0.0.1:8546 MM_PK=<anvil #2> DEPLOYMENTS=../deployments/anvil-10143.json MARKET=swap LEVELS=2 LOTS_PER_LEVEL=3 pnpm start)
forge script script/SmokeFull.s.sol $=F --sig "skewDrop()"             # taker halves its long ⇒ SkewCap ⇒ keeper trims the hedge
forge script script/CrashDemo.s.sol --fork-url http://127.0.0.1:8546   # crash simulation on a fork of this chain → bench-out CSV
cast rpc -r http://127.0.0.1:8546 evm_increaseTime 3700                # past the 1-hour swap maturity ⇒ keeper settleMaturity
```
- The 8 h history loop pushes the (deployer-fed) price, pokes `updateFunding()` and mines 198 blocks with a frozen timestamp (`anvil_mine 198 0`), so the keeper-fed oracle stays fresh and a checkpoint lands in (almost) every 200-block bucket. The seed leaves the MM's book mid one tick above the index, a persistent premium that lifts funding above the 10.95% floor so the vault's entry rule (8 h APR > ≈ 15.6%) can pass.
- `ORACLE_KIND=mock` keeps the keeper from overwriting the scripted price with live mainnet Pyth. On testnet the keeper feeds the oracle itself.

## Adding the yield layers to a live deployment (`REUSE_DEPLOYMENT`, Phase 4 step 7)
```bash
# testnet: vault + swaps against the EXISTING perp in deployments/10143.json (owner = deployer); dry-run on a fork first
export KEEPER_ADDRESS=<keeper> MM_ADDRESS=<mm>          # vault keeper + skew provider
F="--code-size-limit 131072 --with-gas-price 102gwei --priority-gas-price 2gwei --gas-estimate-multiplier 115 --slow"
REUSE_DEPLOYMENT=10143.json DEPLOY_VAULT=1 DEPLOY_SWAPS=1 SWAP_MATURITY_IN_SEC=3600 DEPLOYMENTS_OUT=dry-run-reuse-10143.json \
  forge script script/DeployMeridian.s.sol --fork-url $MONAD_TESTNET_RPC_URL $=F          # simulation only
REUSE_DEPLOYMENT=10143.json DEPLOY_VAULT=1 DEPLOY_SWAPS=1 SWAP_MATURITY_IN_SEC=3600 \
  forge script script/DeployMeridian.s.sol --rpc-url $MONAD_TESTNET_RPC_URL --broadcast $=F
```
- The perp, demo market, IF and factory addresses are taken from the record; vault/swap entries are kept unless `DEPLOY_VAULT`/`DEPLOY_SWAPS` redeploy them. `startBlock` stays; `yieldLayersBlock` records the new section's block.
- **Forge writes the deployments JSON during the simulation, before the broadcast.** If the broadcast fails (30 Sep rehearsal: an "EOA nonce changed" clash with another process using the deployer key), the file lists addresses with no code. After every broadcast, check `cast code` at each new address before committing the record, and never share the deployer key with a running process.

## Mainnet (143): configuration, hand-over and wiring (Phase 5 A5)
**Config** `config/143.json`, status 30 Sep. Every value has a source in ARCHITECTURE §0/§Research or MATH_SPEC.

| Key | Value | Status |
|---|---|---|
| `owner` | the Safe 2-of-3 | ⏳ **launch blocker**: B creates it. A verifies on 143 (`cast call <safe> "getThreshold()(uint256)"` = 2, `getOwners()` = the 3 founders) before writing it |
| `params.oracle.kind` | `"pyth"` (PythChainlinkOracleAdapter, Chainlink guard) | ✅ structural, added by A (DeployMeridian reads it; the file had no key) |
| `params.oracle.maxDeviationWad` | B chooses | ⏳ **launch blocker**: null fails the adapter's constructor bounds (0, 10%] |
| `params.oracle.maxStalenessSec` | 10 (with the Pyth API key) / 60 (without) | ⏳ B confirms once the key is in hand |
| `params.vault.depositCap` | `"1200000000"` = 1,200 AUSD | ✅ PHASES decision 12. Falls back to 1,000 AUSD if review A-04 isn't fixed by Mon 5 Oct |
| `params.swap.maturity` / `maturityInSec` | null / 2,592,000 | ✅ DeployMeridian sets maturity = the listing block's time + 30 d (MATH_SPEC §6.1). `SWAP_MATURITY_IN_SEC` overrides it (test maturities only) |
| `kuru.monAusdMarket` | dead book (R19) | ⚠️ review **A-01 (High)**: withdrawals beyond idle and forced exits use this direct route. **Idle launch (PHASES 17):** `vault.skewCapacity = 0` in `143.json` ⇒ hedge target 0, no keeper call can hedge, every redemption is served from idle (`MeridianVaultIdleLaunch.t.sol`). After CR-010 the Safe raises it to 0.8e18 with `setVaultParams`. Ops: set `NEXT_PUBLIC_VAULT_ROUTE_PENDING=1` on the mainnet app build |
| `foundry.toml` `evm_version = cancun` | — | ⏳ > VERIFY before mainnet (Monad docs) |

**What the script refuses on 143** (proved by `test/fork/DeployMeridianMainnet.t.sol` against a mainnet fork; runs with `MONAD_RPC_URL`, skips without): owner missing or = deployer; tAUSD (`tokens.AUSD` null); a demo market; MockKuruHedger (`kuru.flowEntrypoint` null); a keeper-fed oracle (TestnetKeeperOracle's constructor); a vault without `KEEPER_ADDRESS` + `MM_ADDRESS`, or with either equal to the deployer. A code guard (untestable without a real broadcast) also refuses `DEPLOY_CONFIG` in a mainnet broadcast.

**Hand-over.** Every Ownable contract (InsuranceFund, MarketFactory, oracle adapter, ClearingHouse, FundingSwapMarket, MeridianVault, KuruHedger) is plain `Ownable`: `transferOwnership(safe)` takes effect immediately, so **no Safe accept transaction exists and no Safe batch is needed for the hand-over**. The script asserts `owner() == safe` for each one and that the deployer is not a vault keeper. The OrderBooks have no owner. After the run, the deployer holds **no role** on any contract (fork test).

**Wiring, in execution order** (all inside `DeployMeridian --broadcast`, signed by the deployer before the hand-over):
1. `InsuranceFund(deployer)`, `MarketFactory(deployer)`
2. `PythChainlinkOracleAdapter(deployer, pyth, MON/USD id, chainlink MON/USD, maxStaleness, maxDeviation, 3600 s)`
3. `ClearingHouse(AUSD, oracle, IF, risk, funding, deployer)` → `OrderBook(CH, tick, lot)` → `CH.setOrderBook(OB)` (one-shot)
4. `IF.setMarketAuthorized(CH, true)`, `MarketFactory.registerMarket("MON-PERP", OB, CH, oracle, WMON)`
5. `KuruHedger(deployer, WMON, AUSD, flowEntrypoint, monAusdMarket)` → `MeridianVault(AUSD, CH, OB, hedger, vault params, deployer)` → `hedger.setVault(vault)` (one-shot) → `vault.setKeeper(KEEPER_ADDRESS)` → `vault.setSkewProvider(MM_ADDRESS)` (MATH_SPEC §5.2 amendment)
6. `FundingSwapMarket(CH, AUSD, IF, now + 30 d, swap params, deployer)` → `OrderBook(swap, 1e14, 1,000 MON)` → `swap.setOrderBook` (one-shot) → `IF.setMarketAuthorized(swap, true)`
7. `transferOwnership(safe)` × 7, with asserts

**After the hand-over (Safe, as needed; none is required to go live):** `CH.setPaused` / `FundingSwapMarket.setPaused` (incident), `CH.setRiskParams` + `vault.setVaultParams` (raise the caps together, decision 12), `vault.setKeeper(k, false)` (revoke a leaked keeper: review A-09), `CH.collectFees(to)` / `swap.collectFees(to)`, `adapter.setOracleParams`. **Permissionless seeding:** `InsuranceFund.fund(amount)` (anyone), MM `CH.deposit`, vault `deposit`, swap margin.

```bash
# mainnet-fork check of the whole config (no broadcast); needs MONAD_RPC_URL
cd contracts && forge test --match-path test/fork/DeployMeridianMainnet.t.sol -vv
```

## Mainnet-fork rehearsal (Phase 3 P2; no public broadcast)
Everything below broadcasts **only to a local anvil fork** of 143. Each tool refuses a non-localhost URL or a node that does not answer `anvil_nodeInfo`.
```bash
anvil --fork-url $MONAD_RPC_URL --fork-block-number <N> --host 127.0.0.1 --port 8545 --code-size-limit 131072 &
# anvil dev accounts carry mainnet EIP-7702 delegations (sweepers): clear them on the fork only
for a in <dev #0..#9>; do cast rpc anvil_setCode $a 0x --rpc-url http://127.0.0.1:8545; done
(cd ../keepers/ts-fallback && FORK_RPC_URL=http://127.0.0.1:8545 pnpm fork-pyth-relay &)  # real signed mainnet Pyth updates
bash script/fork/rehearse-143.sh                         # DeployMeridian, owner = FORK STAND-IN (dev #9) → deployments/dry-run/143-fork.json
DEPLOYMENTS_FILE=dry-run/143-fork.json EXPECTED_OWNER=<stand-in> DEPLOYER_ADDRESS=<dev #0> KEEPER_ADDRESS=<dev #1> MM_ADDRESS=<dev #2> \
  forge script script/VerifyDeployment.s.sol --rpc-url http://127.0.0.1:8545      # read-only, 52 checks (6 Oct)
# fund dev accounts with AUSD by impersonating a holder (fork only), then:
forge script script/fork/SmokeFork143.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --slow --gas-estimate-multiplier 200
forge script script/fork/SmokeFork143.s.sol --sig "skipDemo()" --rpc-url http://127.0.0.1:8545 --broadcast --slow   # CR-007 on the fork
```
- **Hardening checks (P4.4, 6 Oct).** `VerifyDeployment` also checks the P2 mark premium bound (a +10% book moves the deployed CH's mark +10 bps in one block and +2% after a 1,000-block gap) and CR-007 (`MakerFillSkipped` in every book's bytecode; a paused CH / swap market answers Skip). Both run on the deployed bytecode in the script's local simulation (`vm.mockCall`, `vm.prank`, state snapshot reverted), never on chain. Against the pre-hardening 10143 deployment all 10 of these FAIL. Testnet mode: owner = deployer when the config says `ownerIsDeployer` (never on 143), keeper-fed oracle + demo market checks, vault/swaps optional, `FRESH_ORACLE_OPTIONAL=1` before the keeper runs.
- **AUSD on the fork:** no holder is hard-coded; pick one from recent `Transfer` logs (`cast logs … 'Transfer(address,address,uint256)'`, then `balanceOf`), `anvil_impersonateAccount` + `anvil_setBalance` it, `cast send --unlocked` to the dev accounts (fork only). 6 Oct: `0xd5b7…615b` (15,841 AUSD at block 111,084,897).
- **Gas multiplier:** forge simulates the whole deploy in one EVM session, so later one-shot setters are under-estimated. At ×1.20, `CH.setOrderBook` ran out of gas (limit 51,228) on the fork. ×2.00 passed (24 txs, 55.1 M gas limit, anvil-fork estimate). Monad bills the limit, so ×2 costs ≈ 2.8 MON more at 102 gwei than ×1. Use the same multiplier on mainnet day.
- `VerifyDeployment.s.sol` is chain-agnostic and read-only. Use it on 143 after the real broadcast with `DEPLOYMENTS_FILE=143.json EXPECTED_OWNER=<Safe>`.
- `deployments/dry-run/143-fork.json` carries `"fork": true` and a `_label`. Consumers must never treat it as a mainnet record.
