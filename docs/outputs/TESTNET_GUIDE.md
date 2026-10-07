# Try Meridian on Monad testnet (10143)

Everything here is **testnet**: no real money, test tokens only. Collateral is **tAUSD**, a labelled mock of Agora AUSD (6 decimals) at `0x9739682300022676FF867Ad289d20A8fC08566A1`. Contract addresses: [`deployments/10143.json`](../../deployments/10143.json).

## 1. Set up: four taps, no MON
On **https://meridian-testnet.vercel.app/trade** (a phone works best):
1. **Start trading** → log in with your **email** (or Google / a passkey) and enter the code Privy sends you. Privy creates a wallet for you; nothing to install.
2. Tick **I accept the terms and risks** (asked once).
3. **Get 10,000 test AUSD & deposit 1,000**: one tap runs three steps (mint test AUSD, approve, deposit), shown in one sheet with a link to each transaction. **Gas is on us** (Privy gas sponsorship on Monad testnet), so your wallet never needs MON. Test AUSD has no value; the faucet allows one claim per hour per browser. If a step fails, **Retry from here** skips what already went through.
4. The ticket is prefilled with a small market order (≈ $50 notional): **Market long** (or switch to short) → a toast confirms the fill.

The market needs our keeper and market maker running (otherwise the oracle is stale and the book is empty). We announce test hours in our channel.

**Advanced: your own wallet.** "Continue with a wallet" in the same login works with an injected wallet (chain id **10143**, RPC `https://testnet-rpc.monad.xyz`, explorer `https://testnet.monadvision.com`, ARCHITECTURE R29). External wallets are **not** sponsored: get testnet MON at `https://faucet.monad.xyz` (a trade costs ≈ 0.03–0.05 MON; Monad bills the gas limit). The faucet button works for them too; tAUSD is our mock at `0x9739682300022676FF867Ad289d20A8fC08566A1` and its `mint(address,uint256)` is open. Locally: `pnpm --filter @meridian/app dev` with `NEXT_PUBLIC_CHAIN_ID=10143` and a chain data source.

## 2. What to try
| Page | Try | What you should see |
|---|---|---|
| `/trade` | Deposit tAUSD, open a small MON-PERP long or short (≤ 5x), close it | The funding rate and your pending funding move as blocks pass, not once an hour |
| `/positions` | Your position, entry, liquidation price, pending funding | Numbers match the trade |
| `/rates` | The Meridian Funding Index: realized funding APR | 1 h works; 8 h / 24 h stay "—" until the market has 8 h of continuous history |
| `/earn` | Deposit into the basis vault (total cap 1,200 tAUSD), withdraw a little | Instant withdrawals from idle; a bigger exit is a request the keeper fulfils (the request / claim screens are still being built, so this part may need a founder's help) |
| `/fix` | The 30-day funding swap | The book may be empty on testnet (no swap market maker funded yet) |

MON-PERP-DEMO is a separate, labelled **test market** we use to show a crash and a liquidation; don't trade it, its price is moved on purpose.

## 3. Tell us
What confused you, what broke (with the tx hash from the explorer), and whether we may list your address in our hackathon proof. We only record usage you agree to (`docs/outputs/USERS.md`), labelled testnet. No points, no airdrop, no rewards.
