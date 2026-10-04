# Get started with Pulse (Monad mainnet)

> Status: **draft**. Pulse isn't on mainnet yet (deploy target: Sat 10 Oct 2026). Items marked `> VERIFY` must be checked against the linked official source before this guide is shared. The app URL and contract addresses come from `deployments/143.json` once A commits it.

Pulse runs on **Monad mainnet (chain id 143)**. Everything is settled in **AUSD** (Agora Dollar, 6 decimals, token `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`, ARCHITECTURE R9). You need:
- **MON** for gas. Monad charges the gas *limit*, so keep a small buffer (the app sets each limit to estimate × 1.2).
- **AUSD** for collateral, vault deposits and swap margin.

## 1. Get MON and AUSD on Monad
| Need | Where | Status |
|---|---|---|
| A wallet on Monad | The app's login (provider per the Privy-vs-Mera decision) or any EVM wallet with Monad (chain id 143) added | Login provider: > VERIFY after the decision (BOUNTY_MAP) |
| MON | An exchange that supports MON withdrawals on the Monad network, or a bridge to Monad | > VERIFY: list only exchanges/bridges whose own docs confirm Monad mainnet MON withdrawals/deposits |
| AUSD | Agora (issuer), or swap USDC → AUSD on Kuru (AUSD/USDC market, ARCHITECTURE R19b) or via Kuru Flow | > VERIFY: Agora's official mint/redeem access for retail; Kuru app URL and current AUSD/USDC depth before recommending sizes |
| Explorer (to check your txs) | Monad mainnet explorer | > VERIFY: official mainnet explorer URL (docs.monad.xyz) |

Start small. Launch caps limit positions (25k MON per account at launch) and the vault's deposit cap is deliberately low.

## 2. Three things you can do (≤ 6 steps each)
### Trade: MON-PERP with per-block funding
1. Open the app → **Trade** tab → log in.
2. Accept the terms (asked once, before your first transaction).
3. Enter an AUSD amount → **Deposit AUSD** (one signature with permit, then one transaction).
4. Choose **Long** or **Short**, market or limit, and a size → submit.
5. Watch **Positions**: entry, liquidation price and funding that changes every block.
6. **Close** (reduce-only market order) → withdraw AUSD when flat.

### Earn: the basis vault
1. **Earn** tab → read the vault state (hedged or waiting for funding, share price, deposit capacity).
2. Enter AUSD → **Deposit** (permit + one transaction). You receive vault shares.
3. Your share price moves with the funding the vault earns (it can also go down).
4. **Redeem** any time. There is a 5 bps fee that stays with the other holders. If the vault's idle cash doesn't cover your withdrawal, it needs an unwind: that costs extra, or the withdrawal may have to wait until the keeper unwinds.

### Fix: lock a funding rate for 30 days
1. **Fix** tab → deposit swap margin (AUSD).
2. **Pay fixed** (you receive the floating per-block funding, pay the fixed APR) or **Receive fixed**, market or limit, at the book's APR.
3. Your accrual (floating − fixed) settles every block until maturity.
4. **Close** before maturity or hold to maturity; then withdraw your margin.

## 3. Risks (read before you deposit)
Leverage can liquidate your whole collateral; funding can move against you every block; oracle, market-depth and smart-contract risks apply; the vault and swaps can lose money; the contracts are not upgradeable and **have not been externally audited** (internal review: `docs/outputs/SECURITY_REVIEW.md`). The full text is in the app at **/terms**.

## 4. Support
> VERIFY: support channel (Discord thread / Telegram group). The founders set it; it must be the same one as in `/terms` §8.
