# MOBILE_PLAN: Meridian Mobile — native app (Agora "Best Mobile Trading App on Monad")

Owner: Samya (lanes may be run by Claude sessions). Written Thu 8 Oct 2026; **revised same day: full native app (Expo / React Native) for iOS + Android**, replacing the earlier web-app (PWA) plan.
Build window: **Thu 8 → Sat 10 Oct** (all implementation), **mainnet go-live Sun 11 morning**, video Sun 11 afternoon, buffer Mon 12, **submit Tue 13 by 12:00** (deadline 15:00).

**Master plan:** `docs/LAUNCH_PLAN.md` (environments, hosting, config, CI/CD, go-live, and the combined schedule). Where the two differ on platform/ops, LAUNCH_PLAN wins; this file owns the app features.

This file is the single source of truth for the mobile work. A new session reads §0–§3, then executes exactly one phase.

---

## 0. Read this first (every session)

### 0.1 Read order
1. `CONTRIBUTING.md` (public repo conventions) — hard rules, rounding, style, testing.
2. This file §0–§3, then your phase.
3. `../Meridian/docs/BOUNTY_MAP.md` "Agora requirement".
4. The code you touch (listed per phase).

### 0.1b Skills to load (installed in `~/.claude/skills`)
| Phase | Skills |
|---|---|
| N0, N8 | `expo-native-app`, `phone-test` |
| N1 | `perpl-api` |
| N2, N5, N7 | `expo-native-app`, `mobile-app-ui-design`, `frontend-design` |
| N3 | `mera-passkeys` (§1–§6 + RN notes in `expo-native-app`) |
| N4, N6 | `perpl-api`, `expo-native-app` |

### 0.2 Where the code lives
| What | Path |
|---|---|
| Public repo (submission) | `github.com/SamyaDeb/meridian`, branch `main` |
| Working clone | `/Users/samya/Downloads/meridian-m` (create in N0) |
| **Native app (new)** | `mobile/` — Expo app, workspace package `@meridian/mobile` |
| **Shared pure TS (new)** | `packages/core/` — `@meridian/core`: Perpl auth/units, routing, basis math, funding math, ABIs + deployment readers. Used by `mobile/`, later by `app/` and `mm-bot/` |
| Web app (unchanged, keeps the Privy + Track 01 story) | `app/` |
| Perpl code to port | `meridian-k3/mm-bot/src/perpl/{auth,trading,types,config,ratelimit,state}.ts`, `mm-bot/scripts/perpl-enroll.ts` (PR meridian#5) |
| Perpl read client + funding index | `mfi/src/perpl/*`, `mfi/src/mfi/{compute,service}.ts`, `mfi/src/api/handler.ts` |
| Addresses / markets | `deployments/{143,10143,perpl}.json`, `abis/`, `indexer/abis/PerplExchange.json` |
| Math to reuse (copy into core with tests, don't fork silently) | `app/src/lib/{math,liqDistance,orders,book,depth,blocks,units,format,permit,gas}.ts` |

### 0.3 Commit / PR rules (public repo)
- Branch per phase: `n1-core`, `n2-shell`, … Conventional commits (`feat(mobile): …`, `feat(core): …`).
- **SSH-signed, author SamyaDeb only, no Claude trailers (owner's choice, K0).**
- PR per phase into `main`; CI green (`pnpm -r typecheck`, `pnpm -r test`). Owner merges.
- Never commit: `.env*`, keystores, Apple/Google credentials, `google-services.json`/APNs keys, EAS secrets, Ed25519 secrets.

### 0.4 Hard rules (CONTRIBUTING.md + mobile)
1. **Never invent** addresses, RPC URLs, chain/market IDs, decimals, SDK/package function names. Use §0.5 or write `> VERIFY: <what, where>` and continue against a mock.
2. viem only (no ethers). Strict TS. vitest for `packages/core`; jest-expo/React Native Testing Library for components (> VERIFY versions match the Expo SDK); Maestro for device flows (N8).
3. Gas limit = `estimateGas × 1.2` (Monad bills the limit).
4. Per-block math uses `block.number`.
5. Every number on screen comes from chain/API/indexer; zero shows zero; unknown shows "—". No sample data in release builds.
6. Round against the user.
7. Two-leg trades are not atomic: Perpl leg first (IOC), then Meridian for exactly the filled size, auto-unwind on failure (N6).
8. **Never store key material** (PRF output, private keys, Ed25519 secret, mnemonic) in AsyncStorage, logs, or files. Credential id only; secrets in memory during a session.
9. The passkey **rpId domain is permanent**. Native and web share it. Pick it once in N0.

### 0.5 Verified facts (source)
| Fact | Value | Source |
|---|---|---|
| Monad chain ids | 143 mainnet / 10143 testnet (`monad`, `monadTestnet` in `viem/chains`) | CONTRIBUTING §7; Mera docs |
| AUSD mainnet | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`, 6 dp, EIP-2612 permit, domain "Agora Dollar" v"1" | ARCHITECTURE R9; `deployments/perpl.json` |
| Perpl mainnet | exchange `0x34b6552d57a35a1d042ccae1951bd1c370112a6f`, collateral AUSD 6 dp, MON market **10**, funding interval 2,580 s | `deployments/perpl.json` |
| Perpl testnet | exchange `0x1964c32f0be608e7d29302aff5e61268e72080cc`, collateral `0xa9012a055bd4e0edff8ce09f960291c09d5322dc` 6 dp, MON market **64** | `deployments/perpl.json` |
| Perpl API / auth / enrolment / tradeability / limits | see `perpl-api` skill (REST `app.perpl.xyz/api` / `testnet.perpl.xyz/api`; Ed25519; `createAccount(uint256)`; `allowOrderForwarding(true)`; trading WS 120/min mainnet, 4 conns/wallet) | github.com/PerplFoundation/api-docs |
| Perpl min account open | `min_account_open_amount: 100000000` ("10.0 AUSD") — **> VERIFY raw unit in N4 mainnet canary** | api-docs |
| **No CORS in native** | Native `fetch`/`WebSocket` aren't subject to browser CORS → Perpl called directly, no relay | platform behaviour |
| Mera React Native | `@category-labs/mera` ≥ 0.2.0 + `react-native-passkey` + `viem @scure/bip32 @scure/bip39` + `expo-crypto` (Hermes `crypto.getRandomValues` polyfill imported first). `reactNativeWebAuthnClient` from `@category-labs/mera/react-native-webauthn-client`, passed to `createPasskeyWithPrfOutput({ rp, user, webAuthnClient })` / `getPasskeyPrfOutput({ rpId, webAuthnClient })`. **Development build only (no Expo Go)**; `npx expo prebuild`; iOS 18+ / Android 9+ with PRF provider; Node 24+ | docs.monad.xyz/guides/mera/react-native.md |
| Mera domain association | iOS: `https://<rpId>/.well-known/apple-app-site-association` with `webcredentials.apps: ["<TEAM_ID>.<bundleId>"]`; `ios.associatedDomains: ["webcredentials:<rpId>"]`. Android: `https://<rpId>/.well-known/assetlinks.json` with `delegate_permission/common.get_login_creds`, package name, SHA-256 of **every** signing cert (debug, EAS, Play). JSON, HTTPS, **no redirects** | same |
| Mera first-call failure | `PASSKEY_OPERATION_FAILED` on first request = association file unreachable/redirecting/mismatched | same |
| Privy native | `@privy-io/expo` uses `react-native-passkeys` (a *different* native module than Mera's `react-native-passkey`) | docs.privy.io/basics/react-native |
| Agora requirement (unverified third-party quote) | "mobile application that authenticates users via Mera, holds and displays a stablecoin balance in AUSD, and executes trades through Perpl"; judged on implementation quality, UX, "creative use of the three integrations together"; bounties 40% adherence | curb#49, curb#5 — **> VERIFY official text (N0)** |

### 0.6 Decisions baked into this plan
- **Native app = Mera only.** Privy stays in the web app (keeps the Privy bounty). Reason: two different native passkey modules in one binary is a needless risk with 2.5 days; the Agora bounty wants Mera.
- **Expo (React Native) + EAS Build**, one TypeScript codebase for iOS and Android; shared logic in `packages/core` with the existing TS.
- **Distribution:** Android = EAS "internal distribution" APK link (anyone installs, incl. judges). iOS = TestFlight (needs Apple Developer Program). Fallback if Apple isn't ready: iOS dev build on your own iPhone via Xcode + the Android APK for everyone else.
- The earlier web `/m` app is dropped. The desktop/web terminal stays as is.

### 0.7 Competitors (8 Oct) — what we must beat
| Entry | Strength | Our edge |
|---|---|---|
| Desk (native iOS, TestFlight) | Native polish, many features | Testnet only, no video, Perpl-only client |
| Curb (mobile web, mainnet) | Mainnet proof, Mera two-key, videos | Web, two markets, no users |
| Sente (Android native) | AI agent mandates | Testnet, never on a phone, AUSD barely used |
**Ours:** native on both platforms, **two onchain perp books** behind one AUSD balance and one Face ID → best-price routing + one-tap funding-spread basis trade + optional fixed-rate lock, live on mainnet.

---

## 1. Product spec

**Pitch:** *Two onchain order books, one AUSD balance, one Face ID. Trade the best price, or earn the gap.*

**UX research (9 Oct): `docs/MOBILE_UX_RESEARCH.md`** — findings with sources and confidence, competitor matrix, gap
analysis against the N2–N4 code, the per-screen spec (§5) and P0/P1/P2 priorities (§7). Where it is more specific than
this section, it wins. Its 8 principles in one line each: one tap to a wallet · progressive, not front-loaded · never ask
for gas the user doesn't have · plain words over chain words · summary → hold (or tap) → fingerprint → receipt · Lite by
default, Pro one tap away · live, honest numbers · trust shown, not claimed.

### 1.1 Navigation (expo-router)
```
(onboarding)/welcome     live spread ticking, one primary "Continue with passkey" + text link "Use an existing passkey"
(onboarding)/create      FIDO passkey hero ("Your fingerprint is your wallet") → OS sheet → "Wallet ready ✓" → Home
(onboarding)/unlock      auto-prompt on launch
(onboarding)/fund        "Add funds" sheet: QR, copy/share, live arrival moment (toast + haptic + count-up)
(onboarding)/perpl       enable Perpl (3 checks, resumable) — also runs INLINE in the trade sheet on the first Perpl trade
(tabs)/portfolio  = Home hero total AUSD, today's PnL, Trade / Earn / Add funds, positions, Activity list, empty state
(tabs)/trade             Lite (ticket) by default, Pro toggle: header, live chart, both books + depth, trades
(tabs)/earn              basis trade + Lock 30 d
(tabs)/settings          passkey card, recovery phrase, Perpl card, alerts, network, sign out
modals: route, receipt, position, close-all
```
Bottom tabs: **Home · Trade · Earn · Settings** (Home = the portfolio route, first tab). The native Trade **Pro view**
has a chart and both books (research §5.3); the full desktop terminal stays on the web ("Open full terminal").

### 1.2 Screen contracts
Same functional spec as before, native-grade:
- **Welcome**: live Meridian vs Perpl funding APR + spread per block before login (the hook).
- **Onboarding (P0)**: launch → wallet in ≤ 15 s, 2 taps + fingerprint. FIDO handshake: hero before the OS sheet (passkey symbol, "Your fingerprint is your wallet", "Passkeys are encrypted digital keys you create using your fingerprint, face, or screen lock. Saved in Google Password Manager, so a new phone signs you back in."), "Wallet ready ✓" + success haptic after. No address, no seed, no email. Recovery-phrase export offered later (Settings, after the first deposit), never at signup. Cancel ⇒ calm message, not red.
- **Trade (P0)**: header (MON price per block, 24 h change, both funding APRs, funding countdown); **live chart** (native line chart with scrub crosshair + selection haptic, lines for mark / entry / **liquidation**, last point per block; candles + 1m–1D timeframes = P1); Pro tabs Books (Meridian + Perpl side by side, better price highlighted, depth) + Trades (P1); **sticky Long / Short → bottom-sheet ticket**: custom numpad (AUSD, presets 25 % / 50 % / MAX), leverage slider with **haptic detents**, live dual-book quote (best venue, both effective prices, fee, funding/day, liq price + distance meter, slippage chips), route sheet (both books, consumed levels highlighted), **plain summary** ("Long 120 MON on Perpl · worst price … · fee … · liq …"), **hold-to-confirm (visible tap alternative, WCAG 2.5.1) → passkey if the session expired → receipt** (venue, avg price, size, fee, order id / tx, blocks to fill) with success haptic. First Perpl trade runs the 3 Perpl checks inline in the sheet. TP/SL fields and drag-TP/SL on the chart = P2.
- **Earn**: hero "Earn X% APR on AUSD" net of fees (live), 24 h sparkline, input → est./day, legs preview, "no edge right now" state, Lock 30 d toggle (fixed APR quote), 3-step explainer.
- **Home / Portfolio (P0)**: Cash-App-style hero: total AUSD (wallet + Meridian collateral + Meridian equity + Perpl equity), today's PnL, heartbeat dot; actions **Trade**, **Earn**, small **Add funds**; empty state with the next step ("Add AUSD to start"; testnet: "Get test funds"); position cards (live PnL, liq meter) with swipe **Close** + visible button; Activity list (P1: deposits, trades on both venues, funding, each → receipt); Flip / Add margin / Close all / share card = P2.
- **Alerts (native push)**: liq distance < 5%, spread > threshold, funding flip, fills.
- **Settings**: passkey card (FIDO principle 9: "Passkey · Google Password Manager · active"), wallet (identicon + "••a3f2", copy full address), export recovery phrase (fresh prompt, screenshots blocked), Perpl card (N4: account, free collateral, fast orders, key, "Re-enable trading", "your trading key can trade but can never withdraw"), alert toggles, network badge, sign out.

### 1.3 Native-grade UX bar (checked in N8)
60 fps (Reanimated, UI-thread animations), gesture-driven bottom sheets, haptics on every meaningful action (`expo-haptics`), per-block heartbeat (dot + block number), skeletons not spinners, pull-to-refresh, swipe rows with button fallback, safe areas everywhere, Dynamic Type respected up to large sizes, VoiceOver/TalkBack labels on every control, dark theme default, cold start to live numbers < 2 s, offline banner + disabled writes, plain-language errors, tap targets ≥ 44 pt, app icon + splash + adaptive Android icon. Added 9 Oct (research): every gesture has a single-tap alternative (WCAG 2.5.1/2.5.7); errors name the problem and keep the input; success is always explicit (receipt / toast + haptic); no hex, nonce or "approve" in the main path (details only); numbers never shift layout (tabular figures); chart scrub ticks a selection haptic per point; first run ≤ 15 s to a wallet.

---

## 2. Architecture

```
mobile/ (Expo, dev build, Hermes)
 ├─ polyfills.ts (expo-crypto getRandomValues; first import)
 ├─ auth/        Mera: reactNativeWebAuthnClient, create/sign-in, session (memory), idle lock
 ├─ wallet/      viem walletClient(account = toViemAccount(session)), publicClient(s), gas ×1.2
 ├─ venues/      meridian (contract reads/writes), perpl (core client: REST + WS, signed)
 ├─ live/        block subscription (WS RPC if available, else 400 ms poll), Perpl market-data WS, app-state pause/resume
 ├─ features/    trade, earn, portfolio, onboarding, settings (screens + hooks)
 ├─ ui/          design system: tokens, Text, Button, HoldButton, Sheet, Slider, Segmented, Skeleton, Toast, SwipeRow, Sparkline
 └─ push/        expo-notifications registration → backend
packages/core/ (pure TS, vitest)
 ├─ perpl/  auth (noble), rest, trading WS protocol, units, errors, onboarding state machine
 ├─ route/  book normalise, walkBook, router, funding, basis, lock, liq
 ├─ exec/   single-leg + two-leg state machines (pure, adapters injected)
 └─ meridian/ ABIs + deployments readers + math helpers
backend (existing Vercel app/ api routes): /api/mfi/* spread + history, /api/push/* register + rule worker
ops (Sun 11): keeper, MM bot (hedges on Perpl), Envio indexer
```

Libraries (install with `npx expo install` so versions match the SDK; pin; record in THIRD_PARTY.md): `expo-router`, `react-native-reanimated`, `react-native-gesture-handler`, `@gorhom/bottom-sheet`, `react-native-safe-area-context`, `expo-haptics`, `expo-notifications`, `expo-secure-store` (non-secret prefs + credential id), `expo-local-authentication` (app-lock re-prompt), `expo-clipboard`, `expo-sharing` + `react-native-view-shot` (share card), `react-native-svg` (sparklines/meters), `react-native-qrcode-svg` (fund screen), `expo-crypto`, `@category-labs/mera`, `react-native-passkey`, `viem`, `@noble/ed25519`, `@noble/hashes`. Any package not confirmed in its docs → `> VERIFY`.

---

## 3. Phases and status

| Phase | Name | When | Branch | Status |
|---|---|---|---|---|
| N0 | Accounts, domain association, repo setup | Thu 8 (start NOW) | — | [ ] |
| N1 | `packages/core` (Perpl client, routing, basis, exec machines) | Thu 8 – Fri 9 | `n1-core` | [x] code + tests (241 green, `pnpm -r typecheck` + all repo tests green on Node 22); **merged** (PR meridian#7 → main 6943fb8); device Hermes smoke = N2 |
| N2 | Expo shell, design system, live layer, dev builds on both phones | Thu 8 – Fri 9 | `n2-shell` | [ ] |
| N3 | Mera Face ID login (native) | Thu 8 – Fri 9 | `n3-mera` | [~] code + tests done (meridian-n3 `n3-mera`, 6 signed commits on n2-shell, unpushed; mobile 97 tests, `pnpm -r` typecheck/test green Node 24, mobile Node 22); EAS dev build 4e91111a ready; assetlinks PR meridian#9 open; **device QA deferred by owner** |
| N4 | Perpl onboarding + mainnet canary | Fri 9 | `n4-perpl` | [~] code + tests done (meridian-n4 `n4-perpl` on n3-mera, 5 signed commits, unpushed; core 245, mobile 146; `pnpm -r` green Node 22 + 24); core §Open answered; **phone QA + testnet run pending**; mainnet canary prep needs owner OK |
| N4b | UX polish from research (onboarding hero, Home hero, funding arrival, passkey card) | Fri 9 – Sat 10 | `n4b-ux` | [~] code + tests done (meridian-n4b `n4b-ux` on n4-perpl, 5 signed commits, unpushed; mobile 166, core 245; `pnpm -r` green Node 24, mobile Node 22; release guard OK; no new deps, lockfile unchanged); **phone run (U1–U8) pending** |
| N5 | Trade screen end to end (Lite + Pro, live chart, numpad sheet, receipt) | Fri 9 – Sat 10 | `n5-trade` | [~] code + tests done (meridian-n5 `n5-trade` on n4b-ux, 7 signed commits, unpushed; core 252, mobile 220; `pnpm -r` typecheck/test green Node 24, mobile Node 22; release guard OK; no new deps, lockfile unchanged; Android bundle builds on Metro :8086); **phone rows T1–T8 pending** |
| N6 | Earn: two-leg executor + Lock | Sat 10 | `n6-earn` | [ ] |
| N7 | Portfolio, share, push, settings | Sat 10 | `n7-home` | [~] code + tests done (cloud session, branch `n7-home` from `mobile`, 2 unsigned commits + docs, PR into `mobile`; core 252, mobile 258 (+38); `pnpm -r` typecheck/test green Node 22; release guard OK; no new deps, lockfile unchanged ⇒ no EAS build); Home total + breakdown + open PnL + positions + Activity + Settings alerts / web terminal; **cut:** push, share card, Flip / Add margin / Close all; **phone rows H1–H7 pending** |
| N8 | Release builds (APK + TestFlight), device QA, Maestro | Sat 10 | `n8-release` | [ ] |
| N9 | Mainnet go-live | Sun 11 AM | `n9-mainnet` | [ ] |
| N10 | Demo, proof, submission | Sun 11 PM – Tue 13 | `n10-submission` | [ ] |

Parallel: Thu — N1 ∥ N2 ∥ N3. Fri — N4 (phone run) ∥ N4b ∥ N5 (N5 on core fakes first). Sat — N6 ∥ N7 ∥ N8 prep. Merge order: N1 → N2 → N3 → N4 → N4b → N5 → N6/N7 → N8. Session prompts: `docs/prompts/mobile/N<x>-*.md` (N4b, N5, N6, N7, N8 written 9 Oct from the UX research).

**Build timeline (IST, after the research):**
| When | Session A | Session B | Owner |
|---|---|---|---|
| Fri 9 afternoon | N4 phone run (N3 rows first, then testnet onboarding + IOC) | N4b UX polish (onboarding hero, Home hero, deposit arrival, passkey card) | taps on the phone, approves testnet funding |
| Fri 9 evening | N5 trade screen on core fakes → live on testnet | N4b → PR after N4 | merges N2 → N3 → N4 |
| Sat 10 to 12:00 | N5 on the phone (open + close on both venues) | N7 Home / Activity / Settings | **go/no-go 12:00**: N5 on a real phone |
| Sat 10 afternoon | N6 Earn | N8 prep + hallway test (3 people) | hallway test |
| Sat 10 evening | N8 release APK + QA matrix | P4 rehearsal (LAUNCH_PLAN) | approves EAS builds |

**UX decisions (owner accepted the research recommendations, 9 Oct):**
- **G1 gas:** clear "Add a little MON for network fees" copy with QR + live MON (already in N4); Perpl orders gasless. A capped "first-gas drip" (backend sends ~0.05 MON once after the first AUSD deposit) only if Sat afternoon has slack; no paymaster / 7702 before 13 Oct.
- **G2 chart:** native. Try `react-native-wagmi-charts` (> VERIFY on Reanimated 4.5 / RN 0.86; a new native dep ⇒ one EAS dev build, owner OK); fallback `react-native-svg` + Reanimated line chart (no new native dep). No WebView chart.
- **G3 Trade default:** Lite (ticket + sparkline); Pro (chart + books + trades) one tap away, remembered on the device.

**Cut order if behind (top first):** Lock toggle → push alerts → share card → drag TP/SL on chart → TP/SL fields → swipe Flip/Add margin → first-gas drip → candles + timeframes (keep the line chart) → Pro Books/Trades tabs → Activity list → iOS TestFlight → route sheet animation.
**Never cut:** Mera passkey with the one-button FIDO flow, Home hero AUSD balance, live line chart with liq line on Trade, dual-book quote, numpad ticket + plain summary + receipt, a real Perpl trade from the app, Earn screen, live per-block numbers, mainnet proof, video.

**Go/no-go checkpoint Sat 10 12:00:** if N5 isn't working on a real device, freeze features, finish N8 Android-only, and spend the rest on polish + video.

---

## N0 — Accounts, domain association, repo setup (Thu 8, start immediately)

HUMAN (blocking, do first — some take hours to approve)
1. **Apple Developer Program** enrolment (paid). Needed for: Associated Domains entitlement (passkeys), TestFlight. Note the **Team ID**. If enrolment won't clear by Sat → fallback in §0.6. (> VERIFY whether a free personal team can sign the `webcredentials` associated-domains entitlement — assume not.)
2. **Expo account** (free) → `npx eas-cli login`; create the EAS project.
3. Choose identifiers (permanent): iOS `bundleIdentifier`, Android `package` (e.g. `xyz.meridian.app` — owner decides).
4. **rpId domain** (permanent; shared web + native), e.g. `app.<domain>` — an HTTPS host you control on Vercel. Must serve the two association files with **no redirects**.
5. Paste the official Agora/Track 01 texts into BOUNTY_MAP; confirm "native" is fine (it is the safest reading).
6. Phones: iPhone on iOS ≥ 18.4 with iCloud Keychain on; Android ≥ 9 with Google Password Manager; USB cables; Android USB debugging on; iPhone Developer Mode on (Settings → Privacy & Security).

Session steps
1. Clone `SamyaDeb/meridian` → `/Users/samya/Downloads/meridian-m`; `pnpm i`. Check Node ≥ 24 (`node -v`), Xcode installed, Android Studio + JDK (`keytool`), CocoaPods.
2. Association files in the web app (served by Vercel at the rpId host):
   - `app/public/.well-known/apple-app-site-association` (no extension; `Content-Type: application/json` via `next.config` headers): `{"webcredentials":{"apps":["<TEAM_ID>.<bundleId>"]}}`.
   - `app/public/.well-known/assetlinks.json`: relation `delegate_permission/common.get_login_creds` (+ `handle_all_urls` optional), package name, SHA-256 fingerprints of debug keystore, EAS upload/signing key (from `eas credentials`).
   - Verify: `curl -sI https://<rpId>/.well-known/apple-app-site-association` → 200, JSON, no 3xx; same for assetlinks.
3. Record all identifiers in §5 log.

Acceptance: both files return 200 JSON without redirect; Apple Team ID known (or fallback chosen); EAS project exists.

---

## N1 — `packages/core` (Thu 8 – Fri 9) · branch `n1-core`

**Goal:** all money logic as pure, tested TS shared by mobile (and later web/bots).

1. Create workspace package `packages/core` (`@meridian/core`), ESM, strict TS, vitest, no Node built-ins (must run on Hermes): use `@noble/hashes` for sha256/hkdf, `@noble/ed25519`, Uint8Array base64url helpers.
2. `perpl/`: port `meridian-k3/mm-bot/src/perpl/auth.ts` (same canonical strings, same test vectors incl. the RFC 8032 vector), REST signer + 429 backoff, trading WS protocol (frames, sign-in mt 29, place/cancel/outcome/fills; transport injected so RN `WebSocket` plugs in), market-data protocol, units from `deployments/perpl.json`, `st/sr` error table → plain text, onboarding state machine `NO_KEY → KEY_ENROLLED → ACCOUNT_CREATED → FORWARDING_ON → READY` (detected from API/chain; tx builders return viem call data, the app sends them). Enrolment = `perpl-enroll.ts` flow.
3. `keys/`: `deriveEvmKey(prf, i)` (Mera docs), `derivePerplKey(prf, chainId)` = HKDF-SHA256(ikm=prf, salt="meridian/perpl-api-key/v1", info=String(chainId), 32) → Ed25519 secret. Vectors.
4. `route/`: `walkBook` (avg price rounds against user, levels, residual), `router` v1 (whole order to the cheaper effective price incl. taker fee; tie → Meridian; residual → ineligible), `funding` (per-day for both venues, Meridian per-block via measured block time, Perpl per 2,580 s interval), `basis` (short higher-funding venue, long lower, equal MON size rounded down, net spread after fees amortised 30 d, `edge` flag), `lock` (fixed-rate quote from Meridian swap book views), `liq` (Meridian: port `app/src/lib/liqDistance.ts`; Perpl: K5 rule).
5. `exec/`: single-leg and two-leg state machines (see N6 diagram), pure, adapters injected, persisted-state (de)serialisers for resume.
6. `meridian/`: ABIs from `abis/`, deployment readers for 143/10143, order helpers (tick snapping from `app/src/lib/orders.ts`).

Tests: every module; rounding direction asserted; property tests for basis (net MON exposure 0 or alerted) and router; recorded-fixture quote from real testnet books. No network in CI.

Acceptance: `pnpm --filter @meridian/core test` green; imports nothing from Node; bundle runs in a Hermes smoke (N2 imports it on device).

---

## N2 — Expo shell, design system, live layer (Thu 8 – Fri 9) · branch `n2-shell`

1. `npx create-expo-app@latest mobile` (TypeScript, expo-router template) inside the monorepo; workspace name `@meridian/mobile`; Metro config for pnpm monorepo (watchFolders = repo root, `node_modules` resolution — > VERIFY current Expo monorepo guide; Expo SDK version = latest stable, pinned).
2. `app.config.ts`: name "Meridian", slug, `ios.bundleIdentifier`, `ios.associatedDomains: ["webcredentials:<rpId>"]`, `android.package`, icons (iOS 1024, Android adaptive fg/bg), splash, `userInterfaceStyle: "dark"`, `extra` for chain id / RPC / Perpl URLs from EAS env (never committed).
3. `polyfills.ts` (expo-crypto `getRandomValues`) imported first in the entry.
4. Design system `mobile/src/ui/`: tokens (colour, type scale ≤ 4 sizes, 8-pt spacing, radii from the web app's scale: card 14 / inner 10 / control 8), `Text`, `Num` (tabular numerals), `Button`, `HoldButton` (Reanimated ring, 600 ms, haptic on complete), `Sheet` (@gorhom/bottom-sheet), `Slider` (haptic detents), `Segmented`, `Skeleton`, `Toast`, `SwipeRow`, `Sparkline`/`Meter` (react-native-svg), `BlockPulse`. Load `mobile-app-ui-design` + `frontend-design` and write a short design plan in `mobile/DESIGN.md` first.
5. Live layer: one viem `publicClient` per chain (`http` transport; `webSocket` if the paid RPC offers WS — > VERIFY); `useBlock()` context (subscription or 400 ms poll), pause on background (`AppState`), resume + refetch on foreground; Perpl market-data WS manager (≤ 16 subs).
6. Tabs + onboarding stack with placeholder screens wired to live data (Welcome shows the real spread from `/api/mfi` or core funding math).
7. Dev builds: `npx expo prebuild`, `npx expo run:ios --device` and `npx expo run:android --device` (or `eas build --profile development`). Install on both phones.

Acceptance: dev build runs on both phones; Welcome ticks per block; tabs/sheets at 60 fps; dark theme, safe areas, icons, splash.

---

## N3 — Mera Face ID login (Thu 8 – Fri 9) · branch `n3-mera`

1. `npx expo install expo-crypto`; `pnpm add @category-labs/mera react-native-passkey viem @scure/bip32 @scure/bip39` (pin; ≥ 0.2.0 for Mera); `npx expo prebuild` to link.
2. `auth/passkey.ts`: `createPasskeyWithPrfOutput({ rp: { id: RP_ID, name: "Meridian" }, user, webAuthnClient: reactNativeWebAuthnClient })`, `getPasskeyPrfOutput({ rpId: RP_ID, webAuthnClient })`; store only `credentialId` (+ transports) in `expo-secure-store`.
3. `auth/session.ts`: derive EVM key (core), `createSecp256k1SigningSession`, `toViemAccount`; wipe buffers; idle lock 10 min and on background > 5 min (`AppState`) → `session.end()`; value-moving actions (withdraw, Perpl deposit, recovery export) re-prompt passkey for a per-tx session.
4. `wallet/client.ts`: viem `walletClient({ account, chain, transport })`; send helper with `estimateGas × 1.2`, nonce handling, receipt wait, revert decoding (port from `app/src/lib/tx.ts`).
5. Screens: Create / Sign in (passkey picker when no credential id), errors via `isMeraError` (`PRF_UNAVAILABLE` → "This phone's passkey provider can't do Face ID wallets. Use iCloud Keychain (iOS 18.4+) or Google Password Manager."; `PASSKEY_OPERATION_FAILED` first time → association problem, show "Couldn't reach Meridian's passkey domain" and log details in dev).
6. Recovery phrase export in Settings (`entropyToMnemonic(prf)`), Face ID re-prompt, screenshot warning; same address in MetaMask/Rabby and in the web app (same rpId).
7. Tests: core derivation vectors; session timeout logic (pure); component tests for screens with a mocked webAuthnClient.

Acceptance (real devices): create on iPhone → address; reinstall/sign in → same address; Android same; the same passkey on the web app (same rpId) shows the same address; no secret in secure-store/AsyncStorage (inspect).

---

## N4 — Perpl onboarding + mainnet canary (Fri 9) · branch `n4-perpl`

1. `venues/perpl.ts`: core REST + WS client with RN `WebSocket`; one trading connection per app (limit 4/wallet), closed on background.
2. Onboarding screen (3 checks, resumable on relaunch): enrol key (EIP-712 sign with the Mera account + Ed25519 proof with `derivePerplKey`), approve AUSD + `createAccount(amount ≥ min)`, `allowOrderForwarding(true)`. Store the `X-API-Key` token in secure-store (not secret without the Ed25519 key, but keep it there).
3. Gas: show "Add ~0.5 MON for network fees" with address/QR + live balance (Perpl orders themselves are forwarded, gasless).
4. Testnet smoke from the phone: enrol → account → forwarding → IOC buy smallest MON size → close.
5. **Mainnet canary (HUMAN funds ≤ 20 AUSD + ~1 MON, throwaway passkey on the real rpId is fine — it's the same domain; label the account "canary")**: same flow on 143 market 10; record min-open raw unit, fees, order ids, tx hashes → `docs/outputs/PROOF.md` §Mobile.

Acceptance: testnet + mainnet canary done from a phone; numbers recorded in §5.

---

## N4b — UX polish from the research (Fri 9 – Sat 10) · branch `n4b-ux` (stacked on `n4-perpl`)

Research §4 gap table + §5.1/§5.2. Small, high-visibility changes to screens that already exist.
1. **Onboarding (FIDO handshake):** Welcome keeps the live spread; one primary "Continue with passkey" (passkey symbol) + text link "Use an existing passkey". New hero step before the OS sheet: "Your fingerprint is your wallet" + "Passkeys are encrypted digital keys you create using your fingerprint, face, or screen lock. Saved in Google Password Manager, so a new phone signs you back in." → **Create my wallet**. After the sheet: "Wallet ready ✓" (600 ms, success haptic) → Home. Cancel ⇒ calm line ("No problem — tap Create when ready"), not red. Copy for unlock: "Unlock with your fingerprint".
2. **Identity:** identicon (deterministic from the address, `react-native-svg`) + "Wallet ••a3f2"; full address only in the copy sheet / details.
3. **Tabs:** Home · Trade · Earn · Settings (Home = `(tabs)/portfolio` route, first). Home hero: total AUSD (wallet now; venues join in N7), heartbeat, actions Trade / Earn / Add funds, empty state ("Add AUSD to start"; testnet "Get test funds").
4. **Add funds sheet:** QR + copy + share; "Waiting for your deposit…" → arrival toast + success haptic + balance count-up when MON or AUSD rises (BalanceReader diff).
5. **Settings passkey card** (FIDO principle 9): "Passkey · Google Password Manager · active", where it lives, what signing out does (visible text, no tooltip).
6. **Copy pass:** no hex / "approve" / chain words in the main path (N4 screen: "Approve" → "Allow Perpl to use exactly X AUSD"); every error keeps the input; every success is explicit.
Tests: copy + flow tests (RNTL) for the new steps, identicon deterministic, arrival detector (pure), tab order; existing N3/N4 tests stay green.
Acceptance (phone): first run ≤ 15 s to Home with 2 taps + fingerprint (stopwatch); "Wallet ready" seen; deposit arrival toast seen on a real testnet transfer; TalkBack reads every new control.

---

## N5 — Trade screen (Fri 9 – Sat 10) · branch `n5-trade`

0. Read `docs/MOBILE_UX_RESEARCH.md` §5.3 and §7 first; load `mobile-app-ui-design` + `frontend-design`. Decide G2 (chart lib): try `react-native-wagmi-charts` against Reanimated 4.5 / RN 0.86 in a scratch branch (> VERIFY); if it fails, `react-native-svg` line chart on the existing Reanimated (no new native dep) — never a WebView for the P0 chart. A new native dep ⇒ ask the owner for one EAS dev build.
1. Screen: header (price per block, 24 h change, both funding APRs, countdown); chart (Perpl candles REST `/v1/market-data/:id/candles/:res/:from-:to` ≤ 1,024 + live from the N2 market-data WS; Meridian from the indexer / port `app/src/features/chart/datafeed`): line + scrub crosshair + selection haptic + mark / entry / liq lines (P0), candles + timeframes (P1); Lite/Pro toggle remembered (local, non-secret); Pro tabs Books (both venues, depth) + Trades (P1).
1b. Ticket sheet (sticky Long / Short): custom numpad (amount in AUSD from the chosen venue's available collateral; presets 25 % / 50 % / MAX; locale decimal), leverage slider (haptic detents), slippage chips, plain-language summary line.
2. Live quote from core `router` per block (input debounce 150 ms); route sheet with both books.
3. Execution: Meridian (market order with limit = quote ± slippage, tick snapping, permit deposit if collateral missing — port `app/src/lib/permit.ts`), Perpl (IOC via core; 5 s outcome timeout → REST check). If Perpl isn't READY → onboarding sheet; if collateral short → "Move X AUSD" inline.
4. Hold-to-confirm (visible tap alternative) → passkey (if session expired) → receipt modal (venue, avg price, size, fee, tx/order links, blocks to fill) + success haptic; error haptic + specific message that keeps the input. Perpl leg = N4 `runIoc` + `usePerpl` (one trading socket); first Perpl trade runs the N4 checks inline in the sheet.
5. Position card under the chart (live PnL, liq distance meter) with swipe Close + a visible Close button (reduce-only IOC / Meridian reduce-only).

Acceptance (phone, testnet): open + close a long on Meridian and on Perpl in ≤ 3 taps + fingerprint; quote and chart update each block; scrub works at 60 fps with haptic ticks; liq line drawn; correct venue chosen; receipt shown on success, specific error on failure.

---

## N6 — Earn: two-leg executor + Lock (Sat 10) · branch `n6-earn`

Executor (core `exec/basis.ts`, persisted so an app kill resumes/unwinds):
```
PLAN → ensure collateral on both venues → LEG1_PERPL_IOC
  ├ q1 = 0 → ABORT
  └ q1 > 0 → LEG2_MERIDIAN(size = q1)
        ├ q2 = q1 → (Lock? → LEG3_SWAP) → DONE
        ├ q2 < q1 → UNWIND_PERPL(q1 − q2, reduce-only IOC) → PARTIAL_DONE
        └ fail    → UNWIND_PERPL(q1) → ABORTED_UNWOUND
  UNWIND fail → push + in-app alert, retry with 2× wider limit, then one-tap manual close
```
Close = reverse order. Lock failure never unwinds the hedge ("Lock failed, hedge open, floating rate applies").
UI (research §5.4): hero "Earn X % APR on AUSD" net of fees (live), 24 h sparkline, amount on the shared numpad (presets 25 % / 50 % / MAX) → "≈ $Y / day", legs preview in plain words ("Short 120 MON on Meridian · Long 120 MON on Perpl"), "No edge right now" state with the next funding time, Lock toggle (P2), 3-step explainer, hold-to-confirm with tap alternative, **receipt timeline** (each leg: sent → filled / unwound, with order ids and tx links) + success haptic; partial/unwind states in plain words.

Acceptance (phone, testnet): open + close basis; forced Meridian failure (dev flag) auto-unwinds Perpl; app killed mid-trade resumes correctly.

---

## N7 — Portfolio, share, push, settings (Sat 10) · branch `n7-portfolio`

0. Home = this tab, first in the tab bar (research §5.2): hero total AUSD + today's PnL, actions Trade / Earn / Add funds, empty state with the next step, deposit-arrival moment (toast + success haptic + count-up when a balance rises).
1. Total AUSD + per-venue breakdown; live PnL cards (mark = book mid per block), funding accrued, liq meter; basis grouped by stored `basisId` (fallback: pair equal opposite MON positions).
2. Swipe Close / Flip / Add margin; Close all with a confirm sheet.
3. History: Meridian (Envio indexer), Perpl fills (REST), merged by time.
4. Share card: render a view → `react-native-view-shot` → `expo-sharing`.
5. Push: `expo-notifications` → Expo push token → `POST /api/push/register` (store with address + rules; KV store > VERIFY plan availability); rule worker (cron) evaluates liq distance / spread / funding flip / fills and sends via Expo push service. iOS needs APNs key in EAS credentials; Android needs FCM credentials in EAS (> VERIFY current Expo push setup docs).
6. Settings: passkey card (where it is saved, active), wallet identicon + short address (full address on copy), recovery export, N4 Perpl card, alert toggles, network badge, sign out, "Open full terminal" (web).
7. Activity list (P1): deposits, trades on both venues, funding payments, merged by time, each row → receipt.

Acceptance: totals match each venue's own UI (screenshots); a test push arrives on both phones.

---

## N8 — Release builds, device QA, Maestro (Sat 10) · branch `n8-release`

1. `eas.json` profiles: `development`, `preview` (Android APK, `distribution: internal`), `production`.
2. Android: `eas build -p android --profile preview` → install link/QR for anyone; add the EAS signing SHA-256 to `assetlinks.json` **before** testing passkeys on that build.
3. iOS: `eas build -p ios --profile production` → `eas submit -p ios` → TestFlight internal testers (no review); external public link needs Beta App Review (~24 h, submit Sat AM if you want judges to install). Fallback: dev build on your iPhone only + screen recording.
3b. **Hallway test (research §8), Sat before 12:00**: 3 people new to the app, Android, testnet — make a wallet, see a balance, open a $5 long, close it, find where the passkey is saved. Time + taps + hesitations → MOBILE_QA; fix the top 3 before the release build.
4. Maestro flows (`mobile/.maestro/*.yaml`): onboarding (with a test hook that bypasses passkey only in dev builds), trade open/close, earn open/close. Run on Android emulator + iOS simulator; passkey steps on real devices only.
5. QA matrix → `docs/outputs/MOBILE_QA.md` (both phones): Face ID create/sign-in/reinstall; Perpl onboarding resume; Trade Meridian; Trade Perpl; Earn + forced unwind; kill-resume; Portfolio totals; push; offline banner; background/foreground; Dynamic Type large; VoiceOver/TalkBack labels; 60 fps scroll/sheets; cold start < 2 s.

---

## N9 — Mainnet go-live (Sun 11 morning)

Pre-flight Sat evening on a mainnet fork (`anvil --fork-url $MONAD_RPC_URL --chain-id 143`): exact deploy script + config, addresses written to `deployments/143.json` by the script, ownership → Safe, app (dev build pointed at the fork) passes Trade + Earn rows.

HUMAN prerequisites by Sun 08:00: paid RPC (+ app-only key, WS if available), Safe address, deployer MON, AUSD + MON for MM inventory / keeper / demo wallet (100–200 AUSD + a few MON), Envio hosted config, push credentials, rpId domain live with both association files.

Sequence: deploy → verify → Safe → indexer synced → keeper + MM bot (with Perpl hedge) live, book ≥ 2 levels each side within ±1% → switch app config to 143 (EAS env + new preview/production build, or EAS Update for JS-only config) → **create the demo passkey**, fund, run onboarding → Trade (Perpl) → Trade (Meridian) → Earn + Lock → Close; record all hashes/order ids in PROOF.md §Mobile → health green.
Rollback: app remote flag disables writes; bots stop; positions always closable.

---

## N10 — Demo, proof, submission (Sun 11 PM – Tue 13 12:00)

Video (60–90 s, real phone screen recording on mainnet): welcome spread ticking → Face ID → AUSD balance → Earn hold → both legs fill (receipt timeline) → Lock → Trade routes to cheaper book → Portfolio live PnL + share card → push alert arriving → end card (Meridian · on Monad · Mera · AUSD · Perpl).

Write-up "Agora: Best Mobile Trading App":
| Requirement | Where | Proof |
|---|---|---|
| Mobile application | native iOS (TestFlight) + Android (APK link) | install links, video |
| Authenticates via Mera | native passkey (react-native-passkey), one passkey → wallet + Perpl key | video, code |
| Holds and displays AUSD | total AUSD across wallet + both venues | video |
| Executes trades through Perpl | Trade + Earn Perpl legs | mainnet order ids / tx hashes |
| Creative use together | one passkey → two keys; one AUSD balance → two books; spread → fixed AUSD yield | video |

Checklist: criteria re-read · Agora form · repo public · APK link + TestFlight link + video · PROOF hashes · consented tester addresses · submit Tue 13 by 12:00.

---

## 4. Session prompt template

```
You are a senior blockchain + React Native engineer on Meridian. Read
/Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md §0–§3, then phase <NX> completely, and load the skills listed
for <NX> in §0.1b. Work in /Users/samya/Downloads/meridian-m on a new branch <branch> from main. Follow
CONTRIBUTING.md and §0.4: never invent addresses/IDs/decimals/package APIs (use §0.5 or write > VERIFY), tests first,
viem only, gas = estimate × 1.2, never store key material. Public repo commits: signed, author SamyaDeb, no Claude
trailers. Execute every step of <NX>, run typecheck + tests, build/install on the phones where the phase says so
(tell me exactly what to tap/approve on the device), tick only the acceptance boxes you actually verified (list the
ones that need me on a real phone), update §3 status and §5 log, and open a PR "[N<X>] …".
```

---

## 5. Log (append; newest last)
- 2026-10-08 — Web-app plan written, then revised to native (Expo) the same day. Open: Apple Developer enrolment + Team ID, Expo account, bundle id / package, rpId domain, official Agora text, phone OS versions, Perpl min-open unit (N4).
- 2026-10-08 — Owner decision: **no Apple Developer Program.** No TestFlight; no iOS `webcredentials` entitlement (a free personal team can't sign Associated Domains — > VERIFY on developer.apple.com capability table), so native Mera can't run on iOS. Demo = live: Android native app (EAS APK, Mera via assetlinks) + iPhone via the web app's Mera login in Safari (W1) on the same rpId. AASA file not needed for native; Xcode/CocoaPods not needed unless this changes. Open: confirm iPhone path (web W1 vs Android-only).
- 2026-10-08 — N0 identifiers (owner delegated the choice): **prod rpId `meridianfi.vercel.app`** (Vercel project `meridianfi`, prj_1UQcxT1irXlufbJ85jwdmRDpQ21K, placeholder deployed to claim the host; free — no custom domain), **staging rpId `meridian-testnet.vercel.app`** (existing project; `/` 307→/trade, `/.well-known/*` 404 with no redirect = OK to add files). Android package **`xyz.meridianfi.app`**, staging **`xyz.meridianfi.app.staging`** (both in assetlinks). Android-first; no iOS native (no Apple program). Toolchain: Node 24.21.0 via nvm (default still 22), Android Studio installed (SDK wizard pending), JDK 17 pending (needs owner sudo), disk freed to 18 GB. Pending owner: eas login, railway login (CLI was another user), RPC provider, paging, Safe, phone models.
- 2026-10-08 — Toolchain done from the terminal: JDK 17 (brew `openjdk@17`, no sudo), Android SDK at ~/Library/Android/sdk (cmdline-tools + platform-tools r37, licenses accepted), `~/.zshrc` exports JAVA_HOME/ANDROID_HOME (backup ~/.zshrc.bak-meridian-*), nvm default 24 (fresh shell: node v24.21.0). Pending owner: `eas login`, phone USB debugging (adb sees no device), disk only 9 GB free.
- 2026-10-08 — **N1 `packages/core` done locally** (meridian-m `n1-core`, 7 SSH-signed SamyaDeb commits on main 0ba1664, unpushed). Modules: perpl (auth vectors incl. RFC 8032 reproduced on noble sync SHA-512 + own base64url; signed REST 429/503 back-off; trading WS + IOC; market-data WS + L2 book; enrolment; onboarding detector NO_KEY→…→READY + tx builders; all 70 `sr` + `fr` codes → plain English), keys (Mera EVM path, cross-checked with viem; HKDF Perpl key, cross-checked with node:crypto; optional rotation), route (walkBook, router v1, funding per block at measured cadence / per Perpl interval, basis, lock, liq incl. K5 Perpl rule), exec (single, basis open per N6, close = Meridian first, resume-safe prepare→send→confirm legs, versioned bigint JSON; resume tested from every snapshot), meridian (ABIs, deployment readers refusing `deployed: false`/missing 143.json, app/lib math ported with tests). 241 tests; Hermes guard test + src typechecked without Node/DOM types. Ported from K3 perpl-hedge fe873b0 (+ mfi ws 116e26d), K5 rates-risk 1edb15f, main 0ba1664. Recorded real testnet books (`packages/core/scripts/record-books.ts`): Meridian book EMPTY at head today (MM not running) + Meridian at block 69,059,070 (K3 run). Lockfile: hand-merged core importer (+39 lines) because `pnpm add` re-resolved the web app's zod peer; `--frozen-lockfile` passes. Open (packages/core/README §Open): Perpl min-open raw unit (getMinAccountOpenCNS vs docs' "10.0 AUSD"), enrolment Origin whitelisting (K3 enrolled without one), X-API-Key token not re-derivable + 409 on re-enrol of the deterministic key ⇒ N4 must store the token/rotation, Perpl funding sign, Hermes PBKDF2 cost. Pending owner: push + PR "[N1] packages/core: …".
- 2026-10-08 — N1 verified after merge (PR meridian#7 → main 6943fb8): re-ran core typecheck + 241 tests green, `--frozen-lockfile` OK, 7 commits SSH-signed SamyaDeb, no trailers; CI ts job green. GitGuardian flagged 3 "Generic High Entropy Secret" in `packages/core/test/{perpl-trading,keys}.test.ts` = the public RFC 8032 test key + keys derived from the fixed test PRF 0x01..0x20 — **false positives**, owner marks them "test credential" in the GitGuardian dashboard (no rotation needed). CI contracts job for that run stuck `in_progress` (not N1-related; re-run). P1 `packages/config` is NOT on main yet → N2 keeps its env behind `mobile/src/config/` so P1 can swap in. N2 prompt: docs/prompts/mobile/N2-shell.md.
- 2026-10-08 — **N3 code done, device QA deferred (owner).** assetlinks: branch `n3-assetlinks` (1b81ef7, from origin/main) → **PR meridian#9 open** (`app/public/.well-known/assetlinks.json`, package `xyz.meridianfi.app.staging`, SHA-256 `23:2F:3C:C0:…:16:B2` read with `apksigner` from EAS dev APK 199097cf, v2-signed; JSON header in next.config; vitest; local `next start` 200 `application/json`, no redirect); live URL still 404 until merge + deploy. `n3-mera` (worktree `../meridian-n3`, on n2-shell 2b10039): 78d9b04 deps · d5983c7 auth · 6160e18 wallet · 0cb6c99 screens · 4afa094 release guard + README · c20d420 MOBILE_QA N3 rows (pending). Packages: `@category-labs/mera` 0.2.0, **`react-native-passkey` 3.6.1** (Mera 0.2.0 pins it as an exact peer; prompt said 3.6.2), `@scure/bip32` 1.7.0, `@scure/bip39` 1.6.0, expo-secure-store 57.0.4, expo-clipboard 57.0.2, expo-screen-capture 57.0.4, react-native-qrcode-svg 6.3.26; no config plugin (autolinked; checked with a throwaway prebuild). Lockfile: first `pnpm add` re-resolved every importer and gave mobile a 2nd react-native instance → re-merged by hand: mobile importer gains only the new deps, their peers pinned onto the existing N2 snapshots (+124/−0 lines, one RN instance, `--frozen-lockfile` OK). Release guard `pnpm --filter @meridian/mobile check:release` (prod export with the fake flag on: clean; dev export contains it). EAS dev build **4e91111a** (same signer) ready, not installed. Open: merge #9 + verify live + Google statements API; rows P1–P7 on the phone (incl. deriveEvmKey ms → core README §Open); rebase `n3-mera` onto main after N2 merges, then PR "[N3] mobile: …". N4 notes: PRF via `auth.withFreshPrf` → `derivePerplKey(prf, chainId)`; Perpl deposit via `auth.withFreshSession` + `sendTx`; store the X-API-Key token + key rotation in SecureStore next to the credential record (extend `checkRecord` or a separate validated key).
- 2026-10-09 — **N4 code done** (meridian-n4 `n4-perpl` on n3-mera: ea74227 core PerplSigner · 5417833 key in the unlock PRF pass + token store · 4819eb7 venue (detected onboarding, one trading socket, IOC via exec/single) · 6d6dd82 screens · 83a1b4d core README §Open; unpushed). Measured: min account-open 10 AUSD mainnet / 100 testnet (eth_call); enrol payload 200 without Origin, 400 with ours; enrol 404 for a wallet Perpl never saw (app offers deposit first); funding positive ⇒ longs pay. Phone QA (N3 rows + N4 testnet) pending; mainnet canary prep awaiting owner OK.
- 2026-10-09 — **UX research** → `docs/MOBILE_UX_RESEARCH.md` (Privy/FIDO/Coinbase/Phantom/BitMEX/Bybit/Cash App/Venmo/WCAG, competitors incl. Takumi Pay). Plan updated: one-button FIDO passkey onboarding with "Wallet ready", Home-first tabs (Home · Trade · Earn · Settings), Trade Lite/Pro with a live native chart (scrub + haptics + liq line) and both books, numpad ticket sheet with plain summary and tap alternative, inline Perpl setup on first trade, deposit-arrival moment, passkey card, Activity, hallway test in N8. Owner decisions open: G1 gas for onboarding txs (recommend: clear "add a little MON" copy now, capped first-gas drip only if Sat has slack), G2 chart lib (native first), G3 Lite default.
- 2026-10-09 — Owner accepted the research recommendations: **G1** "add a little MON" copy now (first-gas drip only if Sat has slack), **G2** native chart (wagmi-charts if compatible, else svg + Reanimated; no WebView), **G3** Lite default with Pro remembered. Added the N4b phase section, the Fri/Sat build timeline, a new cut order / never-cut list, and session prompts `docs/prompts/mobile/{N4b-ux,N5-trade,N6-earn,N7-home,N8-release}.md`.
- 2026-10-09 — **N4b code done** (meridian-n4b `n4b-ux` on n4-perpl: 4175a55 identity + arrival + count-up + Home total slot · 8bd8b8f one-button passkey onboarding (Welcome "Continue with passkey" / "Use an existing passkey", FIDO hero, "Wallet ready ✓" 600 ms → Home, calm cancel, "Unlock with your fingerprint") · 2577871 Home-first tabs + Home hero + app-wide wallet feed (arrival toast + success haptic + count-up) + Add funds modal (`/fund`, moved out of onboarding: QR, copy, share, waiting → arrival) + testnet "Get test funds" (faucet MON, then mint 10,000 test AUSD from Meridian's AUSD mock, never on 143) · e3f11af Settings passkey card + Perpl copy pass (plain status, "Allow Perpl to use exactly X AUSD", success toasts, hashes behind Details) · 41b9bf9 docs + MOBILE_QA U1–U8). For N5/N7: Home total = `totalAusdWad({ walletWad, venues })` (`mobile/src/features/home/total.ts`) — N7 fills `VENUES` in `(tabs)/portfolio.tsx`; balances come from `useWalletFeed` (`features/wallet/WalletFeedProvider`, one reader app-wide) — don't start a second BalanceReader for the same wallet; shared pieces: `WalletChip`/`Identicon`, `AddressActions`, `PasskeyIcon`, `Button` `icon` + `variant="link"`, `useCountUp`, `WalletReady`/`HOME`, `ErrorLine` `calm`. Phone run pending (Metro :8085).
- 2026-10-09 — **N5 code done** (meridian-n5 `n5-trade` on n4b-ux: 0d23497 core Perpl candles reader + real testnet fixtures · cdfc8ec trade logic (chart series, numpad model, dual-book quote via core router, resume-safe Perpl + Meridian legs, persisted record) · 83d924a live layer (Meridian 20-level depth + riskParams, Perpl levels / last / fees / countdown) · 5dcaf12 Trade screen (header, Lite sparkline / Pro chart with mark-entry-liq lines + UI-thread scrub haptics + 1m–1D, position cards with swipe + visible Close, both books, numpad ticket with inline Perpl setup / move / permit deposit, hold-or-tap, executor with resume on launch, receipt + route) · 0476a91 sheet RNTL tests · a39fa37 docs). **G2 decided: own `react-native-svg` + Reanimated chart** (wagmi-charts not used: depends on redash for Reanimated 2/3, untested on 4.5, would need a lockfile merge) ⇒ no EAS build needed. Root provider order changed: Toast / wallet feed / Trade now above `BottomSheetModalProvider` (sheet content is portaled). Not built (cut order): Pro Trades tab, candlestick bodies (line of candle closes instead), TP/SL. Phone rows T1–T8 + PROOF entries pending (needs Perpl testnet AUSD ≥ 100 for onboarding and the MM bot for Meridian liquidity).
- 2026-10-09 — **Cloud setup:** branch `mobile` on SamyaDeb/meridian = n5-trade (N2→N3→N4→N4b→N5, all green: core 252, mobile 220, release guard OK) + N2 QA rows from the meridian-m worktree + `.claude/` (skills, SessionStart hook: SamyaDeb identity + pnpm 10.18.3 frozen install, attribution off) + `CLAUDE.md` + `docs/mobile/` (plans, prompts, `CLOUD.md` path map and rules). Cloud sessions branch from `origin/mobile`, PR into `mobile`, owner re-signs before merge; phone runs, EAS, deploys and txs stay local. Phase branches n2-shell…n5-trade stay local (unpushed) as the per-phase history.
- 2026-10-09 — **N7 code done** (cloud session, `n7-home` from `origin/mobile`, PR into `mobile`; owner re-signs). Home total = wallet (`useWalletFeed`) + Meridian AccountView `equity` (collateral is inside it, ClearingHouse.sol getAccount) + Perpl `balanceCNS` + MON position deposit + delta + premium PnL (dex-sdk account.rs: balance excludes open positions; position bitmap decoded per dex-sdk `perpetuals_with_position`, matches the recorded K3 account) — any unknown part ⇒ "—" + the reason in the breakdown sheet; same `AccountsReader` as Trade, now held by a focus counter (Home, Trade, liq alert). Hero shows **Open PnL** (not "today's": no honest daily baseline without the indexer). Position cards gain a funding line + basis grouping (equal/opposite fallback; N6 `basisId` later). Activity: app receipts log (SecureStore, newest 25) + Perpl fills (grouped per order) + account-history (deposit / withdrawal / liquidation / funding) + Meridian indexer only with `EXPO_PUBLIC_INDEXER_URL` (> VERIFY Hasura root fields); merged, deduped, each row → receipt/detail, pull-to-refresh. Perpl `txid` is bare hex in recorded fills ⇒ normalised to 0x. Settings: in-app alerts (liq < 5 % with 6 % re-arm, funding flip), opt-in, no OS permission (no push in this build); "Open full terminal" (staging URL; prod > VERIFY). Cut per the cut order: push (no `/api/push` backend + new native dep), share card, Flip / Add margin / Close all. No new native deps ⇒ dev build `4e91111a` still valid. Phone rows MOBILE_QA H1–H7 pending (Metro :8088).
