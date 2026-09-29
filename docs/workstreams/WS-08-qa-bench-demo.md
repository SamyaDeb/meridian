# WS-08 — QA/security, invariants, benchmarks, √τ chart, deployment, demo & write-up

**Founder:** C (runs it); A and B review contracts per the cross-review matrix

**Goal:** Prove the system is correct (invariants, fuzzing, review) and prove "why only Monad" (benchmarks, √τ chart). Run the mainnet deploy with WS-00 and produce the demo video script execution and the write-up.

## Owned paths
`contracts/test/invariant/**` (except `handlers/*Handler.sol`, which module owners provide), `contracts/test/bench/**` (except `OrderBookGas.t.sol`), `contracts/script/CrashDemo.s.sol`, `contracts/script/bench/**`, `bench/**`, `docs/outputs/**` (benchmark report, write-up, security review), `docs/DEMO_SCRIPT.md` (updates).

## Interfaces
Consumes everything. Provides: invariant suites, `bench/out/*`, `docs/outputs/BENCHMARKS.md`, `docs/outputs/WRITEUP.md`, `docs/outputs/SECURITY_REVIEW.md`.

## Task checklist (ordered)
1. [ ] Read all specs; turn MATH_SPEC §7 (I1–I11) into invariant test skeletons with ghost variables (`test/invariant/PulseInvariants.t.sol`), initially against mocks.
2. [ ] `bench/sqrt_tau.py` → `bench/out/sqrt_tau.png` + CSV (B6), matching the MATH_SPEC §3.4 table. Can be done Day 1.
3. [ ] Integrate module handlers (WS-01/02/04/05) as they land; get I1–I7 green by CP2, I8–I11 by Day 10.
4. [ ] Security review pass per PR: reentrancy on value flows, CEI, rounding direction, unbounded loops, access control, oracle failure modes, Kuru slippage. Log it in `docs/outputs/SECURITY_REVIEW.md`. Run `slither` if available.
5. [ ] Bench harness: `bench/gas_onchain.ts`, `bench/load.ts` (B4 multi-market parallel), B2 funding first/later touch, B3 MIP-8 layout, B5 funding granularity, B7 liquidation latency. Testnet first.
6. [ ] `script/CrashDemo.s.sol` (DEMO_SCRIPT crash setup) on a mainnet fork; export per-block CSV for the overlay chart.
7. [ ] With WS-00: mainnet deploy on Day 12 (caps from MATH_SPEC), verify contracts on monadscan (VERIFY verifier config), seed the IF, `deployments/143.json`.
8. [ ] Final `docs/outputs/BENCHMARKS.md` (every number with network, block range, commit, date), `WRITEUP.md`, demo video recording per DEMO_SCRIPT, project profile, submission checklist per BOUNTY_MAP.

## Acceptance criteria
- Invariants I1–I11 pass at `runs=256, depth=128` (CI profile 512×256) with the real contracts.
- Every hard acceptance criterion from the brief has linked evidence: O(1) funding (code pointer + gas flat vs. #positions test), manipulation resistance (tests), benchmarks, √τ chart, invariants, live deployment with fees, crash demo.
- Benchmarks reproducible from `bench/README.md` commands.
- Submission filed by Day 15 18:00 local.

## Required tests
Invariant suites; a "funding gas is O(1)" test: gas of `settleFunding`/first touch is constant for 1, 100 and 1,000 open positions.

## Out of scope
Implementing protocol modules (report bugs to owners via PR comments/issues).

## Day budget
D1 read + √τ chart · D2 invariant skeletons · D4 handlers · D5 CP1 test plan · D6–7 invariants · D8 bench harness · D9 CP2 · D10 benchmarks · D11 fork rehearsal + crash demo · D12 CP3 deploy · D13 report · D14 video + write-up · D15 submit.

## Kickoff prompt
```
You are the engineer for WS-08 (QA/security, invariants, benchmarks, √τ chart, deployment, demo and write-up) of Pulse.
Read CLAUDE.md, docs/TEAM_PLAN.md, docs/PRD.md, docs/MATH_SPEC.md (§3.4 and §7 are your core), docs/ARCHITECTURE.md, docs/BENCHMARKS_PLAN.md, docs/DEMO_SCRIPT.md, docs/BOUNTY_MAP.md, docs/RISKS.md and docs/workstreams/WS-08-qa-bench-demo.md.
Work only in your owned paths on branch ws-08-qa.
Day 1: produce bench/sqrt_tau.py and its chart, and write the invariant test skeletons for I1–I11 against the mocks.
Afterwards, integrate module handlers as they merge, review every PR for security issues, and build the benchmark harness on testnet before mainnet.
Every reported number must include network, block range, commit hash and date.
```
