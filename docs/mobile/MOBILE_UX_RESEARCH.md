# MOBILE_UX_RESEARCH: what "professional" means for Meridian's native app

Written Fri 9 Oct 2026 for the Agora "Best Mobile Trading App on Monad" entry. Feeds MOBILE_PLAN §1 (product spec),
§1.3 (UX bar) and phases N3 polish, N4 copy, N5–N8. Owner ask: "fully professional, better than competitors; login as
easy as Privy's Google login; an easy passkey wallet; everything a real phone money app has."

## 0. Method and how much to trust it
- Desk research, 9 Oct: vendor docs (Privy, Coinbase, Phantom, BitMEX, Bybit), the FIDO Alliance passkey design
  guidelines (research-based: yearly usability studies, US consumers 18–70, mobile + desktop, screen-reader users),
  WCAG 2.2, design teardowns and case studies, competitor repos, our own code (N2–N4).
- **Confidence labels:** **[R]** = from research or a standard (FIDO, WCAG). **[V]** = vendor claim or product docs.
  **[A]** = anecdote, student case study or unsourced number (use as a hypothesis only).
- Independent conversion data for crypto onboarding is scarce. Most numbers in circulation are vendor marketing. So the
  plan below leans on standards and on patterns every leading app converges on, not on any single statistic.
- Not done (no time before 13 Oct): hands-on teardown of Bybit / Binance / Phantom / Hyperliquid on a phone, and our own
  usability test. §8 has a 20-minute hallway test to run on Sat with 3 people instead.

## 1. Findings

### 1.1 Login and wallet creation
| # | Finding | Evidence |
|---|---|---|
| L1 | The seed phrase is the drop-off point everyone cites; seedless passkey wallets remove it. Coinbase Smart Wallet (passkey, no seed) reached ~1M accounts. | [A] figures, [V] Coinbase ([teardown](https://www.themasterly.com/blog/crypto-wallet-ux-teardown), [Coinbase](https://help.coinbase.com/en/wallet/getting-started/smart-wallet)) |
| L2 | Activation, not signup, is the real gap: ~5–10 % of self-custody signups transact in month 1 vs ~95 % in fintech. | [A] ([teardown](https://www.themasterly.com/blog/crypto-wallet-ux-teardown)) |
| L3 | Privy's conversion argument is **progressive onboarding**: ask for each step only when it is needed (link more accounts later). | [V] ([Privy docs](https://docs.privy.io/user-management/users/linking-accounts)) |
| L4 | FIDO: put the OS passkey dialog between **handshake messages**: a hero before (symbol + headline + plain message + one CTA), a result after. Users then read site + OS as one trusted flow. | [R] ([FIDO principles](https://www.passkeycentral.org/design-guidelines/principles)) |
| L5 | FIDO tested copy: "Passkeys are encrypted digital keys you create using your fingerprint, face, or passcode" and "With passkeys, you don't need to remember complex passwords". Tie passkeys to things people know (unlocking the phone). | [R] (same) |
| L6 | FIDO: use one complete passkey hero consistently, not a bare "Create passkey" button; keep "what / where" info visible, not behind a tooltip. | [R] (same) |
| L7 | Recovery is the honest weak spot of passkey wallets: device-bound passkeys lose the wallet with the device. Synced passkeys (Google Password Manager, iCloud Keychain) fix most of it. Users must be told where the passkey lives. | [A] first-person test, [V] Coinbase help ([Axios](https://www.axios.com/2024/06/07/crypto-coinbase-wallet-cloud-backup)) |
| L8 | Coinbase Wallet's fast path is splash → biometric → home, with backup offered later. Phantom's text-heavy pre-screens and mid-flow email prompt are its worst moments. | [A] ([teardown](https://www.themasterly.com/blog/crypto-wallet-ux-teardown)) |

### 1.2 Money-app basics (Cash App, Venmo, Payy)
| # | Finding | Evidence |
|---|---|---|
| M1 | Cash App's home is the clarity benchmark: one big balance, two actions, a trust badge. One action per screen in onboarding. | [A] (teardown) |
| M2 | Empty states must give the next step. Phantom's "$0.00 and nothing else" is called out as a failure. | [A] (teardown) |
| M3 | Never expose chain plumbing in a deposit (Payy asks exchange → chain → token with no fee/speed info: its worst flow). | [A] (teardown) |
| M4 | After money moves, say so explicitly. Venmo critique: no success feedback, so users hunt through the list. Fix: a receipt/toast. | [A] ([Pratt critique](https://ixd.prattsi.org/2021/09/design-critique-venmo-ios/)) |
| M5 | Accidental sends are a known pain: bigger, clearly different buttons and a focused confirmation. | [A] ([case study](https://uxdesign.cc/ux-case-study-venmos-pay-request-money-feature-b3499952e41e)) |
| M6 | A transactional numpad is its own component: amount + CTA + suggested amounts on one screen, no OS keyboard to dismiss, locale-correct decimal. | [V] ([Coinbase CDS Numpad](https://cds.coinbase.com/components/inputs/Numpad/)), [A] ([BCH wallet PR](https://reviews.bitcoinabc.org/D20330)) |
| M7 | Confirmation in plain language: what, where, how much, fee. Mask addresses (first/last chars) or name them. Errors name the exact problem and keep what the user typed. | [V] ([Circle](https://developers.circle.com/w3s/docs/confirmation-uis)) |
| M8 | Requiring gas tokens is a major abandonment point (claimed 65 % abandon; 40–80 % completion gain without gas). | [A] (number unverified), direction consistent with every embedded-wallet vendor |

### 1.3 Professional mobile trading
| # | Finding | Evidence |
|---|---|---|
| T1 | Exchange apps converge on: market header → chart (timeframes, indicators, depth) → order book → order panel → positions. | [V] ([Bybit](https://www.bybit.com/fr-FR/help-center/article/Bybit-Trading-Chart-FAQ)) |
| T2 | BitMEX rebuilt its mobile app for perps around "as few clicks and interactions as possible", lighter than desktop, with **swipe to close**. | [V] ([BitMEX](https://www.bitmex.com/blog/site-announcement/new-app-feature-trade-futures-perpetual-contracts-spot-pairs-on-the-go)) |
| T3 | Phantom Perps (wallet-first, closest to us): leverage, SL/TP at entry, **drag SL/TP lines on the chart**, partial close, add/remove margin; positions show PnL, margin, funding, liquidation. | [V] ([Phantom](https://phantom.com/perps), [review](https://www.datawallet.com/de/krypto/phantom-perpetuals-review)) |
| T4 | Robinhood: minimal line chart, live price that animates, colour instead of popups for state. | [A] ([critique](https://ixd.prattsi.org/2025/02/design-critique-robinhood-ios-app/)) |
| T5 | Hyperliquid's own native app is an early Android MVP (Apr 2026). Perp DEXs are still weak on native mobile: that is our opening. | [V]/[A] ([coverage](https://ourcryptotalk.com/news/hyperliquid-launches-mobile-app-on-google-play)) |
| T6 | Charts: Reanimated/Skia-native charts (e.g. `react-native-wagmi-charts`: cursor, tooltip, haptics built in) feel native. TradingView lightweight-charts needs a WebView: heavier, non-native pan/zoom. | [A] (no benchmark found) — **> VERIFY wagmi-charts on Reanimated 4.5 / RN 0.86** |
| T7 | Data exists: Perpl `GET /v1/market-data/:id/candles/:resolution/:from-:to` (≤ 1,024 candles) + our market-data WS; the web app has a candle datafeed (`app/src/features/chart/*`). | our code + api-docs @ 25ab6e2 |

### 1.4 Standards we must not break
- **WCAG 2.5.1 / 2.5.7:** hold-to-confirm and swipe-to-close need a **plain single-tap alternative** (a "Confirm" button
  in the accessibility path, visible button fallbacks on swipe rows). Long-press counts as single-pointer; dragging
  does not. [R] ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/pointer-gestures), [W3C](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements))
- **FIDO passkey patterns** (L4–L6) and accessibility of the passkey steps. [R]

## 2. Competitors (Agora / Monad Metropolis)
| Entry | What they ship | Weak spots | Source |
|---|---|---|---|
| Desk | Native iOS (TestFlight), many features | Testnet only, no video, Perpl-only | MOBILE_PLAN §0.7 |
| Curb | Mobile web, mainnet, Mera two-key, videos | Web, two markets, no users | MOBILE_PLAN §0.7, [repo](https://github.com/emmanuelist/curb/issues/5) |
| Sente | Android native, AI agent mandates | Testnet, never on a phone, AUSD barely used | MOBILE_PLAN §0.7 |
| Takumi Pay | RN + Expo, Mera passkey ("Continue with Face ID / Fingerprint"), AUSD remittances, mainnet, APK, AI agent | Payments, not trading (targets the Agora payments + Mera bounties) | [repo](https://github.com/Planckify-Labs/monad-submission-mobile-app) |
Bounties are judged 40 % on adherence to the written requirements (Curb issue #5) — every "must" stays visible in the
video. **Our edge to make obvious in 10 seconds:** one passkey → wallet + Perpl key; one AUSD balance → two order
books; best price automatically; the funding gap as yield.

## 3. Principles for Meridian (derived)
1. **One tap to a wallet.** Splash → passkey hero → OS sheet → "Wallet ready". No seed, no email, no address shown. (L1, L4, L8)
2. **Progressive, not front-loaded.** Perpl setup, recovery-phrase export and alerts are asked for when they unlock something, never at signup. (L3)
3. **Never ask for gas the user doesn't have.** Perpl orders are gasless; onboarding txs are the only MON need → see §6 decision G1. (M8)
4. **Plain words over chain words.** "Your wallet", "Add AUSD", "Fast orders" — never "approve", "nonce", "chain id" in the main path; hex only in details. (M3, M7)
5. **Every money action: summary → hold (or tap) → fingerprint → receipt.** Explicit success with haptic; specific errors that keep the input. (M4, M5, M7, WCAG)
6. **Pro when wanted, simple by default.** A Lite ticket for first trades; Pro view (chart + both books + depth) one tap away and remembered. (T1–T5)
7. **Live, honest numbers.** Per-block ticks, "—" for unknown, stale dims. (DESIGN.md, already built)
8. **Trust is shown, not claimed.** "Only your fingerprint can move funds", "Your trading key can trade but can never withdraw" (api-docs types.md ScopeMask: withdrawals never permitted via API key). (L7, M1)

## 4. Gap analysis: what we have (N2–N4 code) vs the bar
| Area | Now | Gap | Fix (phase) |
|---|---|---|---|
| Welcome | Live spread + "Continue with fingerprint / face" | No FIDO hero copy, no "where your passkey lives" | P0 copy + hero (N3 polish) |
| Create / unlock | Two buttons (Create / I already have one), progress text | Two choices up front; no after-dialog success moment | One primary "Continue" + small "Use existing passkey"; "Wallet ready ✓" + haptic (N3 polish) |
| Address | Raw address card on Fund | Hex as identity | Identicon + "Wallet ••a3f2", hex in details/copy (N3 polish) |
| Funding | Address, QR, live balances, faucet | No "waiting for deposit…" → arrival moment | Live arrival toast + haptic + balance count-up (N3 polish / N7) |
| Gas | "Add ~0.5 MON" card | Users must source MON | Decision G1 (§6) |
| Perpl setup | 3 checks, resumable (N4) | Copy is ok; asked as a separate screen | Run inline the first time the user trades on Perpl (progressive) (N5) |
| Trade | Ticket + route sheet + hold (N2 shell, no execution yet) | No chart, no book view, no numpad, no SL/TP | Pro/Lite trade screen (N5, §5.3) |
| Positions | Not built | — | Position cards, swipe close + button, liq meter (N5/N7) |
| Receipt | Modal placeholder | — | Receipt with venue, avg price, fee, links + success haptic (N5) |
| Activity | Not built | No history list | Activity tab/list (N7) |
| Home | Portfolio tab placeholder | No single hero balance | Cash-App-style total AUSD hero + 2 actions (N7) |
| Accessibility | Labels, 44 pt, hold has `activate` action | Tap alternative visible? | Keep `activate`; add visible "Tap to confirm instead" in a11y mode (N5) |

## 5. Screen spec (what "professional" means, screen by screen)

### 5.1 First run (target: launch → wallet in ≤ 15 s, 2 taps + fingerprint)
1. **Welcome:** live Meridian vs Perpl funding spread ticking per block (the hook), headline "Trade MON on two order
   books. Earn the gap.", primary **Continue with passkey** (passkey symbol), secondary text link "Use an existing passkey".
2. **Passkey hero (FIDO):** symbol + "Your fingerprint is your wallet" + "Passkeys are encrypted digital keys you create
   using your fingerprint, face, or screen lock. Saved in Google Password Manager, so a new phone signs you back in." →
   **Create my wallet** → OS sheet.
3. **After the sheet:** "Wallet ready ✓" (success haptic, 600 ms), then Home. Never show the address here.
4. Errors: cancelled → stay on hero with "No problem — tap Create when ready" (no red); PRF missing → named fix; no
   network → "You're offline" + retry, input kept.

### 5.2 Home (= Portfolio tab, the first tab)
- Hero: **total AUSD** (wallet + Meridian collateral + equity + Perpl equity), today's PnL, per-block heartbeat dot.
- Two primary actions: **Trade**, **Earn**; small **Add funds**.
- Empty state (0 AUSD): one card "Add AUSD to start" → Add funds; testnet: "Get test funds" with faucet.
- Positions list (cards: side, size, PnL live, liq distance meter), swipe → Close with a visible "Close" button fallback.

### 5.3 Trade (Lite default, Pro toggle remembered)
- **Header:** MON price (per block), 24 h change, both venues' funding APR, next-funding countdown.
- **Chart (Pro, collapsed sparkline in Lite):** line ↔ candles; 1m 5m 15m 1h 4h 1D; scrub with crosshair + selection
  haptic per candle; lines for mark, entry, **liquidation**; live last candle per block. Perpl candles REST + WS; Meridian
  from the indexer / web datafeed.
- **Books (Pro tab):** Meridian and Perpl side by side, the better price highlighted, depth chart; Trades tab.
- **Sticky Long / Short** → bottom sheet ticket: custom numpad (amount in AUSD, presets 25 % / 50 % / MAX), leverage
  slider with detents (1×, 2×, 5×, 10×) and haptics, optional TP/SL (P2), **plain summary** ("Long 120 MON on Perpl ·
  worst price $0.0263 · fee $0.01 · liq $0.0190"), **hold to confirm** (tap alternative) → fingerprint only if the
  session expired → **receipt** (venue, avg price, size, fee, order id / tx, blocks to fill) + success haptic.
- First Perpl trade: the 3 Perpl checks run **inline in the sheet** (progressive), not as a detour.

### 5.4 Earn
- Hero "Earn X % APR on AUSD" (net of fees, live), 24 h sparkline, input on the numpad, "≈ $Y / day", legs preview,
  "No edge right now" state, Lock 30 d (P2), receipt timeline showing both legs. (N6 as planned)

### 5.5 Activity, alerts, settings
- Activity: one merged list (deposits, trades on both venues, funding), each row → receipt. (N7)
- Alerts: liq distance, fills, spread (push; P2).
- Settings: passkey card (FIDO principle 9: "Passkey · Google Password Manager · active"), recovery phrase (fresh
  prompt, screenshot block), Perpl card (N4), network badge, sign out.

### 5.6 Feel
60 fps on UI thread, skeletons not spinners, per-block heartbeat, numbers that tick without layout jumps
(tabular figures), haptics map (DESIGN.md + chart scrub selection ticks + numpad key taps light), safe areas, dark,
44 pt targets, TalkBack labels, reduced-motion respected, cold start to live numbers < 2 s.

## 6. Decisions (owner accepted all three recommendations on 9 Oct; recorded in MOBILE_PLAN §3)
- **G1 Gas for onboarding txs (mainnet):** (a) keep "Add a little MON" with clear copy (no build cost); (b) a capped
  "first-gas drip": our backend sends ~0.05 MON once to a new wallet after its first AUSD deposit arrives (needs a hot
  wallet with MON, rate limit, abuse cap — ~2 h); (c) sponsored txs (paymaster / EIP-7702) — too late for 13 Oct.
  Recommendation: **(a) now, (b) only if Sat has slack.**
- **G2 Chart library:** native (`react-native-wagmi-charts`, needs a new EAS dev build; > VERIFY compatibility) vs
  WebView (lightweight-charts). Recommendation: **native line + scrub first**; candles if the lib works.
- **G3 Pro/Lite default:** Lite default (judges and new users), Pro remembered per device. Recommendation: Lite.

## 7. Priorities against the clock (build window ends Sat 10, go/no-go Sat 12:00)
- **P0 (ship or the entry looks amateur):** one-button passkey flow with FIDO hero + "Wallet ready" (½ h); Home hero
  balance + empty state (1 h); Trade: header + native line chart with scrub/haptics + liq line, Long/Short sheet with
  numpad, plain summary, hold/tap confirm, receipt (N5, ~1 day); inline Perpl setup on first trade (1 h); deposit
  arrival moment (½ h); position card with Close (N5/N7).
- **P1:** candles + timeframes; both books + depth tab; Activity list; Earn as planned; passkey card in Settings.
- **P2 (cut first):** drag TP/SL on chart, TP/SL fields, push alerts, share card, Lock, first-gas drip, partial close.

## 8. 20-minute hallway test (Sat, before the go/no-go)
3 people who don't know the app, on the Android phone, testnet. Tasks: (1) make a wallet, (2) get to a balance,
(3) open a $5 long, (4) close it, (5) find where your passkey is saved. Record: time per task, taps, where they hesitate,
what they say out loud. Fix the top 3 issues before N8. Note results in `docs/outputs/MOBILE_QA.md`.

## Sources
[Privy linking accounts](https://docs.privy.io/user-management/users/linking-accounts) ·
[Privy onboarding](https://www.privy.io/onboarding) ·
[FIDO principles](https://www.passkeycentral.org/design-guidelines/principles) ·
[FIDO guidelines overview](https://www.passkeycentral.org/design-guidelines/) ·
[Crypto wallet UX teardown](https://www.themasterly.com/blog/crypto-wallet-ux-teardown) ·
[Coinbase smart wallet help](https://help.coinbase.com/en/wallet/getting-started/smart-wallet) ·
[Axios on Smart Wallet backup](https://www.axios.com/2024/06/07/crypto-coinbase-wallet-cloud-backup) ·
[Venmo critique (Pratt)](https://ixd.prattsi.org/2021/09/design-critique-venmo-ios/) ·
[Venmo case study](https://uxdesign.cc/ux-case-study-venmos-pay-request-money-feature-b3499952e41e) ·
[Coinbase CDS Numpad](https://cds.coinbase.com/components/inputs/Numpad/) ·
[BCH wallet keypad PR](https://reviews.bitcoinabc.org/D20330) ·
[Circle confirmation UIs](https://developers.circle.com/w3s/docs/confirmation-uis) ·
[Bybit chart FAQ](https://www.bybit.com/fr-FR/help-center/article/Bybit-Trading-Chart-FAQ) ·
[BitMEX mobile](https://www.bitmex.com/blog/site-announcement/new-app-feature-trade-futures-perpetual-contracts-spot-pairs-on-the-go) ·
[Phantom perps](https://phantom.com/perps) ·
[Phantom perps review](https://www.datawallet.com/de/krypto/phantom-perpetuals-review) ·
[The Block on Phantom perps](https://www.theblock.co/post/361533/phantom-wallet-perp-trading-hyperliquid) ·
[Robinhood critique](https://ixd.prattsi.org/2025/02/design-critique-robinhood-ios-app/) ·
[Hyperliquid app launch](https://ourcryptotalk.com/news/hyperliquid-launches-mobile-app-on-google-play) ·
[react-native-wagmi-charts](https://gittrend.io/repo/coinjar/react-native-wagmi-charts) ·
[lightweight-charts vs RN graph](https://stackshare.io/stackups/lightweight-charts-vs-react-native-graph) ·
[WCAG 2.5.1](https://www.w3.org/WAI/WCAG22/Understanding/pointer-gestures) ·
[WCAG 2.5.7](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements) ·
[Takumi Pay](https://github.com/Planckify-Labs/monad-submission-mobile-app) ·
[Curb bounty issue](https://github.com/emmanuelist/curb/issues/5)
