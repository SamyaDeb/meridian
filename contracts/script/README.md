# contracts/script

| Script | Chain | What it does |
|---|---|---|
| `DeployLocal.s.sol` | anvil 31337 | Real OrderBook + ClearingHouse + InsuranceFund + MarketFactory with MATH_SPEC defaults (`config/31337.json`); mocks for the oracle (`MockOracleAdapter`, MON = 0.029, settable), tAUSD (6 dp), WMON, vault, hedger. Writes `deployments/31337.json`. |
| `SmokeLocal.s.sol` | anvil 31337 | Shared end-to-end scenario: 3 funded accounts, 3 bids + 3 asks, a ~4.85x long crosses, oracle −15%, maker requotes; `liquidate()` (a later block) liquidates the long. |
| `DeployPulse.s.sol` | 10143 / 143 | Testnet/mainnet deploy (`config/10143.json` has the verified testnet addresses). `DEPLOY_VAULT=1 DEPLOY_SWAPS=1 SWAP_MATURITY_IN_SEC=…` add the yield layers; `DEPLOYMENTS_OUT=anvil-10143.json` writes a local rehearsal elsewhere than the real `deployments/10143.json`. |
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
  DEPLOY_VAULT=1 DEPLOY_SWAPS=1 SWAP_MATURITY_IN_SEC=3600 forge script script/DeployPulse.s.sol --rpc-url http://127.0.0.1:8546 \
  --broadcast --code-size-limit 131072 --with-gas-price 102gwei --priority-gas-price 2gwei --gas-estimate-multiplier 115 --slow
git checkout -- broadcast/DeployPulse.s.sol/10143/run-latest.json      # that file is the REAL testnet record
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
  forge script script/DeployPulse.s.sol --fork-url $MONAD_TESTNET_RPC_URL $=F          # simulation only
REUSE_DEPLOYMENT=10143.json DEPLOY_VAULT=1 DEPLOY_SWAPS=1 SWAP_MATURITY_IN_SEC=3600 \
  forge script script/DeployPulse.s.sol --rpc-url $MONAD_TESTNET_RPC_URL --broadcast $=F
```
- The perp, demo market, IF and factory addresses are taken from the record; vault/swap entries are kept unless `DEPLOY_VAULT`/`DEPLOY_SWAPS` redeploy them. `startBlock` stays; `yieldLayersBlock` records the new section's block.
- **Forge writes the deployments JSON during the simulation, before the broadcast.** If the broadcast fails (30 Sep rehearsal: an "EOA nonce changed" clash with another process using the deployer key), the file lists addresses with no code. After every broadcast, check `cast code` at each new address before committing the record, and never share the deployer key with a running process.
