# MILESTONES: 15 days (Day 1 = Tue 29 Sep, Day 15 = Tue 13 Oct 2026)

Per-founder daily plan: **docs/TEAM_PLAN.md §4**. This file holds the gates.

| Day | Date | Focus |
|---|---|---|
| 1 | Tue 29 Sep | Tag `interfaces-v1.1`; launch WS-00/01/02/03/06/07/08(√τ); Day-1 external checklist |
| 2–4 | 30 Sep–2 Oct | OB, CH + funding + oracle, oracle adapter, keeper, MM bot, indexer on mocks, PWA shell |
| **5** | **Sat 3 Oct** | **CP1** |
| 6–8 | 4–6 Oct | Funding swaps (A), vault + Kuru route + CRE (B), wiring + benchmark harness (C) |
| **9** | **Wed 7 Oct** | **CP2: scope freeze** |
| 10–11 | 8–9 Oct | Invariants, mainnet config, fork rehearsal, mobile polish, testnet benchmarks |
| **12** | **Sat 10 Oct** | **CP3: mainnet**, contract code freeze 18:00 |
| 13 | Sun 11 Oct | Fixes, benchmark report, metrics |
| 14 | Mon 12 Oct | Crash-demo recording, video, write-up |
| 15 | Tue 13 Oct | Submit by 18:00 |

## Checkpoint exit criteria (demoed live; else next day is fix-only)
**CP1 (Day 5), testnet:**
- [ ] Real OrderBook + ClearingHouse + OracleAdapter integrated; `forge test` green
- [ ] deposit → limit → market cross → positions opened; `FundingUpdated` once per block; pendingFunding changes per block
- [ ] `averageFundingApr(…)` equals ΔF/ΔG from events
- [ ] Price drop → liquidation; IF receives penalty
- [ ] Keeper + MM running on testnet; indexer ingests; app shows position

**CP2 (Day 9), full stack testnet, then scope freeze:**
- [ ] Vault: deposit → keeper rebalance (direct or Kuru Flow route) → hedged within θ; skew cap enforced; NAV rises with funding
- [ ] Swaps: long/short fill on the swap book; accrual matches MATH_SPEC §6.2; maturity snapshot works on a short test maturity
- [ ] Invariants I1–I7 green; swap + oracle handlers in place
- [ ] Demo dry-run end to end

**CP3 (Day 12), mainnet:**
- [ ] Deployed via script, owner = Safe 2-of-3, caps set (TEAM_PLAN §7); `deployments/143.json`
- [ ] IF seeded, MM quoting both books, keeper live, vault seeded
- [ ] ≥ 5 external users; first fees onchain
- [ ] Crash demo rehearsed on a mainnet fork
