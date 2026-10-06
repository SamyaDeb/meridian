# Meridian (formerly Pulse)

**Monad's funding-rate layer: per-block funding perps, a public funding-rate oracle, a basis vault and fixed-rate funding swaps. Trade it, earn it, fix it.**

**Status (7 Oct 2026):** live on **Monad testnet 10143** (addresses: [`deployments/10143.json`](deployments/10143.json); demo deployment frozen since 7 Oct, tag `demo-freeze-10143`). **Mainnet-ready by rehearsal, not deployed:** the same deploy scripts pass `VerifyDeployment` 52/52 and 56/56 on a Monad mainnet fork, and the vault's forced-exit path (audit A-01) is proven on a mainnet fork with live Kuru Flow routes. Mainnet comes after the hackathon (Safe owner, keys, paid RPC).

**Evidence:** [`docs/outputs/PROOF.md`](docs/outputs/PROOF.md) (every claim with its test or tx) · [`docs/outputs/BENCHMARKS.md`](docs/outputs/BENCHMARKS.md) · [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) · security status [`docs/outputs/security/STATUS.md`](docs/outputs/security/STATUS.md) · try it: [`docs/outputs/TESTNET_GUIDE.md`](docs/outputs/TESTNET_GUIDE.md).

### Run the tests
```bash
git submodule update --init --recursive
cd contracts && forge build
forge test --no-match-path 'test/fork/*'          # 499 passed (unit, fuzz, invariants at 256 × 128)
touch bench-out/fs_invariant_coverage.csv bench-out/vault_invariant_coverage.csv   # once (forge 1.5.1)
FOUNDRY_PROFILE=ci forge test --match-path 'test/invariant/*'   # invariants at 512 × 256
# Fork tests need a Monad mainnet RPC in MONAD_RPC_URL (read-only); without it they report SKIPPED:
set -a; source ../.env; set +a; forge test --match-path 'test/fork/*'   # 10 passed, 1 skipped (needs KURU_FLOW_ROUTE)
cd .. && pnpm install && pnpm -r test && pnpm -r typecheck   # keeper, MM, indexer, app, bench (viem, vitest)
```

| Layer | What | Where |
|---|---|---|
| Trade it | MON-PERP: fully onchain CLOB, isolated margin (5x), funding accrued every block via O(1) indices, median mark, liquidations + insurance fund. Collateral: Agora AUSD | `contracts/src/{orderbook,clearing,libs,oracle}` |
| Rate oracle | Public, per-block funding-rate oracle: average rate over any window = ΔF/ΔG | `contracts/src/clearing` |
| Earn it | "Skew absorber" basis vault (ERC-4626): spot MON + short perp, capped by net long skew | `contracts/src/vault` |
| Fix it | 30-day fixed-for-floating funding swaps on Meridian's own order book | `contracts/src/swaps` |

Offchain: Chainlink CRE + TS keepers (`keepers/`), Avellaneda–Stoikov MM bot (`mm-bot/`), Envio indexer (`indexer/`), Next.js mobile PWA with Privy (`app/`).

Built for **Monad Metropolis** (Track 01 Onchain Finance & Trading), Sep–Oct 2026.

## Docs
Start with [`CLAUDE.md`](CLAUDE.md) (conventions) and [`docs/TEAM_PLAN.md`](docs/TEAM_PLAN.md) (who does what), then [`docs/PRD.md`](docs/PRD.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/MATH_SPEC.md`](docs/MATH_SPEC.md), [`docs/INTERFACES.md`](docs/INTERFACES.md).
Plan: [`docs/MILESTONES.md`](docs/MILESTONES.md) · [`docs/RISKS.md`](docs/RISKS.md) · [`docs/BOUNTY_MAP.md`](docs/BOUNTY_MAP.md) · [`docs/BENCHMARKS_PLAN.md`](docs/BENCHMARKS_PLAN.md) · [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).
Workstreams: [`docs/workstreams/`](docs/workstreams/).
