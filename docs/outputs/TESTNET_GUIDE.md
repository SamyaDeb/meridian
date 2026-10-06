# Try Meridian on Monad testnet (10143)

Everything here is **testnet**: no real money, test tokens only. Collateral is **tAUSD**, a labelled mock of Agora AUSD (6 decimals) at `0x9739682300022676FF867Ad289d20A8fC08566A1`. Contract addresses: [`deployments/10143.json`](../../deployments/10143.json).

## 1. Set up
1. **Wallet on Monad testnet:** chain id **10143**, RPC `https://testnet-rpc.monad.xyz`, explorer `https://testnet.monadvision.com` (ARCHITECTURE R29).
2. **Testnet MON for gas:** `https://faucet.monad.xyz` (ARCHITECTURE R29). A trade costs about 0.03–0.05 testnet MON (Monad bills the gas limit; ≈ 300–500k gas at ≈ 102 gwei).
3. **tAUSD:** ask in our channel and a founder mints it to your address (`cast send 0x9739682300022676FF867Ad289d20A8fC08566A1 "mint(address,uint256)" <you> 100000000` = 100 tAUSD). The mock's `mint` is open, so you can run the same command yourself with your own key; the explorer has no verified ABI for it yet.
4. **App:** **https://meridian-testnet.vercel.app** (testnet build: `NEXT_PUBLIC_CHAIN_ID=10143`, chain data source, public testnet RPC; connect an injected wallet). Locally: `pnpm --filter @meridian/app dev` with the same env.
5. **Before you try:** the market needs our keeper and market maker running (otherwise the oracle is stale and the book is empty). We announce test hours in our channel.

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
