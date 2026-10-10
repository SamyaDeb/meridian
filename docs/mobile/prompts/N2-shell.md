You are the senior blockchain + React Native engineer for Meridian (public name; internal codename Pulse). This session
executes MOBILE_PLAN phase **N2 — Expo shell, design system, live layer** (`mobile/`, workspace `@meridian/mobile`):
the native Android app's skeleton that every later phase (N3 Mera, N4 Perpl, N5 Trade, N6 Earn, N7 Portfolio) builds
on. It must be production-grade from the first commit: real chain data, no sample numbers, 60 fps, installable on a
real Android phone via an EAS cloud dev build.

## 1. Read first (fully, in this order)
1. /Users/samya/Downloads/meridian-m/CONTRIBUTING.md (public-repo rules: never invent, rounding, tests, commits)
2. /Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md — §0 (all), §1 (product spec: nav, screen contracts, UX bar),
   §2 Architecture, phase **N2**, skim N3/N5 (what the shell must make easy), §5 log (all 8 Oct decisions)
3. /Users/samya/Downloads/Meridian/docs/LAUNCH_PLAN.md §3.1 (`packages/config` = P1, separate) and the EAS/env lines
   (APP_ENV → env, profiles development / preview / production)
4. /Users/samya/Downloads/meridian-m/packages/core/README.md (module map, Hermes rules, §Open) — you consume core,
   you don't change it (except a bug fix with a test, called out in the PR)
5. Skills: load `expo-native-app` (all), `mobile-app-ui-design`, `frontend-design`; `phone-test` §5 for QA rows.

## 2. Context (verified 8 Oct — don't re-derive)
- Working clone `/Users/samya/Downloads/meridian-m`, origin `github.com/SamyaDeb/meridian`. **main = 6943fb8**
  (N1 merged: `packages/core`, 241 tests). Branch **`n2-shell` from origin/main**. HTTPS `git fetch` fails with the
  active gh account — fetch/push with the SamyaDeb token:
  `T=$(gh auth token -u SamyaDeb); git -c credential.helper= -c "credential.helper=!f(){ echo username=SamyaDeb; echo password=$T; }; f" fetch origin`
- Node **24** (`nvm use 24`; Mera RN needs ≥ 24), pnpm 10.18.3. Repo `.npmrc` = `node-linker=isolated`: **never change
  it or switch to hoisted** (breaks the web app's Privy/wagmi); never print ~/.npmrc. Use Expo's current pnpm /
  monorepo guide for the installed SDK (> VERIFY isolated-linker support for that SDK). If Metro can't resolve under
  the isolated linker, stop and report the exact error; do not hoist the workspace.
- CI (`.github/workflows/ci.yml`) runs on Node 22: `pnpm install --frozen-lockfile`, `pnpm -r --if-present run
  lint|typecheck|test`. Your `mobile` scripts must pass there (no device needed for typecheck/test).
- **Lockfile gotcha (from N1):** `pnpm add` can re-resolve other importers (it moved the web app's zod peer 4.6.5 →
  3.25.76). After installing, diff `pnpm-lock.yaml`: only the `mobile` importer + its new packages may change.
  Hand-restore any unrelated importer change, then `pnpm install --frozen-lockfile` must pass and
  `pnpm --filter @meridian/app typecheck` stay green.
- **Platform decisions:** Android-only native (no Apple program → no iOS build, no TestFlight, no AASA). Still keep
  the code platform-neutral (no Android-only APIs without a guard). Android package `xyz.meridianfi.app`, staging
  `xyz.meridianfi.app.staging` (both installable side by side). Passkey rpId prod `meridianfi.vercel.app`, staging
  `meridian-testnet.vercel.app` (N3 uses them; N2 only puts them in config).
- **Install path (owner chose):** EAS **cloud** dev build (`eas build -p android --profile development`) → install
  link/QR on the phone → `npx expo start --dev-client` over Wi-Fi. No local Android build required, no USB required
  (Android SDK + adb are installed if you want `adb logcat`). EAS CLI is logged in as `samyadeb`. **Ask me before
  the first `eas init` / `eas build`** (outward-facing, uses the owner's account and build quota).
- **P1 `packages/config` is NOT on main yet.** Don't build it. Put all env in `mobile/src/config/` behind one typed
  `getAppConfig()` that reads: `APP_ENV` (`development|staging|production`) → chain id (10143 for development and
  staging, 143 for production), rpId, package, and the deployment JSON via core's `tryReadMeridianDeployment` /
  `tryReadPerplDeployment` (import `deployments/{10143,perpl}.json`; `143.json` doesn't exist until mainnet day ⇒
  the production profile must show a clear "not live yet" state, never crash). When P1 lands, only this module changes.
- RPC: `EXPO_PUBLIC_MONAD_RPC_URL` (+ optional `EXPO_PUBLIC_MONAD_WS_URL`) from `mobile/.env.local` (gitignored) and
  EAS env vars; never committed, never logged. `EXPO_PUBLIC_*` is embedded in the APK ⇒ it must be the app-tier key,
  never the bots' key. Default to viem's public `monadTestnet` RPC from `viem/chains` only in development, with a
  visible "public RPC" badge. Perpl REST/WS bases come from `deployments/perpl.json` / the `perpl-api` skill.
- Today the Meridian testnet book may be empty (the MM runs only during test sessions). Empty book ⇒ "—" / "No
  liquidity right now", never fake levels.

## 3. Hard rules
- Never invent addresses, IDs, decimals, URLs, package names or package APIs. Install Expo-managed packages with
  `npx expo install` (versions match the SDK); pin everything else; read the installed version's docs or write
  `> VERIFY: <what, where>` and continue against a typed mock.
- Every number on screen comes from chain / Perpl API / core math. Zero shows zero, unknown shows "—", stale data
  is visibly marked stale. No sample data in any build profile except Storybook-style dev screens behind `__DEV__`.
- Money math only through `@meridian/core` (bigint, WAD). Floats only for display formatting.
- viem only (no ethers). Strict TS (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` as the repo base).
- No key material anywhere in N2 (no Mera yet). Don't add Privy's Expo SDK (wrong passkey module, see §0.6).
- Polyfills: `mobile/polyfills.ts` is the **first import** of the entry; `crypto.getRandomValues` via `expo-crypto`;
  add `TextEncoder`/`atob`/`structuredClone` polyfills only if the Hermes smoke (§4.7) proves they're missing.
- Performance: per-block values live in small leaf components (subscribe to the block store, memoised rows); a block
  tick must not re-render a screen. Animations on the UI thread (Reanimated worklets).

## 4. Deliverables
1. **Scaffold** `mobile/` with `create-expo-app` (TypeScript + expo-router), latest stable Expo SDK, pinned; package
   name `@meridian/mobile`; scripts `start`, `typecheck`, `test`, `lint` (if the template ships one); Metro config for
   the pnpm monorepo (watchFolders = repo root; `@meridian/core` resolves from source `.ts` via its exports map and
   `@meridian/abis/*.json` resolves — > VERIFY package-exports support in the SDK's Metro). Core uses TypeScript 7;
   check `mobile`'s typecheck of imported core sources works with the TS version Expo expects and note the choice.
   New Architecture as the SDK default. Add `mobile/.gitignore` (`android/`, `ios/`, `.env*`, keystores).
2. **`app.config.ts`**: name "Meridian", slug, scheme, `android.package` per APP_ENV (`.staging` suffix for staging,
   app name "Meridian Staging"), `userInterfaceStyle: "dark"`, adaptive icon (fg + bg) + splash matching the first
   screen's background, `extra` = non-secret env only; **no `ios.associatedDomains`** (no Apple team). Placeholder
   icon art is fine if clearly simple and on-brand (no stock images).
3. **`eas.json`**: `development` (dev client, internal, Android APK, APP_ENV=development), `preview` (APK, internal,
   APP_ENV=staging), `production` (APP_ENV=production; Android `buildType: apk` for internal link — Play not in
   scope). Env vars referenced by name only.
4. **Design system** `mobile/src/ui/` — write `mobile/DESIGN.md` first (one page: palette tokens, ≤ 4 type sizes,
   8-pt spacing, radii card 14 / inner 10 / control 8 matching the web terminal, motion rules, haptics map, a11y
   rules), then: `tokens`, `Text`, `Num` (tabular numerals, fixed width, sign + colour for PnL, "—" for unknown),
   `Button`, `HoldButton` (Reanimated ring, 600 ms, haptic on start + success, cancel on release, a11y action
   fallback), `Sheet` (@gorhom/bottom-sheet), `Slider` (haptic detents), `Segmented`, `Skeleton`, `Toast`,
   `SwipeRow` (+ button fallback), `Sparkline` + `Meter` (react-native-svg), `BlockPulse` (dot + block number),
   `OfflineBanner`, `NetworkBadge`. Every control: `accessibilityLabel`/`Role`, ≥ 44 pt targets, works with large
   font scale (no clipped numbers).
5. **Live layer** `mobile/src/live/`: one viem `publicClient` per chain; `BlockProvider` + `useBlockNumber()` (WS
   subscription if `EXPO_PUBLIC_MONAD_WS_URL` is set and works, else ~400 ms `getBlockNumber` poll with back-off on
   429), feeds core's `CadenceMeter`; pause on background (`AppState`), resume + refetch on foreground; network state
   → offline banner + writes disabled flag (for later phases). Perpl market-data WS manager using core's
   `MarketDataSocket` / `MarketDataFeed` with RN `WebSocket` injected (≤ 16 subscriptions; reconnect via core's
   delays; paused in background). Small external store (`useSyncExternalStore` or zustand if you justify it) so
   leaf components subscribe to just what they show.
6. **Navigation** per MOBILE_PLAN §1.1: `(onboarding)/welcome|create|fund|perpl`, `(tabs)/trade|earn|portfolio|settings`,
   modals route / receipt / position / close-all — placeholders, but each wired to real live data where it has any:
   - **Welcome (real):** Meridian funding APR vs Perpl funding APR for MON + the spread, from chain reads + Perpl
     API through core (`meridianEffectiveAprWad`, `perplRealizedApr`, `spreadAprWad`), ticking with `BlockPulse`;
     "Continue with Face ID" button routes to `create` (N3 fills it). Read the ClearingHouse funding view names
     from `abis/ClearingHouse.json` — don't guess.
   - Trade / Earn / Portfolio: header with live mark prices of both venues + best bid/ask (or "No liquidity right
     now"); Settings: network badge, block cadence, app version + build profile.
7. **Hermes smoke screen** (dev menu route, `__DEV__` only, compiled out of release): runs on the phone and shows
   pass/fail + ms for: `crypto.getRandomValues`, `TextEncoder`, `atob/btoa`, `structuredClone`, an Ed25519
   sign/verify via core (`derivePerplKey` on a fixed public test seed), `deriveEvmKey` (PBKDF2 × 2048 — record the ms;
   N3 needs it), JSON ABI import, a bigint JSON round-trip, one viem `getBlockNumber`, one Perpl REST call. This
   closes N1's open "Hermes runtime cost and globals" item — put the measured numbers in core README §Open.
8. **Tests**: jest-expo + React Native Testing Library (versions per SDK): config (env → chain, 143 "not live"
   path), block store (pause/resume, back-off, no re-render of siblings), formatters through `Num`, HoldButton
   complete/cancel, Welcome renders "—" on missing data and real values with a mocked client. No network in tests.
9. **CI**: add `mobile` to whatever the ts job already runs via `pnpm -r` (no new job unless needed); make sure
   jest doesn't need a device or Android SDK.

## 5. Real-device acceptance (I do the tapping — tell me exactly what to tap/approve)
After I approve: `eas init` (project id into app.config), `eas build -p android --profile development`, print the
install URL + QR (`npx qrcode-terminal`), then `npx expo start --dev-client` (LAN; tunnel only if LAN fails). Then
walk me through: open app → Welcome ticks per block → switch tabs → open a sheet → hold-to-confirm demo → background
30 s → foreground resumes → airplane mode → offline banner → Hermes smoke screen all green (send me the numbers).
Ask me for screenshots / a screen recording and look at them.

## 6. Done = acceptance
- `pnpm -r typecheck` and `pnpm -r test` green on Node 22 and 24; `pnpm install --frozen-lockfile` passes; lockfile
  diff limited to the mobile importer.
- Dev build installed on my Android phone; Welcome shows real Meridian + Perpl funding and spread, ticking per
  block; tabs + sheets smooth; dark theme, safe areas, adaptive icon, splash; Hermes smoke all green.
- Tick only the boxes you verified yourself; list the ones that need me on the phone.

## 7. Git / PR
- Branch `n2-shell` from origin/main (6943fb8). Conventional commits (`chore(mobile): scaffold …`, `feat(mobile): …`,
  `test(mobile): …`), small and logical. **SSH-signed, author SamyaDeb only, NO Claude / Co-Authored-By trailers.**
- Never commit `.env*`, `android/`/`ios/` prebuild output, keystores, `google-services.json`, EAS secrets.
- No test vectors that look like secrets (GitGuardian flagged N1's RFC 8032 / fixed-seed vectors as false
  positives): derive any test key at runtime from an obviously synthetic seed, never paste hex keys.
- Don't push or open a PR without asking me; when I say so:
  `GH_TOKEN=$(gh auth token -u SamyaDeb) gh pr create -R SamyaDeb/meridian --title "[N2] mobile: Expo shell, design system, live layer"`

## 8. Finish
Report: SDK + key package versions, Metro/pnpm setup and any gotcha, Hermes smoke numbers (esp. `deriveEvmKey` ms),
every `> VERIFY`, what's verified vs what needs me on the phone, anything that blocks N3 (Mera) / N5 (Trade).
Update MOBILE_PLAN §3 (N2 status) and append a §5 log line in /Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md.
