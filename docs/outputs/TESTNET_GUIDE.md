# Try Meridian on Monad testnet (10143)

Everything here is **testnet**: no real money, test tokens only. Collateral is **tAUSD**, a labelled mock of Agora AUSD (6 decimals) at `0x9739682300022676FF867Ad289d20A8fC08566A1`. Contract addresses: [`deployments/10143.json`](../../deployments/10143.json).

## 1. Set up: four taps, no MON
On **https://meridian-testnet.vercel.app/trade** (a phone works best):
1. **Start trading** → log in with your **email** (or Google / a passkey) and enter the code Privy sends you. Privy creates a wallet for you; nothing to install.
2. Tick **I accept the terms and risks** (asked once).
3. **Get 10,000 test AUSD & deposit 1,000**: one tap runs three steps (mint test AUSD, approve, deposit), shown in one sheet with a link to each transaction. **Gas is on us** (Privy gas sponsorship on Monad testnet), so your wallet never needs MON. Test AUSD has no value; the faucet allows one claim per hour per browser. If a step fails, **Retry from here** skips what already went through.
4. The ticket is prefilled with a small market order (≈ $50 notional): **Market long** (or switch to short) → a toast confirms the fill.

Measured on testnet with a fresh Privy user: 5 taps (Privy's email **Submit** counts as one) and 22.6 s from landing to a filled order, 0 MON before and after (PROOF §10).

The market needs our keeper and market maker running (otherwise the oracle is stale and the book is empty). We announce test hours in our channel.

**Advanced: your own wallet.** "Continue with a wallet" in the same login works with an injected wallet (chain id **10143**, RPC `https://testnet-rpc.monad.xyz`, explorer `https://testnet.monadvision.com`, ARCHITECTURE R29). External wallets are **not** sponsored: get testnet MON at `https://faucet.monad.xyz` (a trade costs ≈ 0.03–0.05 MON; Monad bills the gas limit). The faucet button works for them too; tAUSD is our mock at `0x9739682300022676FF867Ad289d20A8fC08566A1` and its `mint(address,uint256)` is open. Locally: `pnpm --filter @meridian/app dev` with `NEXT_PUBLIC_CHAIN_ID=10143` and a chain data source.

## 2. What to try
| Page | Try | What you should see |
|---|---|---|
| `/trade` | Deposit tAUSD, open a small MON-PERP long or short (≤ 5x), close it | The funding rate and your pending funding move as blocks pass, not once an hour |
| `/positions` | Your position, entry, liquidation price, pending funding | Numbers match the trade |
| `/rates` | The Meridian Funding Index: realized funding APR; Meridian vs Perpl funding; Risk: the liquidation price and distance of a Meridian or Perpl position | 1 h works; 8 h / 24 h stay "—" until the market has 8 h of continuous history |
| `/earn` | Deposit into the basis vault (total cap 1,200 tAUSD), withdraw a little, then try a withdrawal larger than the vault's idle AUSD | Withdrawals up to idle are instant. A bigger one is a **request**: "Your withdrawal requests" shows it as Requested with its place in the queue and an estimate at today's share price. The keeper fulfils it (priced then, minus the 5 bps fee and its share of the unwind cost), it turns **Fulfilled · claim**, and **Claim** pays you. **Cancel** works while it waits. Requests are fulfilled only while our keeper runs (test hours) |
| `/fix` | The 30-day funding swap: lock a fixed funding rate | The book is live only while our swap market maker runs (announced hours); otherwise it is empty |
| `/stats` | Users, trades, volume (our market maker's share shown), swaps, vault, withdrawal queue, liquidations | Each number is from our indexer, "as of block N"; our own accounts are excluded |

**ETH-PERP** (switcher at the top of `/trade`) is a second testnet market with its own book and funding. Its price comes from Pyth ETH/USD, pushed onchain by our keeper (labelled "testnet"); it only moves while that keeper runs. Your margin is per market: deposit into ETH-PERP separately. Minimum size 0.001 ETH.

MON-PERP-DEMO is a separate, labelled **test market** we use to show a crash and a liquidation; don't trade it, its price is moved on purpose.

## 3. Tell us
What confused you, what broke (with the tx hash from the explorer), and whether we may list your address in our hackathon proof. We only record usage you agree to (`docs/outputs/USERS.md`), labelled testnet. No points, no airdrop, no rewards.

Where: > VERIFY: owner picks the channel (GitHub issues on `SamyaDeb/meridian` once the repo is public, or a Discord channel). Send the screen, what you tapped, what you expected, a screenshot and your wallet address (Account menu → copy). Never send your email code, a private key or a seed phrase. We never ask for them.

---

## 4. Owner: make production tester-ready
Production must be **public**. Previews sit behind Vercel Authentication, so judges can't open them. Set these in Vercel → Project → Settings → Environment Variables (Production), redeploy, then open `https://meridian-testnet.vercel.app/api/health`. It returns booleans only, never values, and `ready` must be `true`.

| Variable | Needed | Why |
|---|---|---|
| `NEXT_PUBLIC_DATA_SOURCE=chain` | required | chain data instead of the mock layer |
| `NEXT_PUBLIC_CHAIN_ID=10143` | required | Monad testnet |
| `NEXT_PUBLIC_PRIVY_APP_ID` | required | login, embedded wallets, sponsored gas |
| `NEXT_PUBLIC_INDEXER_URL` | required | history, Earn queue, Stats. **Must be the hosted K2 indexer for the current deployment.** The URL used in local builds so far (`indexer.dev.hyperindex.xyz/…`) serves the **old v1 deployment** (ClearingHouse `0x4c5f…802f`, vault `0x067F…19CC`, start block 66,875,788; checked 8 Oct), not the current one in `deployments/10143.json` (CH `0x1F90…a6eA`, vault `0xe8b3…92E6`) |
| `NEXT_PUBLIC_MONAD_TESTNET_RPC_URL` | required | browser reads. Production today uses the public `testnet-rpc.monad.xyz`, which **answered HTTP 429 to a single viewer** on `/trade`, `/rates` and `/earn` (prod smoke, 8 Oct). Use an app-only endpoint restricted to the production domain (it ships to the browser, so it must not carry a key that can do anything else) |
| `NEXT_PUBLIC_MFI_URL` | optional | `/rates`: the MFI service |
| `MONAD_TESTNET_RPC_URL`, `MONAD_RPC_URL` | optional, **server-only** | Rates & Risk Perpl routes (PR #3) |
| `NEXT_PUBLIC_PERPL_REFERENCE`, `NEXT_PUBLIC_ALERTS_CHANNEL_URL` | optional | Rates & Risk (PR #3) |
| `NEXT_PUBLIC_SITE_URL` | optional | share links, OG image |
| `NEXT_PUBLIC_SPONSOR_GAS` | leave unset | sponsorship on; `0` turns it off |
| `NEXT_PUBLIC_DEV_ACCOUNT`, `NEXT_PUBLIC_DEPLOYMENT_OVERRIDE` | **must be unset** | dev-only; `/api/health` says `ready: false` if a dev account is set |

The list comes from `grep -rhoE "process\.env\.[A-Z_]+" app/src | sort -u` on main plus PR #3. Re-run it after #3 merges. Production on 8 Oct: public, an older build (no `/api/health`, no Earn queue, no Stats metrics yet), pages render with the Privy **Log in**, `/fix` clean, `/trade` `/rates` `/earn` logged 429s from the public RPC. Then run the read-only smoke from `app/`: `APP_URL=https://meridian-testnet.vercel.app npx playwright test e2e/prod-smoke.spec.ts`. It checks `/api/health`, then `/trade`, `/rates`, `/earn`, `/fix` and `/stats`: each must render chain data, show no console errors and show the Privy **Log in**. Keep Privy's TEE wallets and Monad Testnet gas sponsorship enabled in the Dashboard (K1).

## 5. Owner: MON budget for the tester window (Thu 8 – Mon 12 Oct)
Bots pay testnet MON for every transaction, and Monad bills the **gas limit**. Rates are at 102 gwei, measured on 10143 unless marked projected.

| Bot (cheapest config that keeps the perp book two-sided) | MON/h | Source |
|---|---:|---|
| main keeper (`KEEPER_PK`): funding pokes every ≤ 20 blocks, oracle pushes, liquidations, vault rebalance and **redeem fulfilment** | 9.8 | RUNBOOK §5 table (incl. vault txs) |
| perp MM: `LEVELS=1 LOTS_PER_LEVEL=30 REQUOTE_BPS=10 TICK_EVERY_BLOCKS=3` | 2.5 | RUNBOOK §5 table |
| perp MM with the Perpl hedge on (K3; quotes both sides, so twice the txs) | 7.95 vs 4.1 off | 7 Oct K3 run, `gasLimitSum` × 102 gwei, `LEVELS=1`, default requote |
| flow: house IOC trades so the chart prints candles (optional) | 1.3 | RUNBOOK §2b, 6 Oct |
| swap MM: `MARKET=swap LEVELS=1 REQUOTE_BPS=1000 TICK_EVERY_BLOCKS=33` | ≈ 24 **projected** | RUNBOOK §4 fork table ÷ 2 levels; measure 10 min on testnet first and write it in RUNBOOK |
| CRE W3 MFI publisher every 5 min (optional) | 0.36 | RUNBOOK §4e |

Without the keeper the oracle goes stale and the MM pulls its quotes, so the book empties. Keeper + perp MM is the floor, **≈ 12.3 MON/h**. Always on for 96 h that would be ≈ 1,180 MON. So the book opens in announced windows:

| Plan | Book hours | Keeper + perp MM | Swap MM (Fix) | Total |
|---|---|---:|---:|---:|
| **A (recommended):** 2 × 2 h per day Fri–Mon + Thu evening 2 h = 18 h; swap MM 1 h per day (4 h) | 18 (+4 swap) | ≈ 221 | ≈ 96 | **≈ 317 MON** |
| B: 1 × 2 h per day Fri–Mon + Thu 2 h = 10 h; swap MM 30 min per day | 10 (+2 swap) | ≈ 123 | ≈ 48 | **≈ 171 MON** |
| C: judges only: 2 × 1 h on Mon 12 + the demo recording Sun 11 (2 h) | 4 (+1 swap) | ≈ 49 | ≈ 24 | **≈ 73 MON** |

Add ≈ 10% margin, and swap collateral for the swap MM key (`FundingSwapMarket.depositFor(mm, …)`, tAUSD, free). Balances on 8 Oct: main keeper and main MM < 0.003 MON, CRE wallet 0.84, deployer 2.21. **OWNER:** fund, then post the window times in the message below. Earn requests are fulfilled in the next window (the keeper does it); tell testers.

## 6. Outreach message (Monad Discord / X)
Every claim is backed by PROOF (`docs/outputs/PROOF.md`) or a test.

> Meridian is a perp on Monad testnet with a fully onchain order book. Funding settles **every block**, not every 8 hours. Log in with your email, get test AUSD and fill your first order in about 20 seconds, with no MON needed (gas is sponsored). Also live: a basis vault with a withdrawal queue, funding swaps that lock a fixed rate, and a Rates & Risk screen that compares our funding with Perpl's. Testnet only: test tokens, nothing of value, no points, no airdrop.
> Book open (UTC): <windows>. App: https://meridian-testnet.vercel.app. Bugs and feedback: <channel>.
