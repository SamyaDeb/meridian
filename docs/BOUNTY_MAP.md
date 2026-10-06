# BOUNTY_MAP

Rule: **no feature is built only for a bounty.** We claim a bounty only when the core product already satisfies it.
Source: monad.xyz/metropolis (29 Sep 2026). Detailed criteria are behind the platform login. Founder C pastes them verbatim here on Day 1 (TEAM_PLAN §6 #1).

| Bounty | Prize | Decision | What satisfies it (from core product) | Owner | Open question |
|---|---|---|---|---|---|
| **Track 01 Onchain Finance & Trading** | $10k × top 3 | **Primary** | Per-block funding perp on a fully onchain CLOB (both are the track's own example ideas) + funding oracle + basis vault + funding swaps, live on mainnet | all | Paste the rubric |
| **Grand Champion** | $25k | Automatic | Same + real users/fees + benchmark report | all | — |
| Agora: Best Mobile Trading App on Monad | $10k | **Dropped (4 Oct), unless the official text differs** | Only the AUSD part fits. The reported requirement (see "Agora requirement" below) also needs Mera login and trades executed through **Perpl**; routing trades to Perpl would be a feature built only for this bounty (rule above) and new scope after the 30 Sep freeze | C | HUMAN: confirm the official text at hackathon.monad.xyz; if it doesn't require Perpl, reopen |
| Envio: Best Use of Envio | $1k (+ $5k hosting for track winners) | **Claim** | HyperIndex powers the funding ticker/history, oracle APR, positions, vault NAV, swap book | C | — |
| Privy | $5k | Claim **only if** Privy is our single login | Email login + embedded wallet on Monad; permit-based one-signature deposit | C | Pick Privy vs Mera by Day 2 (never both) |
| Mera bounties ("Best Mera-Powered UX", "One Passkey, Many Keys") | $2.5k × 2 (public page, 29 Sep) | Claim **only if** Mera is our single login | Passkey account → trade in 2 taps | C | Same decision as above |
| Chainlink: Best workflow with CRE | $3k | **Dropped** (Phase 4: no deploy access, PRD §8 cut order) | CRE cron → vault rebalance; log trigger → liquidation scan; onchain `MeridianKeeperReceiver` | B | Deploy access is gated |
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

## Agora requirement (found 4 Oct 2026; UNVERIFIED, third-party source)
The official text is behind the login. Another team targeting the same bounty quotes it in a public issue ([emmanuelist/curb#49](https://github.com/emmanuelist/curb/issues/49)):
> "a mobile application that authenticates users via Mera, holds and displays a stablecoin balance in AUSD, and executes trades through Perpl", judged on "implementation quality, UX, and 'creative use of the three integrations together'".

The same team's [curb#5](https://github.com/emmanuelist/curb/issues/5) says bounties are scored 40% on "adherence to the published bounty requirements" (Rules §5.2).

| Requirement | Meridian | Gap |
|---|---|---|
| Mobile application | Installable PWA (phone-first) | Eligibility unconfirmed. Other entrants: [Desk](https://github.com/frankolien/desk) native iOS, [Sente](https://github.com/IpastorSan/sente-monad-hackathon) native Android; [Polaris](https://github.com/nickthelegend/polaris-monad) (Agora payments bounty) ships a PWA and is also asking Agora |
| Mera login | Undecided (injected + dev wallet) | Would need the Mera login |
| AUSD balance | ✅ AUSD is the only collateral/quote | — |
| Trades through Perpl | ❌ trades execute on our own onchain CLOB | A Perpl trade path is outside the product thesis |

**Decision (4 Oct): drop Agora.** The Perpl requirement fails the "no feature only for a bounty" rule, and a native wrapper (Capacitor, ~1–2 days + Apple review) would not close that gap. Reopen only if a founder confirms the official text doesn't require Perpl; then the cheapest path is Mera login + Capacitor wrapper of the existing PWA.

## Field check (4 Oct 2026, public GitHub only; private repos are invisible until submission)
| Project | Overlap | What it has | What it lacks vs Meridian |
|---|---|---|---|
| [FluxState](https://github.com/4GuptaArpit/FLUXSTATE) | **Direct** on Track 01 "Perpetuals with funding that updates every block" | Per-block cumulative funding perp, Pyth oracle, LP/insurance vault, keeper, Next.js terminal; testnet only; 1 contributor, JS tests | No onchain CLOB mentioned, no public funding-rate oracle, no delta-neutral basis vault, no fixed-rate funding swaps, no mainnet |
| [Spillway](https://github.com/resistingdestiny/spillway) | Adjacent | Cover vault between a perp's insurance fund and ADL, priced from Perpl; started 2 Oct | Different product |
| Desk / Sente / curb | Agora bounty (Perpl front ends) | Native mobile + Mera + Perpl | Not a protocol |

**Positioning for the write-up, demo and judging** (claims only from PRD §7.1 with evidence):
1. Fully onchain CLOB **and** per-block funding: both of Track 01's example ideas in one product.
2. The full funding-rate layer: perp → public funding oracle → basis vault (floating) → funding swaps (fixed). No other public entry has the oracle or yield layers.
3. Live on mainnet with external users and fees (G5), where competitors are testnet only.
4. Evidence depth: Foundry unit/fuzz/invariant suites (379 tests, I1–I11), gas benchmarks (B1–B7), two cross-reviews.
Expect several more per-block-funding perps: Track 01 lists the idea itself, so lead with 1–3, not with per-block funding alone.

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

## Login decision (Privy vs Mera), due Day 2 (Wed 30 Sep), STILL OPEN on 4 Oct
Rule: if Agora requires Mera → **Mera**. If Agora requires a native app → drop Agora and choose **Privy** (more mature, email + embedded wallet). Otherwise → **Privy**, unless the Mera blocks reward something we'd build anyway (passkey → trade in 2 taps). Record the decision here and in `docs/standup/C.md`.

**Update 4 Oct:** Agora is dropped (Perpl requirement, above), so Agora no longer forces Mera. By the rule this points to **Privy** ($5k, one bounty) vs Mera (2 × $2.5k, both need the Mera blocks pasted). **Lead's recommendation: Privy**, decided by the owner no later than Mon 5 Oct so C can wire it before mainnet day; the fallback (Sat 3 Oct) has passed, so without a decision the app ships with the injected wallet and neither login bounty is claimed.
