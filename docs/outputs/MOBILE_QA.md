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
| E9 | Lock: tap `1` `0` → "Lock needs at least 1,000 MON…" and the switch is off/disabled; tap ⌫ ⌫ then an amount ≥ ~1,000 MON per side (e.g. `8` `0` at ~$0.026) → "Receive X % fixed … until <date>" → switch on → "Adds … AUSD to the fixed-rate market" → hold → receipt with a 4th row "Lock: receive a fixed rate…" Filled at X % and "Meridian's funding is fixed at …"; Close → "Close the fixed-rate lock first…" → hold → first row "First: close the fixed-rate lock" Filled, then both legs → flat; swap position 0 | ⏳ | | |

## Native app (MOBILE_PLAN N7): Home portfolio, Activity, Settings

Build: same EAS dev build `4e91111a` (no native dependency added in N7 or the N6 + N7 integration). JS from Metro on
:8088 (branch `n7-home`; H10–H12 and the integrated build: branch `n67-integrate`,
`APP_ENV=development CI=1 npx expo start --dev-client --port 8088 --lan`). Testnet, with open positions from the N5
rows (T3–T5). Optional: `EXPO_PUBLIC_INDEXER_URL=<Envio testnet GraphQL URL>` in `mobile/.env.local` for Meridian
history (without it, Activity shows this app's trades + Perpl and says so). Tick only what was seen on the phone;
screenshots go next to the row.

| # | Check (owner's taps) | Result | Seen by | Note |
|---|---|---|---|---|
| H1 | Home → read the total → tap **See breakdown** → screenshot the sheet (Wallet / Meridian account / Perpl account / Total). Then Perpl's own UI (testnet.perpl.xyz, same wallet) → screenshot its account value; Meridian web terminal (Settings → **Open full terminal**) → screenshot its account equity. Each part matches its venue's own number (± the moves of the blocks between screenshots), Total = their sum | ⏳ | | |
| H2 | With a position open: **Open PnL** next to the total and each card's PnL change with the block pulse (watch ~10 s) | ⏳ | | |
| H3 | Close from Home: tap the visible **Close** on a card (or swipe it left) → summary sheet → hold (or tap) → receipt → back on Home the card is gone and the total moved by about the PnL | ⏳ | | |
| H4 | Home → **See all** (Activity): the N4 Perpl deposit, the N5 opens/closes on both venues are listed newest first; tap a trade → its receipt (avg price, fee, order id / tx link); tap the deposit → detail with amount + explorer link; pull down → refreshes | ⏳ | | |
| H5 | Settings → **Alerts**: both off at first; turn on "Close to liquidation" → no Android permission prompt; with a high-leverage test position near its liq price the red toast + buzz appears once | ⏳ | | |
| H6 | Settings: passkey card, wallet ••xxxx + Copy, Export recovery phrase, Perpl card, network badge, **Open full terminal** opens the testnet web app in the browser, Sign out (confirm) | ⏳ | | |
| H7 | TalkBack: hero total, See breakdown, Open PnL, card Close buttons, Activity rows ("Long 600 MON on Perpl, 5 min ago"), alert switches are all read | ⏳ | | |
| H8 | (if built) test push arrives | n/a | | push cut in N7 (no backend, new native dep) |
| H9 | Close all on a basis pair with **no Earn position** (a Meridian short + Perpl long of the same size from N5, Earn screen showing no position; an Earn pair is H10): Home → positions → **Close all** → summary "Meridian first, then the Perpl … for exactly what closed" → hold (or tap) → progress "Closing on Meridian first…" → "Meridian closed. Closing the same size on Perpl…" → "Basis trade closed" with both sizes; both cards gone; Activity shows two "Closed …" rows. Then repeat and kill the app right after confirming → relaunch → unlock → it finishes (no second order on either venue: check Perpl order history + the explorer) | ⏳ | | |
| H10 | Close all on a locked Earn pair (needs E9 done: Earn position with "Fixed X % on 1,000 MON …" shown): Home → positions card header reads **"Earn · basis · N MON each side"** (not "Basis trade") → **Close all** → summary "Close the fixed-rate lock (1,000 MON) first, then the Earn position: N MON on Meridian first, then the same on Perpl" → hold (or tap) → progress follows the Earn steps → outcome "Closed on both venues" + **See the Earn receipt** (timeline: swap-close Filled, then Meridian, then Perpl). Earn tab: no position, no lock line; Trade tab: flat on both venues; explorer: the swap-book tx comes BEFORE the Meridian close tx. Then: with a lock but no Earn position on this phone (e.g. sign in on a second phone, or open a swap on the web terminal's Fix page) → Close all shows "…no Earn position for it, so Close all won't guess … sends nothing. Close the fixed-rate lock first (Settings → Open full terminal → Fix)…" and the confirm stays disabled | ⏳ | | |
| H11 | One order at a time: Earn → tap `1` `0` → hold "Hold to start earning" → while "Opening your position…" shows, switch to Trade → Long → `5` → hold → "An Earn trade is still going through. Try again when it's done." (input kept, nothing sent). Reverse: Trade → Long $5 → hold → while the receipt is pending, switch to Earn → `1` `0` → hold → "A trade is still going through. Try again when it's done." Also Close all while an Earn run is going → same Earn line. Then kill the app during an Earn open → relaunch → unlock → it finishes before anything else starts | ⏳ | | |
| H12 | Earn in Activity: after an Earn open (E2) and its close (E4 or H10): Home → **See all** → two rows "Earn open · You're earning the gap" / "Earn close · Closed on both venues" with "Perpl N · Meridian N MON" (+ "lock 1,000 MON" with Lock), venue "Meridian + Perpl"; the legs' Perpl fills are NOT listed separately; tap a row → the Earn receipt with that run's timeline (no "Close now" button on an old MANUAL row); kill + relaunch during an Earn run → still one row for it | ⏳ | | |


## Native app (MOBILE_PLAN N8): release build QA matrix (preview APK, staging, testnet)

Build: the first **preview** APK (`eas build -p android --profile preview`, version **0.2.0 / versionCode 2**, package
`xyz.meridianfi.app.staging`, rpId `meridian-testnet.vercel.app`) installed from the EAS link on a phone that never had
the dev client (or after uninstalling it: they share the package). Its signer SHA-256 must be in the staging
`assetlinks.json` **before** row N8-1. Branch `n8-prep` (+ the hallway-test fixes). Vercel staging needs the `FLAGS_*`
env (LAUNCH_PLAN §3.2) for N8-F rows. Tick only what was seen on the phone; record the build id, APK link and signer
fingerprint in the N8 log line.

**Build record (L2, 11 Oct 2026):** EAS `2242d587-c4b4-461f-a716-a9b04e5c277c`, profile `preview`, commit `ca84977`
(main after #15), version 0.2.0 / versionCode 2, package `xyz.meridianfi.app.staging`, 108.8 MB APK.
Install link: https://expo.dev/artifacts/eas/01yczpPT3kBHg7kN-gGJDCOD609c_jbb2_BZoS4NlT4.apk (EAS page expires 24 Oct).
Signer SHA-256 (`apksigner verify --print-certs`): `23:2F:3C:C0:DA:54:87:A5:9B:18:1A:06:7B:77:B6:53:69:59:29:13:D2:03:DF:90:9F:36:9D:D7:DC:46:16:B2`
= the entry already in staging `assetlinks.json` and in Google's Digital Asset Links API
(`get_login_creds`, `xyz.meridianfi.app.staging`), so no assetlinks change was needed. Phone rows below stay ⏳ until
seen on a phone.

| # | Check (owner's taps) | Pass looks like | Result | Seen by | Note |
|---|---|---|---|---|---|
| N8-0 | Settings → scroll to **Version** | "0.2.0 · staging · chain 10143" | ⏳ | | |
| N8-1 | Passkey create: fresh install → **Continue with passkey** → **Create my wallet** → fingerprint | "Wallet ready ✓" then Home with the total, ≤ 15 s from launch (stopwatch), 2 taps + fingerprint | ⏳ | | |
| N8-2 | Unlock: swipe the app away → reopen → **Unlock with your fingerprint** → fingerprint | Home with the same address (Settings → wallet ••xxxx unchanged) | ⏳ | | |
| N8-3 | Reinstall: uninstall → install the same APK → **Use an existing passkey** → pick the Meridian passkey → fingerprint | the same address as N8-1 (no new wallet), balances back | ⏳ | | |
| N8-4 | Perpl onboarding resume: Trade → Long → `5` → pick Perpl → **Set up Perpl** → do step ① only → swipe the app away → reopen + unlock → Settings → Perpl | step ① shows Done, step ② is Next (resumed, not restarted) | ⏳ | | |
| N8-5 | Trade on Meridian: Trade → **Long** → `5` → tap the Meridian quote row → summary → hold (or **Or tap here to go long**) | receipt with fill size, avg price, fee, blocks to fill, explorer link; position card appears | ⏳ | | needs the MM bot on testnet |
| N8-6 | Trade on Perpl: Trade → **Short** → `5` → tap the Perpl quote row → hold | receipt with the Perpl order id; position card "Short … on Perpl" | ⏳ | | |
| N8-7 | Close each: on each card tap the visible **Close** (or swipe) → hold | receipt; card gone; Home total moved by about the PnL | ⏳ | | |
| N8-8 | Earn + forced unwind: Earn → `1` `0` → hold "start earning" → receipt timeline (Perpl then Meridian) → back → **Close** → confirm. Forced unwind: dev build only (the toggle isn't in the APK, by design) → E-rows of N6 | open: "You're earning the gap"; close: "Closed on both venues"; flat on both venues | ⏳ | | |
| N8-9 | Kill-resume: Trade → Long `5` → hold → as soon as "Sending…" shows, swipe the app away → reopen → unlock | the order finishes on its own and its receipt shows; exactly one fill on the venue (Perpl order history / explorer) | ⏳ | | |
| N8-10 | Home totals: Home → **See breakdown** | Wallet + Meridian + Perpl = Total; each part matches the venue's own UI (as H1) | ⏳ | | |
| N8-11 | Activity: Home → **See all** | the opens / closes / Earn runs from N8-5…N8-8 newest first; a row opens its receipt | ⏳ | | |
| N8-12 | Offline banner: airplane mode on (app open on Trade) → wait 5 s → airplane off | "Offline" banner + writes disabled while off; live numbers resume within a few seconds after | ⏳ | | |
| N8-13 | Background / foreground: Trade open → Home button → wait 60 s → reopen | numbers resume; in Perpl's API session list (or app logs) still **one** trading socket, not two | ⏳ | | |
| N8-14 | Large text: Android Settings → Display → Font size **max** (+ Display size max) → Home, Trade ticket (`5`), Earn | the Home total, the ticket summary and the Earn APR wrap, nothing cut off or overlapping; buttons still tappable (unit check: `clipRisks`, D4.5) | ⏳ | | |
| N8-15 | TalkBack: on → swipe through Home, Trade (Long/Short, numpad keys, quote rows, hold + "Or tap here…"), Earn (APR, Lock switch), Settings | every control is read with a name; the tap alternative is reachable without holding | ⏳ | | |
| N8-16 | 60 fps: Trade → Pro → drag a finger across the chart for 5 s; open / drag / close the ticket sheet 3× (Developer options → Profile HWUI rendering → On screen as bars) | bars stay under the green line; a selection tick per chart point | ⏳ | | |
| N8-17 | Cold start: swipe away → reopen (already unlocked within the idle window, or unlock) → stopwatch to the first live block number on Home | < 2 s to live numbers | ⏳ | | |
| N8-18 | First run ≤ 15 s: = N8-1 timing | ≤ 15 s launch → wallet | ⏳ | | |
| N8-19 | Push | n/a | n/a | | push cut in N7 |
| N8-A1 | Error boundary: (no way to force a crash in a release build) | n/a on the phone; unit-tested with a throwing child (D4.2) | n/a | | |
| N8-A2 | Production APK before N9 (`--profile production`, package `xyz.meridianfi.app`): install → open | full-screen "Meridian isn't live on mainnet yet", no testnet data anywhere, Version not reachable (expected) | ⏳ | | only if the production APK is built before N9 |
| N8-F1 | Kill switch: Vercel staging env `FLAGS_WRITES=false` (+ optional `FLAGS_MESSAGE="Testing the kill switch"`) → redeploy → `curl -s https://meridian-testnet.vercel.app/api/flags` shows `"writes":false` → on the phone foreground the app (or wait ≤ 60 s) → Trade → Long → `5` | the ticket shows the message (or "Trading is paused for maintenance. You can still close positions."), the hold / tap stay disabled; Earn shows the same line instead of "Hold to start earning"; the web terminal's order button shows "Trading is paused" | ⏳ | | |
| N8-F2 | Close still works with writes off: with a position open from N8-5 → its card **Close** → hold; Earn position → **Close**; Close all (2 positions) | each close goes through to its receipt | ⏳ | | |
| N8-F3 | Writes back: unset `FLAGS_WRITES` (or `true`) → redeploy → foreground the app | the line disappears, opens work again (within 60 s + 30 s edge cache) | ⏳ | | |
| N8-F4 | Forced update: `FLAGS_MIN_APP_VERSION=0.3.0` → redeploy → reopen the app | full-screen "Update Meridian", "This app: 0.2.0 · needed: 0.3.0 or newer", "Ask the Meridian team for the new version." (no install link yet) | ⏳ | | |
| N8-F5 | Close path from the update screen: **Close my positions** → unlock → Home | "Update required · closing only · Update" banner; position cards' **Close** and **Close all** work; Trade → Long → `5` shows "Update Meridian to open new trades. You can still close positions." | ⏳ | | |
| N8-F6 | Undo: `FLAGS_MIN_APP_VERSION` unset (or `0.0.0`) → redeploy → foreground | update screen gone, opens work | ⏳ | | |
| N8-F7 | Perpl / Earn / Lock switches: `FLAGS_PERPL=false` → Perpl quote row can't be confirmed, Earn refused, Meridian ticket still works; `FLAGS_LOCK=false` → Earn's Lock switch off with "Fixed-rate locks are paused…" | as described; reset all `FLAGS_*` after | ⏳ | | |
| N8-M | Maestro on the emulator (README § Maestro): `maestro test -e APP_ID=xyz.meridianfi.app.staging mobile/.maestro` with the dev client + Metro :8089 + `EXPO_PUBLIC_FAKE_PASSKEY=1` | onboarding, trade-open-close, earn-open-close, close-all all green (trade / earn need funds + liquidity) | ⏳ | | dev client only (fake passkey) |
