# BENCHMARKS_PLAN — "Why only Monad", with numbers (owner: WS-08; hooks from WS-01/02/03)

Outputs land in `bench/out/` (CSV + PNG) and a summary table in the write-up.

| ID | Metric | Method | Tooling | Target / output |
|---|---|---|---|---|
| B1 | Gas per `placeLimitOrder` (rest, new level / existing level), `cancelOrder`, `replaceOrder`, match of k fills (k = 1, 4, 16, 32), `placeMarketOrder` | `forge test --gas-report` + dedicated `test/bench/OrderBookGas.t.sol` with `vm.lastCallGas()`; MIP-8 note: Foundry does not model Monad page pricing ⇒ re-measure on testnet/mainnet with `eth_estimateGas` and receipts | Foundry, `bench/gas_onchain.ts` (viem) | Table; MM place+cancel < 100k |
| B2 | Gas of the funding update: first touch vs. later touches in the same block; idle gap n = 1, 100, 10k blocks | Bench test + mainnet receipts (compare first vs. second tx of a block) | Foundry + viem | Incremental first-touch < 30k; later ≈ SLOAD-only |
| B3 | MIP-8 storage layout effect | Same MM cycle with level-array vs. mapping layout, measured on testnet (real page pricing) | viem script | % gas saving; chart |
| B4 | Multi-market parallel load test | Deploy K = 1, 2, 4, 8 identical markets; fire M txs/block (mix: 70% place/cancel, 30% market) from W wallets at a paid RPC; measure included tx/block, gas/block, landed latency p50/p95; compare "all txs to 1 market" vs "spread over K markets" | `bench/load.ts` (viem, nonce pipelining, tight gas limits) | Chart: throughput vs K; conflict penalty ratio. VERIFY RPC rate limits (R2) and budget MON for gas |
| B5 | Funding granularity | Per-block F path vs. simulated hourly and 8 h settlement for the same premium series; show equity-jump distribution | Indexer data + Python | Chart: equity path, jump histogram |
| B6 | √τ margin chart | `mmr = z·σ·√τ` for τ ∈ [0.3 s, 8 h] (log-x), σ ∈ {50, 100, 150}%, z = 3; markers at Monad 1 block / 3 blocks / keeper 2 s / 12 s / 1 h / 8 h | `bench/sqrt_tau.py` (matplotlib) | PNG + table (MATH_SPEC §3.4 numbers) |
| B7 | Liquidation latency (realized) | Time from price move (oracle update tx) to `Liquidated` event on testnet/mainnet in the crash demo | indexer timestamps + block numbers | Blocks and ms, p50/p95 |
| B8 | End-to-end UX latency | Tap → confirmed (Privy wallet) | App instrumentation | p50 |
| B9 | Vault economics | Realized APR vs. funding, costs breakdown, basis PnL | Indexer | Chart |

Method notes:
- Report the chain block time measured during the run (MATH_SPEC §1.1).
- Every number carries: network, block range, commit hash, date.
- Charts: consistent palette, labelled axes with units, source caption. No 3D, no dual axes.
- B4 must not spam mainnet beyond the budget: run on testnet first; mainnet run ≤ 10 min.
