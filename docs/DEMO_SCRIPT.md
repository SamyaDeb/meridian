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
