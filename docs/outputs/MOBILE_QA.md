# Mobile QA checklist (C4): run by a founder on real phones

> Paths under `docs/standup/` and `docs/prompts/` cited below are the team's working logs, kept in the private development repository.

Build: production (`pnpm --filter @meridian/app build && start`, or the deployed URL), on the network under test. Fill in one column per device with ✅ / ❌ + a note. A ❌ is a bug on `ws-07*` before Wed 7 Oct.

| # | Check | iOS Safari (model, iOS ver) | Android Chrome (model, ver) |
|---|---|---|---|
| 1 | Add to home screen → opens standalone (no browser bar), icon + name "Meridian" | | |
| 2 | Login (provider per the decision) → address + AUSD balance visible; **time it: < 30 s (US1)** | | |
| 3 | First write shows the terms gate once; after Accept it doesn't ask again | | |
| 4 | Deposit AUSD (one signature + one tx with permit) | | |
| 5 | Open a position (market long), see entry / liq price / funding ticking | | |
| 6 | Close the position (reduce-only) | | |
| 7 | Earn: deposit → share price visible; redeem preview shows path + fee | | |
| 8 | Fix: pay fixed (long) → accrual ticks → close | | |
| 9 | Bottom nav: all 5 tabs reachable with the thumb; active tab highlighted | | |
| 10 | Tap targets ≥ 44 px (no mis-taps on Long/Short, Market/Limit, Deposit) | | |
| 11 | No horizontal scroll on any tab (portrait) | | |
| 12 | Safe areas: nothing under the notch / home indicator; bottom nav clears the home bar | | |
| 13 | Inputs don't zoom the page on focus; pinch-zoom still works | | |
| 14 | "Terms & risks" footer link opens `/terms` | | |
| 15 | Offline / flaky network: app shell loads; errors are readable, no blank screen | | |

Automated coverage (not a substitute): Playwright at 390×844 checks no horizontal scroll + buttons ≥ 44 px on Earn/Fix (`e2e/earn-fix.spec.ts`) and the terms/geo flow (`e2e/terms-geo.spec.ts`); Lighthouse numbers in `docs/standup/C.md`.

## Native app (MOBILE_PLAN N2): Android dev build

Build: EAS `199097cf-2d7e-4291-bca4-7471d2a71dc6` (profile `development`, commit 2b10039, APK, `xyz.meridianfi.app.staging`,
"Meridian Dev"), JS from Metro over LAN (`npx expo start --dev-client`), public testnet RPC (badge shown). iOS: none
(no Apple Developer Program). Phone: > pending (model, Android version).

Legend: ✅ pass · ❌ fail · ⏳ not run yet. "Seen by": **owner** = checked on the phone; **claude** = seen only in a
screenshot / recording or the Metro log.

| # | Check | Result | Seen by | Note |
|---|---|---|---|---|
| N1 | Install from the EAS link; app icon + adaptive icon | ⏳ | | |
| N2 | Splash on #050507, then Welcome (cold start to live numbers) | ⏳ | | |
| N3 | Welcome: block number ticks per block | ⏳ | | |
| N4 | Welcome: Meridian APR / Perpl APR / spread real (or "—") | ⏳ | | |
| N5 | Four tabs switch smoothly; dark theme; safe areas (status bar, gesture bar) | ⏳ | | |
| N6 | Tab headers: both venues' mark + bid/ask, or "No liquidity right now" | ⏳ | | |
| N7 | Sheet opens/closes by gesture (Trade → Compare both books) | ⏳ | | |
| N8 | HoldButton: haptic on start, completes at 600 ms with success haptic, cancels on early release | ⏳ | | |
| N9 | Background 30 s → foreground: resumes, block jumps to the current head | ⏳ | | |
| N10 | Airplane mode → offline banner; back online → banner goes, numbers resume | ⏳ | | |
| N11 | Largest font size: no clipped numbers | ⏳ | | |
| N12 | TalkBack reads labels (spread, buttons, tabs) | ⏳ | | |
| N13 | Settings: "Monad testnet" + "Public RPC" badges, block time, version (development) | ⏳ | | |
| N14 | Hermes smoke: all rows green (numbers below) | ⏳ | | |

Slider detent haptics: no N2 screen uses the Slider yet (the Trade ticket is N5), so they're checked in N5.

### Hermes smoke numbers
> pending

## Native app (MOBILE_PLAN N3): Mera passkey login, Android dev build

Build: EAS `4e91111a-2935-4791-becc-f9ed9cac11aa` (profile `development`, commit 4afa094 on `n3-mera`, APK,
`xyz.meridianfi.app.staging`, signer SHA-256 `23:2F:3C:…:16:B2` = the EAS keystore of 199097cf, checked with
`apksigner`). JS from Metro on :8083 (`APP_ENV=development npx expo start --dev-client --port 8083 --lan`; add
`EXPO_PUBLIC_SHORT_LOCK=1` for row 4). Needs `https://meridian-testnet.vercel.app/.well-known/assetlinks.json` live
(PR meridian#9). Phone: > pending (model, Android version). **Deferred by the owner on 8 Oct: not run yet.**

| # | Check | Result | Seen by | Note |
|---|---|---|---|---|
| P1 | Create → fingerprint → address shown; SecureStore holds only `meridian.passkey.v1.<rpId>` = `{credentialId, transports, createdAt, addressHint}` | ⏳ | | |
| P2 | Kill → reopen → Unlock (auto-prompt) → same address; uninstall → reinstall → "I already have one" → same address | ⏳ | | |
| P3 | Settings → Export recovery phrase → fresh prompt → 24 words; import in MetaMask/Rabby → same address | ⏳ | | |
| P4 | Idle (60 s with SHORT_LOCK, 10 min without) → locked; background > 30 s / > 5 min → locked | ⏳ | | |
| P5 | (if funded) Settings → Dev → "Send 0 MON to myself" → receipt; limit = ceil(estimate × 1.2) | ⏳ | | |
| P6 | Cancel the prompt → "Cancelled. Try again."; airplane mode during unlock → readable error | ⏳ | | |
| P7 | Settings → Dev → "Key derivation: N ms" (core deriveEvmKey on Hermes) | ⏳ | | |

## Native app (MOBILE_PLAN N4b): one-button passkey onboarding, Home hero, deposit arrival, passkey card

Build: same EAS dev build `4e91111a` (no native dependency added in N4b). JS from Metro on :8085 (branch `n4b-ux`,
`APP_ENV=development npx expo start --dev-client --port 8085 --lan`). Passkeys on `meridian-testnet.vercel.app`.
Tick a row only when it was seen on the phone.

| # | Check | Result | Seen by | Note |
|---|---|---|---|---|
| U1 | Fresh install (or Settings → Sign out + clear app data) → stopwatch from launch: Welcome → **Continue with passkey** → hero "Your fingerprint is your wallet" → **Create my wallet** → fingerprint → "Wallet ready ✓" → Home. ≤ 15 s, 2 taps + fingerprint, no address on any of these screens | ⏳ | | time: |
| U2 | Cancel the OS passkey sheet on the hero → muted "No problem — tap Create when ready", no red, no buzz; Create works after | ⏳ | | |
| U3 | Home: identicon + "Wallet ••xxxx", total AUSD, heartbeat; tabs read Home · Trade · Earn · Settings; empty wallet shows "Add AUSD to start" | ⏳ | | |
| U4 | Add funds: QR + full address, Copy (toast), Share (Android share sheet), "Waiting for your deposit…" | ⏳ | | |
| U5 | Testnet AUSD arrives (Get test funds → mint, or a transfer from the K3 wallet with owner OK) → toast "+N AUSD arrived" + success haptic, Home total counts up | ⏳ | | |
| U6 | Settings: passkey card "Passkey · Google Password Manager · active" with where it lives + what sign-out does; Sign out → Welcome → "Use an existing passkey" → same wallet ••xxxx | ⏳ | | |
| U7 | TalkBack on: Welcome buttons, hero, Create, Wallet ready, Home hero + actions, Add funds Copy/Share, passkey card are all read | ⏳ | | |
| U8 | Enable Perpl: "Allow Perpl to use exactly X AUSD" line, tx hashes only under "Details", success toast per step | ⏳ | | |

## Native app (MOBILE_PLAN N5): Trade (Lite / Pro, live chart, both books, numpad ticket, receipt)

Build: same EAS dev build `4e91111a` (no native dependency added in N5). JS from Metro on :8086 (branch `n5-trade`,
`APP_ENV=development CI=1 npx expo start --dev-client --port 8086 --lan`). Testnet; Perpl rows need N4 onboarding
READY (≥ 100 test AUSD on Perpl testnet, MON for gas); Meridian rows need liquidity on Meridian's testnet book (the MM
bot running) or the screen correctly says "No liquidity right now". Tick only what was seen on the phone.

| # | Check | Result | Seen by | Note |
|---|---|---|---|---|
| T1 | Trade tab: price ticks per block, block pulse, 24 h change, both funding APRs, Perpl countdown; Lite sparkline moves | ⏳ | | |
| T2 | Pro: chart with 1m–1D chips; horizontal drag scrubs with one haptic tick per point, smooth (fps: ), label shows price · time; vertical swipe still scrolls; Books show both venues, better price outlined | ⏳ | | |
| T3 | Long $5 (2×) → quote rows show both books after fees, BEST on the cheaper one → summary line → hold (or tap) → receipt with order id / tx, avg price, fee, blocks | ⏳ | | |
| T4 | Position card: live PnL, liq price + distance meter, liq line on the Pro chart; swipe or tap Close → hold → receipt → card gone (flat) | ⏳ | | |
| T5 | T3 + T4 on the other venue (tap its row in the ticket to force it) | ⏳ | | |
| T6 | Kill the app right after confirming → relaunch → unlock → the trade resolves (receipt or "closed before sending"), never stuck | ⏳ | | |
| T7 | Errors keep the input: e.g. 0.5 % slippage in a moving book or an amount above the wallet → specific message, amount still there | ⏳ | | |
| T8 | TalkBack: Long/Short, numpad keys, presets, leverage (adjustable), quote rows (radio), "Or tap here to go long" all read | ⏳ | | |
| T9 | Pro → tap "Candles": candles drawn (green up / red down), the last one moves each block; drag = label "O … H … L … C … · time" with a haptic per candle; switch timeframe chips; kill + relaunch → still Candles | ⏳ | | |
| T10 | Pro → tap "Trades": rows from both venues newest first (dot + name, Buy/Sell, price, size, block); place a $5 trade on each venue → your fills appear within a few blocks; an idle venue says "no trades …" instead of fake rows; kill + relaunch → still Trades | ⏳ | | |

## Native app (MOBILE_PLAN N6): Earn (two-leg basis, auto-unwind, resume, receipt timeline)

Build: same EAS dev build `4e91111a` (**no native dependency added in N6**: Switch is core React Native). JS from Metro on
:8087 (branch `n6-earn`, `git fetch origin && git switch n6-earn && pnpm install --frozen-lockfile && cd mobile &&
APP_ENV=development CI=1 npx expo start --dev-client --port 8087 --lan`). Testnet; needs N4 Perpl onboarding READY,
test AUSD in the wallet for BOTH venues (Meridian's mock AUSD and Perpl's collateral token differ on testnet; "Get test
funds" on Home), a little MON for gas, and liquidity on both books (the MM bot running on Meridian). Record order ids /
tx hashes in PROOF.md. Tick only what was seen on the phone.

| # | Check (exact taps) | Result | Seen by | Note |
|---|---|---|---|---|
| E1 | Earn tab: hero "X % APR on AUSD" ticks per block (block pulse), sparkline drawn with "Gap over the last 24 h" (or "since you opened Earn" if the RPC can't read old blocks — note which), explainer 3 steps. If the gap doesn't cover fees: "No edge right now" + "Perpl's next funding in …" counting down | ⏳ | | |
| E2 | Open $10: tap `1` `0` → "≈ $… / day" + "Long/Short N MON on Perpl · Short/Long N MON on Meridian" + "Adds … AUSD to … first" (if a venue is short) → hold "Hold to start earning" (or tap "Or tap here to start earning") → fingerprint (only if a top-up is needed) → receipt "You're earning the gap", timeline: Collateral ✓, Perpl Filled + order #, Meridian Filled + "View on the explorer" opens the tx; success haptic once | ⏳ | | |
| E3 | Back on Earn: "Your Earn position · N MON each side"; Trade tab shows both positions with equal size, opposite sides | ⏳ | | |
| E4 | Close: tap "Close" → summary "Close N MON on Meridian first…" → hold "Hold to close both legs" → receipt "Closed on both venues"; Trade tab: flat on both venues; success haptic once | ⏳ | | |
| E5 | Dev flag forced failure: on Earn switch on "Dev: force the Meridian leg to fail" → tap `1` `0` → hold → receipt "Undone automatically", timeline: Perpl Filled, Meridian "Didn't fill · Dev flag: …", "Undo: sell N MON on Perpl" Filled; Trade tab: flat on Perpl; NO success haptic. Switch the flag off after | ⏳ | | |
| E6 | Kill mid-trade: tap `1` `0` → hold → as soon as "Opening your position…" shows, swipe the app away from Recents → relaunch → unlock → within ~20 s the run finishes on its own and Earn shows "Finished after the app reopened: …" → tap "See the receipt" (timeline complete) and Trade shows matching sizes on both venues (or flat) — never one-sided without the orange "Action needed" card | ⏳ | | |
| E7 | Errors keep the input: tap `9` `9` `9` `9` (more than the wallet) → "You need … more AUSD …" + Add funds; confirm stays disabled; the amount stays | ⏳ | | |
| E8 | TalkBack: hero APR, numpad keys, presets, "Or tap here to start earning", timeline rows ("Step 2: Long … Filled …") all read | ⏳ | | |
