# CLAUDE.md — Meridian engineering conventions (every session MUST follow)

Meridian = Monad's funding-rate layer: per-block-funding perp → public funding-rate oracle → basis vault (floating yield) → funding swaps (fixed yield). Team: 3 founders, lanes in `docs/TEAM_PLAN.md`. Hackathon: Monad Metropolis, deadline **13 Oct 2026**.
Read order for any new session: this file → `docs/TEAM_PLAN.md` → `docs/PRD.md` → `docs/MATH_SPEC.md` → `docs/INTERFACES.md` → your `docs/workstreams/WS-XX-*.md`.

## 1. Hard rules
1. **Never invent** contract addresses, RPC URLs, chain IDs, SDK function names, feed IDs or token decimals. Use values in `docs/ARCHITECTURE.md §Research` (each has a source). Anything else: write `> VERIFY: <what, where>` and continue.
2. **All code is written during the build window** (1 Sep – 13 Oct 2026). Do not paste code from prior projects (including Kryon). Libraries via `forge install` / npm are fine.
3. **Edit only your owned paths** (see your WS doc). Need something outside? Add an entry to `docs/CHANGE_REQUESTS.md` and keep going against the mock.
4. **Interfaces are frozen.** `contracts/src/interfaces/**` changes only via an approved change request applied by a WS-00 session.
5. **No unbounded loops onchain.** Any loop is bounded by a constant in `MeridianConstants` (`MAX_FILLS_PER_ORDER`, `MAX_BATCH`, `MAX_OPEN_ORDERS_PER_ACCOUNT`). Never iterate users, positions or orders globally.
6. **Security:** checks-effects-interactions; `nonReentrant` (OZ `ReentrancyGuardTransient`, Cancun) on every function that moves tokens or calls an external contract; `SafeERC20` for all token transfers; no `tx.origin`; no `delegatecall` to untrusted targets. Non-upgradeable contracts (MVP).
7. **Tests first.** No PR merges with failing `forge test` or without the tests listed in your WS doc.

## 2. Fixed-point & rounding (normative; details in MATH_SPEC §0)
| Quantity | Scale | Type |
|---|---|---|
| price, size, notional, collateral, pnl, fee, F (cumFunding) | WAD 1e18 | `uint256` / `int256` |
| rates | per-second, WAD | `int256` |
| AUSD token amounts at the boundary (`amountToken`) | 6 dp (verified onchain) | `uint256` |
| vault shares | 18 dp | `uint256` |
| funding-swap book price | WAD, = 1 + fixed APR | `uint256` |
| block time | ms | `uint256` |

- Convert AUSD→WAD with `* 1e12` (exact). WAD→AUSD with `/ 1e12` **rounding down** (user receives less).
- **Always round against the user, in favour of solvency**: amounts owed *by* the user round up; amounts paid *to* the user round down; margin requirements round up; shares minted round down; shares burned round up.
- Use `solady/utils/FixedPointMathLib.sol` (`mulWad`, `mulWadUp`, `divWad`, `divWadUp`, `fullMulDiv`, `fullMulDivUp`, `sMulWad`, `expWad`, `lnWad`) or OZ `Math.mulDiv(..., Rounding)`. Never hand-roll `a*b/c` where `a*b` can overflow.
- Every formula in code carries a comment `// MATH_SPEC §x.y, rounds <up|down|neutral>`.

## 3. Solidity style
- Solidity `0.8.28`, `evm_version = cancun`, optimizer 10k runs. `forge fmt` before commit.
- Custom errors (declared in the interface), no revert strings. Events for every state change consumers need (all declared in interfaces).
- Storage: pack hot fields; group per-market hot state in adjacent slots (MIP-8 pages: 128 slots = 4 KB, first touch 8,100 gas, later touches in the same page 100 gas). Per-account state in `mapping(address => Struct)`.
- Naming: `_internalFn`, `CONSTANT_CASE`, `immutable` for wiring set at deploy. NatSpec on all external functions.
- One contract per file; file name = contract name.

## 4. Testing requirements
- `contracts/test/unit/<Module>.t.sol`: every external function, every revert path.
- `contracts/test/fuzz/<Module>.fuzz.t.sol`: all math (rounding direction asserted!), bounds via `bound()`.
- `contracts/test/invariant/`: owned by WS-08, but each WS provides a Handler for its module.
- Gas: `forge snapshot` on hot paths; WS-01 must report place/cancel/match gas.
- Offchain TS: `vitest`; strict TypeScript; `viem` only (no ethers).

## 5. Branches, commits, PRs
- Branch per workstream: `ws-XX-name` (e.g. `ws-02-clearinghouse`). Rebase on `main` daily.
- Conventional commits: `feat(ws-02): per-block funding index`, `test(ws-01): ...`, `fix`, `docs`, `chore`.
- PR title `[WS-XX] ...`; body lists acceptance criteria checked. CI (`forge build`, `forge test`, `forge fmt --check`) must be green.
- Integration checkpoints: **Day 5 (Sat 3 Oct), Day 9 (Wed 7 Oct), Day 12 (Sat 10 Oct)** — see `docs/MILESTONES.md`.

## 6. Monorepo layout
```
contracts/  Foundry (src/{interfaces,mocks,orderbook,clearing,libs,oracle,automation,vault,swaps}, test/, script/)
keepers/    cre/ (Chainlink CRE workflows, TS) + ts-fallback/ (viem keeper)
mm-bot/     Avellaneda–Stoikov market maker (TS, viem)
indexer/    Envio HyperIndex
app/        Next.js mobile-first PWA (wagmi/viem, Privy)
bench/      benchmark scripts + outputs (WS-08)
docs/       specs; docs/workstreams/ per-engineer briefs
```

## 7. Environment
- Monad mainnet chain id **143**, testnet **10143** (docs.monad.xyz). RPCs come from `.env` (`MONAD_RPC_URL`, `MONAD_TESTNET_RPC_URL`), never hard-coded in contracts.
- Monad charges gas by **gas limit**, not gas used: set tight gas limits in keepers/bots/UI (estimate × 1.2).
- `block.timestamp` has **1-second** resolution while blocks are ~300 ms: never use timestamp deltas for per-block math; use `block.number` (MATH_SPEC §1.1).
