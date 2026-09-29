# BOUNTY_MAP

Rule: **no feature is built only for a bounty.** We claim a bounty only when the core product already satisfies it.
Source: monad.xyz/metropolis (29 Sep 2026). Detailed criteria are behind the platform login. Founder C pastes them verbatim here on Day 1 (TEAM_PLAN §6 #1).

| Bounty | Prize | Decision | What satisfies it (from core product) | Owner | Open question |
|---|---|---|---|---|---|
| **Track 01 Onchain Finance & Trading** | $10k × top 3 | **Primary** | Per-block funding perp on a fully onchain CLOB (both are the track's own example ideas) + funding oracle + basis vault + funding swaps, live on mainnet | all | Paste the rubric |
| **Grand Champion** | $25k | Automatic | Same + real users/fees + benchmark report | all | — |
| Agora: Best Mobile Trading App on Monad | $10k | **Claim if a PWA qualifies** | AUSD is the only collateral/quote across perp, vault and swaps; phone-first PWA | C | Does it require Mera and/or native? Other entrants use Mera + native iOS |
| Envio: Best Use of Envio | $1k (+ $5k hosting for track winners) | **Claim** | HyperIndex powers the funding ticker/history, oracle APR, positions, vault NAV, swap book | C | — |
| Privy | $5k | Claim **only if** Privy is our single login | Email login + embedded wallet on Monad; permit-based one-signature deposit | C | Pick Privy vs Mera by Day 2 (never both) |
| Mera bounties ("Best Mera-Powered UX", "One Passkey, Many Keys") | $2.5k × 2 (public page, 29 Sep) | Claim **only if** Mera is our single login | Passkey account → trade in 2 taps | C | Same decision as above |
| Chainlink: Best workflow with CRE | $3k | **Should**, only if deploy access by Day 7 | CRE cron → vault rebalance; log trigger → liquidation scan; onchain `PulseKeeperReceiver` | B | Deploy access is gated |
| Kuru: Consumer Trading App on Kuru | $5k | Claim only if Kuru confirms | Vault's spot leg executes via Kuru Flow / Kuru CLOB | C asks, B builds | Does vault routing count? |
| Kuru: New Assets and Markets | $5k | **Not targeted** | (A PT listing needs Kuru's owner; PT deferred) | — | — |
| Aurora Intents | $5k | Stretch only | Any-chain deposit → AUSD → vault | C | Only after CP3 if everything is green |
| Dynamic / Nansen / Perpl / Cleanverse | — | Not targeted | — | — | — |

Before submitting, for each claimed bounty: [ ] criteria re-read · [ ] required tags/links in the write-up · [ ] sponsor form · [ ] demo timestamp for that sponsor's feature.

## Public listing check (29 Sep 2026, monad.xyz/metropolis, no login)
- Track 01: "$30,000 evenly split among 3 teams". Best fit: "Teams who have shipped a trading, lending, or market-making product before". Example ideas include "Fully onchain order books that do not need an offchain matching engine" and "Perpetuals with funding that updates every block" (both are our core).
- Agora: "Best Mobile Trading App on Monad" $10k (also "Best Cross-Border Payments App on Monad" $10k, not targeted). **The public page doesn't say whether Mera or a native app is required.**
- Mera: "Best Mera-Powered UX" $2.5k, "One Passkey, Many Keys" $2.5k. Envio: "Best Use of Envio" $1k. Privy: "Privy!" $5k. Chainlink: "Best workflow with CRE" $3k. Kuru: "Build the Next Consumer Trading App" $5k, "Bring New Assets and Markets to Kuru" $5k.
- Detailed judging criteria require logging in at hackathon.monad.xyz (GitHub/Google/Discord). An agent can't read them.
- Money signal for the login decision: Privy $5k vs Mera 2 × $2.5k = $5k. It's a tie, so **the Agora $10k requirement decides it**.

## Verbatim criteria (HUMAN: log in at hackathon.monad.xyz and paste each block exactly, including the submission requirements)
> Owner: Founder C. Due: Wed 30 Sep 09:30 (the login decision depends on the Agora and Mera blocks).

### Track 01: Onchain Finance & Trading
```
<paste verbatim: judging criteria, weights, submission requirements>
```
### Agora: Best Mobile Trading App on Monad
```
<paste verbatim. Answer: native app required? Mera required? AUSD required? PWA allowed?>
```
### Mera: Best Mera-Powered UX
```
<paste verbatim>
```
### Mera: One Passkey, Many Keys
```
<paste verbatim>
```
### Envio: Best Use of Envio
```
<paste verbatim: HyperIndex vs HyperSync, hosted requirement?>
```
### Privy
```
<paste verbatim: does it exclude other auth SDKs?>
```
### Chainlink: Best workflow with CRE
```
<paste verbatim: deployed workflow required, or is simulation OK?>
```
### Kuru: Build the Next Consumer Trading App
```
<paste verbatim: does routing via Kuru Flow count?>
```

## Login decision (Privy vs Mera), due Day 2 (Wed 30 Sep)
Rule: if Agora requires Mera → **Mera**. If Agora requires a native app → drop Agora and choose **Privy** (more mature, email + embedded wallet). Otherwise → **Privy**, unless the Mera blocks reward something we'd build anyway (passkey → trade in 2 taps). Record the decision here and in `docs/standup/C.md`.
