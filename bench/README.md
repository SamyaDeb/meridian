# bench/ (WS-08)

Every reported number carries network, block range, commit hash and date (BENCHMARKS_PLAN).

| ID | Command | Output |
|---|---|---|
| B6 √τ chart | `pip install -r bench/requirements.txt && python3 bench/sqrt_tau.py` | `bench/out/sqrt_tau.{png,csv}`; exits 1 if the numbers drift from MATH_SPEC §3.4 |

`python3 bench/sqrt_tau.py --no-plot` needs only the stdlib (CSV + spec check).
| B1/B2 gas from receipts | `cd bench && CHAIN_ID=10143 RPC_URL=… BENCH_PK=… DEPLOYMENTS=../deployments/10143.json pnpm gas` | `bench/out/gas_onchain_<chain>_<date>.csv` (op, gasUsed, gasLimit, block, txHash, commit, date, chainId, measured block time) + a table vs `contracts/bench-out/real_engine_gas.csv` (Foundry, execution gas only; receipts add the 21k base + calldata) |
| B4 load (skeleton) | `cd bench && CHAIN_ID=… RPC_URL=… LOAD_PKS=0x…,0x… TXS=60 K=1,2 pnpm load` (`MARKETS_FILE` for K > 2) | `bench/out/load_<chain>_<date>.json`: included tx/block, landed latency p50/p95 per K. Testnet run only with a paid RPC and a MON budget |

Anvil receipts use the Ethereum gas schedule, not Monad's MIP-8 page pricing: only testnet/mainnet receipts are B1/B3 evidence. Pure helpers (`src/stats.ts`) are unit-tested (`pnpm test`).
