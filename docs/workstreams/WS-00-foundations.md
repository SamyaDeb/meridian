# WS-00 — Foundations (scaffold, interfaces, mocks, CI, deploy scripts)

**Founder:** A (Samya)

**Goal:** Keep the repo buildable and the interfaces stable. Own CI, the deploy scripts and the change-request process so eight other sessions can work in parallel without stepping on each other.

**Already done by the planning session (29 Sep):** repo layout, Foundry project (forge-std, OZ v5.4.0, solady v0.1.26), all interfaces in `contracts/src/interfaces/`, mocks in `contracts/src/mocks/`, smoke test, `tools/gen_interfaces_md.py`, all docs. `forge build` and `forge test` pass.

## Owned paths
`/CLAUDE.md`, `/README.md`, `/.github/**`, `/tools/**`, `/package.json`, `/pnpm-workspace.yaml`, `/.env.example`, `/.gitignore`, `/deployments/**`, `contracts/foundry.toml`, `contracts/src/interfaces/**`, `contracts/src/mocks/**`, `contracts/test/mocks/**`, `contracts/script/Deploy*.s.sol`, `contracts/script/config/**`, `docs/INTERFACES.md`, `docs/CHANGE_REQUESTS.md`.

## Interfaces
Provides: all of `docs/INTERFACES.md`. Consumes: none.

## Task checklist (ordered)
1. [ ] Commit the scaffold on `main` (first commit), tag `interfaces-v1.1` (CR-001..003 already applied).
2. [ ] `.github/workflows/ci.yml`: `forge fmt --check`, `forge build`, `forge test` (profile `ci`), `python3 tools/gen_interfaces_md.py --check`, and pnpm lint/typecheck for TS packages that exist (skip when absent).
3. [ ] pnpm workspace: `keepers/*`, `mm-bot`, `indexer`, `app` with a shared `tsconfig.base.json` and a `packages/abis` (or `contracts/out` export script `tools/export_abis.sh` → `abis/*.json`) so TS packages consume ABIs generated from interfaces.
4. [ ] `.env.example`: `MONAD_RPC_URL`, `MONAD_TESTNET_RPC_URL`, `DEPLOYER_PK`, `KEEPER_PK`, `MM_PK`, `PYTH_MON_USD_FEED_ID` (= 0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1), `PYTH_API_KEY`, `KURU_FLOW_JWT`, `PRIVY_APP_ID`, `ENVIO_API_TOKEN`. No real values committed.
5. [ ] `contracts/script/config/{143,10143,31337}.json`: addresses from ARCHITECTURE §0 (AUSD, WMON, Pyth, Chainlink MON/USD, Kuru Router/MarginAccount) + params from MATH_SPEC. Testnet addresses: VERIFY each from official docs; leave `null` if unknown.
6. [ ] `contracts/script/DeployLocal.s.sol`: deploys mocks + a mock-wired market for WS-06/07 local dev (anvil). Writes `deployments/31337.json`.
7. [ ] `contracts/script/DeployMeridian.s.sol` skeleton following ARCHITECTURE §7 order (perp market + swap market + vault; owner = Safe 2-of-3), with `TODO(WS-xx)` stubs that compile against interfaces (use `vm.getCode` by artifact name so it compiles before implementations exist).
8. [ ] Triage `CHANGE_REQUESTS.md` daily at 10:00 and 18:00; apply approved CRs (interface + mocks + regenerate INTERFACES.md), bump tag.
9. [ ] CP1–CP3: run the integration wiring, own `deployments/*.json`, and run the mainnet deploy on Day 12 with WS-08.

## Acceptance criteria
- CI green on `main`; a PR that edits an interface without a regenerated INTERFACES.md fails CI.
- `forge script script/DeployLocal.s.sol --fork-url http://localhost:8545 --broadcast` succeeds on anvil and writes `deployments/31337.json`.
- ABIs are consumable from TS (`import abi from '@meridian/abis/IClearingHouse.json'`).

## Required tests
Mock smoke tests stay green; add a mock test whenever a mock changes.

## Out of scope
Any implementation under `orderbook/ clearing/ libs/ oracle/ automation/ vault/ swaps/`.

## Day budget
Day 1 (all tasks 1–7). Days 2–15: ~1 h/day CR triage; Day 5/9/12 integration.

## Kickoff prompt
```
You are the engineer for WS-00 (Foundations) of the Meridian hackathon project.
Read CLAUDE.md, docs/TEAM_PLAN.md, docs/PRD.md, docs/ARCHITECTURE.md, docs/INTERFACES.md, docs/CHANGE_REQUESTS.md and docs/workstreams/WS-00-foundations.md.
The planning session already created the scaffold, interfaces, mocks and docs; forge build/test pass.
Work only in your owned paths. First make the initial commit on main and tag interfaces-v1.1, then create branch ws-00-foundations for the rest.
Do tasks 2–7 in order (CI, pnpm workspace + ABI export, .env.example, network configs, DeployLocal, DeployMeridian skeleton).
Never invent addresses: use only ARCHITECTURE.md §0 values; otherwise null + "VERIFY" comment.
Finish with CI green and report which VERIFY items you could not resolve.
```
