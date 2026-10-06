# DEMO_SCRIPT: 3:00 video (Meridian, testnet 10143)

*Revised 7 Oct 2026 (HARDENING_PLAN P6.5). PHASES 40: no mainnet deploy before submission, so every on-screen transaction is on **Monad testnet 10143** (`deployments/10143.json`), labelled "testnet" on screen. Mainnet readiness is shown as evidence, not as a live deploy: the mainnet-fork rehearsal (Verify 52/52) and the A-01 fork test with real Kuru Flow routes (`test/fork/VaultV2Fork.t.sol`).*

Phone screen capture (vertical inset) plus desktop dashboard. Judges want real transactions on camera with contract addresses and an explicit "why Monad".

| Time | Visual | Voice-over (≈) | Proof on screen |
|---|---|---|---|
| 0:00–0:15 | Title → "Hourly funding exists because chains were slow." | "On Monad blocks are 300 ms, so funding should be continuous. Meridian is the funding-rate layer: trade it, earn it, fix it." | Logo |
| 0:15–0:35 | Phone: email/passkey login (Privy) → tAUSD balance | "One tap in, no seed phrase. Everything settles in AUSD (testnet: labelled tAUSD)." | Login modal, address |
| 0:35–1:00 | Trade: MON-PERP, funding ticking every block; open a long | "This rate updates every block. It isn't a countdown to the next hour." | Block number + funding ticker; explorer tx |
| 1:00–1:20 | `/rates`: Meridian Funding Index (realized 1h / 8h / 24h APR) | "Every block's funding goes into a public onchain rate that any protocol can read." | `averageFundingRate` call |
| 1:20–1:50 | Earn: deposit → instant withdraw from idle → request beyond idle → keeper fulfils in a few blocks → claim | "Small exits are instant. Bigger ones are queued, priced at the vault's NAV, and the batch pays its own unwind, so nobody else is diluted." | `RedeemRequested` / `RedeemFulfilled` / `RedeemClaimed`, share price before/after |
| 1:50–2:05 | Fix: go long the 30-day swap at the book APR → "your funding cost is now fixed" | "Traders lock their funding cost; yield seekers lock a fixed rate. It settles every block from the same index." | Swap position, accrual ticking |
| 2:05–2:25 | Benchmarks: gas table, parallel markets, √τ | "Place+cancel under 100k gas, funding update under 30k, liquidation within blocks." | B1, B2, B4, B6/B7 |
| 2:25–2:50 | **Crash** on the labelled test market MON-PERP-DEMO: −15% in one oracle update → leveraged long liquidated within blocks; then pause → `MakerFillSkipped` (orders kept, not evicted) | "The trader is liquidated within blocks, the insurance fund holds, and a paused market keeps makers' orders instead of wiping them." | `Liquidated` event + latency, `MakerFillSkipped` |
| 2:50–3:00 | Metrics (indexer) + "mainnet-ready: fork rehearsal + real-route fork test"; links | "Live on Monad testnet; mainnet-ready, proven on a mainnet fork with real Kuru routes." | Indexer dashboard, fork test output |

## P6.5 rehearsal on the frozen deployment (7 Oct 2026, blocks 68,775,956–68,780,323)

| Step | In the app | Script / bots only | Blocked on |
|---|---|---|---|
| Trade MON-PERP | Order ticket + positions wired to chain (`OrderTicket`, `PositionsCard`); **not re-clicked in P6** | ✅ tester B 20-lot long `0x6778…6d77` (block 68,776,845) against the MM | keeper + MM must be up (stale oracle blocks increases) |
| Per-block funding ticker | `FundingTicker` / market strip read the chain | ✅ keeper funding pokes every ≤ 20 blocks | keeper up |
| `/rates` MFI page | page reads chain; 8 h / 24 h show "—" until the perp has 8 h of continuous checkpoints; risk panel needs the indexer | — | 8 h of keeper uptime (≈ 9 MON/h × 8 h) for the 8 h number; `NEXT_PUBLIC_INDEXER_URL` (hosted Envio on v2, owner) |
| Vault deposit + instant withdraw | ✅ Earn page uses `deposit` / `withdraw` / `redeem` (same ABI in v2) | ✅ deposits `0x4be0…85b6`, `0xddc9…37ee`; sync withdraw `0xf4d9…29ed` | — |
| Vault request → fulfil → claim (idle and beyond idle), emergency unwind | ❌ no Earn v2 UI yet (Found #23) | ✅ all on testnet (HARDENING_LOOP P6 evidence) | **C: Earn v2 UI** |
| Crash + liquidation (demo market) | app shows MON-PERP-DEMO only with a TEST badge; crash is driven by the demo keeper's price factor | ✅ liquidated `0xe1e9…9461`, **5 blocks** after the crash push (target ≤ 3 missed, free-tier RPC, Found #18) | paid / websocket RPC for the keeper to hit ≤ 3 |
| Skip (pause / unpause) | — | ✅ `MakerFillSkipped` in `0x9089…4d47`, order kept | — |
| Fix a rate (swap) | Fix page wired (pay / receive fixed, close, margin) | — | **owner: swap-MM key + MON** (testnet swap book is empty) |
| Indexer dashboard / metrics | Stats page needs `NEXT_PUBLIC_INDEXER_URL` | indexer configs repointed (`f4570b9`), handler tests 83/83 | **owner: hosted Envio redeploy** (Found #20); local run needs Docker Desktop up |

Fallback for any segment that is still blocked at recording time: the script/bot run above, shown with its explorer links.

## Recording checklist (P7, 7 Oct 2026; the owner records)

Testnet 10143 only, frozen deployment. MON numbers are measured (HARDENING_LOOP P6/P7, RUNBOOK §7c) at 102 gwei; Monad bills the gas limit. Bots: start/stop exactly as RUNBOOK §7c (stop **by PID**, one per `kill`). Scripts referenced below are the P6/P7 session scripts (test-wallet keys live outside the repo; recreate them from RUNBOOK §7c if the scratchpad is gone).

**Before any shot:** `bash bal.sh` (balances), keeper `/health` `ok: true`, `cast call <oracle> "tryGetIndexPrice()(bool,uint256,uint256)"` returns `true`, perp MM `openOrderCount > 0`. Base cost while recording: main keeper ≈ 5 MON / 30 min, perp MM ≈ 1.3, flow ≈ 0.65 (only if the chart needs trades). **Top up the main keeper to ≥ 6 MON first** (it has 4.51).

| # | Shot (DEMO_SCRIPT time) | Exact route / command | Bots up | MON for the shot | If blocked in the app: fallback |
|---|---|---|---|---|---|
| 1 | Title (0:00) | — | none | 0 | — |
| 2 | Login → tAUSD balance (0:15) | app `/` → login (Privy only if `NEXT_PUBLIC_PRIVY_APP_ID` is set in the recorded build; else injected wallet) | none | 0 | show the injected-wallet connect; don't claim Privy |
| 3 | Trade MON-PERP, funding moving (0:35) | app `/trade`, open a 1–2 lot long from a labelled test wallet | keeper + perp MM | ≈ 0.05 per user tx (≤ 500k limit) + bots | `cast send <OB> "placeMarketOrder(bool,uint64,uint32,uint64,bool)" true 1 <tick> 1 false` from the test wallet + explorer link (testnet.monadvision.com) |
| 4 | Oracle / `/rates` (1:00) | app `/rates` (1 h APR; 8 h / 24 h show "—" without 8 h of keeper uptime, Found #34); on screen: `cast call 0x1F90B5Eb6D59adAe2be147b3903c7aCb4c16a6eA "averageFundingApr(uint64)(int256)" 12000` (12,000 blocks ≈ 1 h at 300 ms) | keeper (≥ 1 h before for a 1 h window) | bots only | the `cast call` alone |
| 5 | Earn: deposit → instant withdraw (1:20) | app `/earn` (v1 calls are the same in v2) | keeper | ≈ 0.05 per tx | P6 txs `0x4be0…85b6` (deposit), `0xf4d9…29ed` (sync withdraw) on the explorer |
| 6 | Earn: request beyond idle → keeper fulfils → claim (1:30) | **blocked in the app (Earn v2 UI, C, Found #23)** | keeper (fulfil loop on by default) | ≈ 0.05 request + ≈ 0.05 claim (test wallet); fulfil paid by the keeper | script: `requestRedeem(shares, receiver, owner)` from the test wallet → keeper log `vault fulfillRedeems` → `claimRedeem(id)`; or show P6's `0xfd8d…05bd` → `0xe6ba…8fe5` → `0xea96…106b` with share price before/after (HARDENING_LOOP P6.3). A hedged vault needs the mock hedger synced (`setPrice(index)`) and the labelled forced `enterHedge()` (no 8 h history), so prefer the recorded P6 txs |
| 7 | Fix: long the 30-day swap (1:50) | app `/fix` | swap MM (**no key**) | ≈ 4 MON swap MM for 10 min (projection) + owner setup | **blocked (owner: swap-MM key + MON).** Fallback: `forge test --match-test test_accrual_equalsFormulaFromPerpIndices -vv` on screen (the floating leg equals the perp index) + the Fix page's quote panel; say "testnet swap book not funded" |
| 8 | Benchmarks (2:05) | `docs/outputs/BENCHMARKS.md` B1/B2/B6/B7 | none | 0 | — . Voice-over must say "**execution gas on the Cancun schedule**: place + cancel 96k, funding 29k"; on Monad the billed limit is higher (B1). **Drop "parallel markets"**: B4 was not run |
| 9 | Crash + liquidation + automatic unwind (2:25) | app `/trade` on MON-PERP-DEMO with its TEST badge (> VERIFY the market switcher shows it in the recorded build); drive: demo MM, then demo keeper 10 s later; test wallet ≈ 4.7x long (`crash7.sh`: 20 tAUSD deposit, 50 lots); `echo 0.85 > $PRICE_FACTOR_FILE`; `echo 1 >` after | demo MM + demo keeper only | **≈ 0.8** (P7: demo keeper 0.30, demo MM 0.48, wallet 0.04) | demo keeper log lines `liquidate (whole)` → `liquidation latency` → `unwind (sell N lots reduce-only IOC …)` → `unwind filled` + explorer: P7 `0x1256…45ef` → `0x78cc…aef6` |
| 10 | Skip (2:40) | deployer `setPaused(true)` on the demo CH, test wallet (short) reduce-only buy into the demo MM's ask, `setPaused(false)` | demo MM + demo keeper | ≈ 0.1 (3 txs) | P4 `0x1b8c…092d` / P6 `0x9089…4d47` (`MakerFillSkipped`, order kept) |
| 11 | Metrics + mainnet-ready (2:50) | app `/stats` (needs `NEXT_PUBLIC_INDEXER_URL` on the v2 hosted index, **owner, Found #20**); terminal: `forge test --match-path test/fork/VaultV2Fork.t.sol -vv` with `MONAD_RPC_URL` loaded | none | 0 | without the hosted index: skip `/stats`, show `docs/outputs/PROOF.md` §8 + the fork test output |

**Keys and MON left (7 Oct, after P7):** deployer 0.831 · main keeper 4.515 · perp MM 3.411 · flow 1.185 · demo keeper 1.386 · demo MM 0.916 · test wallet A 0.115 · B 0.066 · swap MM: no key. A full 30-min take with shots 3–6 and 9–10: main keeper +1.5 (to ≥ 6), demo MM fine for one crash, deployer ≥ 0.3 for the Skip pause pair + any test-wallet top-ups.
