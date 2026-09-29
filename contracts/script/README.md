# contracts/script

| Script | Chain | What it does |
|---|---|---|
| `DeployLocal.s.sol` | anvil 31337 | Real OrderBook + ClearingHouse + InsuranceFund + MarketFactory with MATH_SPEC defaults (`config/31337.json`); mocks for the oracle (`MockOracleAdapter`, MON = 0.029, settable), tAUSD (6 dp), WMON, vault, hedger. Writes `deployments/31337.json`. |
| `SmokeLocal.s.sol` | anvil 31337 | Shared end-to-end scenario: 3 funded accounts, 3 bids + 3 asks, a ~4.85x long crosses, oracle −15%, maker requotes; `liquidate()` (a later block) liquidates the long. |
| `DeployPulse.s.sol` | 10143 / 143 | Testnet/mainnet deploy (Phase 3; `config/10143.json` has the verified testnet addresses). |

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
