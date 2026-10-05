# Meridian (internal name: Pulse)

**Monad's funding-rate layer: per-block funding perps, a public funding-rate oracle, a basis vault and fixed-rate funding swaps. Trade it, earn it, fix it.**

| Layer | What | Where |
|---|---|---|
| Trade it | MON-PERP: fully onchain CLOB, isolated margin (5x), funding accrued every block via O(1) indices, median mark, liquidations + insurance fund. Collateral: Agora AUSD | `contracts/src/{orderbook,clearing,libs,oracle}` |
| Rate oracle | Public, per-block funding-rate oracle: average rate over any window = ΔF/ΔG | `contracts/src/clearing` |
| Earn it | "Skew absorber" basis vault (ERC-4626): spot MON + short perp, capped by net long skew | `contracts/src/vault` |
| Fix it | 30-day fixed-for-floating funding swaps on Meridian's own order book | `contracts/src/swaps` |

Offchain: Chainlink CRE + TS keepers (`keepers/`), Avellaneda–Stoikov MM bot (`mm-bot/`), Envio indexer (`indexer/`), Next.js mobile PWA with Privy (`app/`).

Built for **Monad Metropolis** (Track 01 Onchain Finance & Trading), Sep–Oct 2026.

## Quickstart
```bash
git submodule update --init --recursive
cd contracts && forge build && forge test
```

## Docs
Start with [`CLAUDE.md`](CLAUDE.md) (conventions) and [`docs/TEAM_PLAN.md`](docs/TEAM_PLAN.md) (who does what), then [`docs/PRD.md`](docs/PRD.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/MATH_SPEC.md`](docs/MATH_SPEC.md), [`docs/INTERFACES.md`](docs/INTERFACES.md).
Plan: [`docs/MILESTONES.md`](docs/MILESTONES.md) · [`docs/RISKS.md`](docs/RISKS.md) · [`docs/BOUNTY_MAP.md`](docs/BOUNTY_MAP.md) · [`docs/BENCHMARKS_PLAN.md`](docs/BENCHMARKS_PLAN.md) · [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).
Workstreams: [`docs/workstreams/`](docs/workstreams/).
