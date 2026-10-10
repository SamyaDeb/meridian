# Meridian

**Monad's funding-rate layer: per-block funding perps, a public funding-rate oracle, a basis vault and fixed-rate funding swaps. Trade it, earn it, fix it.**

Perp funding is usually paid every 1–8 hours because the venues that set the convention were slow. On Monad (≈ 300 ms blocks) funding can accrue every block, and the rate itself can be a public onchain primitive that other protocols read, earn or fix.

- **Live on Monad testnet (10143):** https://meridian-testnet.vercel.app ([testnet guide](docs/outputs/TESTNET_GUIDE.md), addresses in [`deployments/10143.json`](deployments/10143.json))
- **Mainnet-ready by rehearsal, not deployed:** the deploy scripts pass `VerifyDeployment` 52/52 and 56/56 on a Monad mainnet fork; the vault's forced-exit path is proven on a fork with live Kuru Flow routes.
- **Evidence:** [`PROOF.md`](docs/outputs/PROOF.md) (every claim with its test or tx) · [`BENCHMARKS.md`](docs/outputs/BENCHMARKS.md) · [security status](docs/outputs/security/STATUS.md) · [write-up](docs/outputs/WRITEUP.md)

## What's in it

| Layer | What | Where |
|---|---|---|
| Trade it | MON-PERP on a fully onchain order book (CLOB), isolated margin up to 5x, funding accrued every block through O(1) indices, median mark, liquidations, insurance fund and a bad-debt waterfall. Collateral: AUSD | `contracts/src/{orderbook,clearing,libs,oracle}` |
| Rate oracle | Public per-block funding-rate oracle: the average rate over any window is ΔF / ΔG | `contracts/src/clearing` |
| Earn it | Basis vault (ERC-4626 + async withdrawal queue): spot MON plus a short perp, sized by the net long skew | `contracts/src/vault` |
| Fix it | 30-day fixed-for-floating funding swaps on Meridian's own order book | `contracts/src/swaps` |

Offchain: TypeScript keeper (`keepers/ts-fallback`), Avellaneda–Stoikov market maker (`mm-bot/`), Meridian Funding Index service comparing venues incl. Perpl over its live WebSocket (`mfi/`), Perpl hedge for the market maker over Perpl's trading API ([docs/PERPL_HEDGE.md](docs/PERPL_HEDGE.md), [PROOF §12](docs/outputs/PROOF.md#12-perpl-hedge-the-mm-offloads-inventory-to-perpl-through-its-trading-api-k3)), Envio HyperIndex indexer (`indexer/`), Next.js mobile-first app with Privy login (`app/`), benchmarks (`bench/`). Chainlink CRE backstop keeper (`keepers/cre/`): liquidation guardian, funding/vault upkeep and an onchain Meridian Funding Index, broadcast on testnet via CRE simulation ([README](keepers/cre/README.md), [PROOF §13](docs/outputs/PROOF.md#13-chainlink-cre-backstop-keeper-k4)).

## Run it

```bash
git submodule update --init --recursive
cd contracts && forge build
forge test --no-match-path 'test/fork/*'                      # unit, fuzz, invariants (256 × 128)
FOUNDRY_PROFILE=ci forge test --match-path 'test/invariant/*' # invariants at 512 × 256
# fork tests need a Monad mainnet RPC in MONAD_RPC_URL (read-only); without it they report SKIPPED
cd .. && pnpm install && pnpm -r typecheck && pnpm -r test    # keeper, MM, MFI, indexer, app, bench
```

Local full stack (anvil + contracts + bots + app): [`contracts/script/README.md`](contracts/script/README.md). Ops: [`keepers/RUNBOOK.md`](keepers/RUNBOOK.md).

## Docs

[`docs/PRD.md`](docs/PRD.md) · [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/MATH_SPEC.md`](docs/MATH_SPEC.md) · [`docs/INTERFACES.md`](docs/INTERFACES.md) · [`docs/MFI.md`](docs/MFI.md) · [`docs/RISKS.md`](docs/RISKS.md) · decisions in [`docs/PHASES.md`](docs/PHASES.md) and [`docs/CHANGE_REQUESTS.md`](docs/CHANGE_REQUESTS.md) · conventions in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Team

Built for **Monad Metropolis** (Track 01 Onchain Finance & Trading), 29 Sep – 13 Oct 2026, by three founders: **A (Samya)**, core protocol; **B**, liquidity and automation; **C**, product and growth ([`docs/TEAM_PLAN.md`](docs/TEAM_PLAN.md)).

## Licence, history and prior work

[MIT](LICENSE). Third-party libraries and their licences: [`THIRD_PARTY.md`](THIRD_PARTY.md).

This public repository is a curated history of the team's private development repository: each commit is a real state of the code, dated when that work was done, with related steps grouped; internal planning and session logs stay private. All code was written during the hackathon. One frontend commit during development ported a chart top bar from a founder's earlier project; it isn't part of this history, and the chart's top and bottom bars were rewritten from a behavioural spec ([`CHART_TOPBAR_SPEC.md`](docs/outputs/CHART_TOPBAR_SPEC.md)).
