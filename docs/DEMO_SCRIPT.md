# DEMO_SCRIPT: 3:00 video

Phone screen capture (vertical inset) plus desktop dashboard. Mainnet unless noted; the crash segment runs on a mainnet fork (disclosed on screen). Judges want real transactions on camera with contract addresses and an explicit "why Monad".

| Time | Visual | Voice-over (≈) | Proof on screen |
|---|---|---|---|
| 0:00–0:15 | Title → "Hourly funding exists because chains were slow." | "On Monad blocks are 300 ms, so funding should be continuous. We built the funding-rate layer: trade it, earn it, fix it." | Logo |
| 0:15–0:35 | Phone: passkey/email login → AUSD balance | "One tap in, no seed phrase. Everything is in AUSD." | Login modal, address |
| 0:35–1:00 | Trade: MON-PERP, funding ticking every block; open a 5x long | "This rate updates every block. It isn't a countdown to the next hour." | Block number + F ticking; monadscan tx |
| 1:00–1:20 | Oracle card: 8 h / 24 h realized funding APR | "Every block's funding goes into a public onchain rate that any protocol can use." | `averageFundingApr` call |
| 1:20–1:45 | Earn: deposit 100 AUSD → vault hedged, APY ticking | "The vault buys MON, shorts the perp and earns funding every block. It only takes the short side the market needs." | Hedge state, netDelta ≈ 0 |
| 1:45–2:05 | Fix: go long a 30-day swap at 12% → "your funding cost is now fixed" | "Traders lock their funding cost; yield seekers lock a fixed rate. It settles every block from the same index." | Swap position, accrual ticking |
| 2:05–2:25 | Benchmarks: gas table, parallel markets chart, √τ chart | "Place+cancel under 100k gas, funding update X gas, K markets in parallel. Faster liquidation means less margin." | B1, B2, B4, B6 |
| 2:25–2:50 | **Crash** (fork): MON −15% in one oracle update. Split screen: unhedged trader liquidated within N blocks · vault NAV flat · swap fixed rate barely moves | "The leveraged trader is liquidated within blocks, the insurance fund holds, the vault is flat, and fixed rates barely move." | `Liquidated` event, NAV line, markApr line |
| 2:50–3:00 | Metrics: users, volume, fees, TVL; links | "Live on Monad mainnet: X users, $Y volume, $Z fees." | Indexer dashboard |

Crash-demo setup (B + C): mainnet fork at block B → trader at 5x (max) → vault hedged → swap book seeded → `script/CrashDemo.s.sol` pushes −15% (owner-set test adapter on the fork) → keeper liquidates → per-block CSV of NAV / markApr / IF for 20 blocks → overlay chart. Fallback: pre-recorded testnet run.
