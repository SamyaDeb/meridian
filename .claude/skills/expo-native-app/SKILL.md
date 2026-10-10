---
name: expo-native-app
description: Build, run and ship Meridian's native iOS + Android app with Expo / React Native (mobile/ workspace) — dev builds on real phones, pnpm monorepo + shared packages/core, Hermes polyfills for viem/noble, Mera native passkeys (react-native-passkey, associated domains, assetlinks), Reanimated/gesture/bottom-sheet UX, haptics, push (expo-notifications), EAS Build/Submit (Android APK internal link, iOS TestFlight), Maestro tests. Use for any MOBILE_PLAN N-phase, "native app", "install on my phone", Expo, React Native, EAS, TestFlight or APK work.
---

# Expo native app (Meridian)

Plan: `/Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md` (N0–N10). Visual rules: `mobile-app-ui-design`, `frontend-design`. Passkey rules: `mera-passkeys`. Perpl: `perpl-api`. Device testing: `phone-test`.

Always install Expo-managed native packages with `npx expo install <pkg>` so versions match the SDK; pin everything; never guess an API — read the package's docs for the installed version, or write `> VERIFY`.

## 1. Project shape
- `mobile/` = Expo app (expo-router, TypeScript strict), workspace `@meridian/mobile`; `packages/core` = pure TS shared logic (no Node built-ins; must run on Hermes).
- pnpm monorepo: follow Expo's current monorepo guide for Metro (`watchFolders` at repo root, resolver for workspace packages). Repo `.npmrc` isolates the linker — don't switch it to hoisted globally (Privy/wagmi break on the web app); if Expo needs hoisting, scope it per Expo's docs. Never print `~/.npmrc`.
- Config in `app.config.ts`; secrets/env via EAS environment variables, never committed.

## 2. Polyfills (first import in the entry file)
- `crypto.getRandomValues` via `expo-crypto` (Hermes lacks it; viem, noble, Mera need it).
- Check `TextEncoder`/`TextDecoder`, `atob`/`btoa`, `structuredClone` availability on the Hermes version shipped by the SDK before adding polyfills; add only what's missing.
- No `Buffer`/`node:crypto` in shared code: use `@noble/hashes` + Uint8Array helpers.

## 3. Running on real phones
- Expo Go **cannot** run Mera (native passkey module). Always a development build:
  - `npx expo prebuild` (generates ios/ android/; re-run after native config changes)
  - iOS: `npx expo run:ios --device` (Xcode signing with the Apple team; Developer Mode on the iPhone)
  - Android: `npx expo run:android --device` (USB debugging on) — or `eas build --profile development` and install the link.
- Then `npx expo start --dev-client` for fast refresh. Logs: Metro terminal; native crashes: Xcode console / `adb logcat`.

## 4. Passkeys (Mera) — native specifics
- Packages: `@category-labs/mera` ≥ 0.2.0, `react-native-passkey`, `viem`, `@scure/bip32`, `@scure/bip39`, `expo-crypto`. Pass `reactNativeWebAuthnClient` (from `@category-labs/mera/react-native-webauthn-client`) as `webAuthnClient` to every passkey call.
- iOS: `ios.associatedDomains: ["webcredentials:<rpId>"]` + `https://<rpId>/.well-known/apple-app-site-association` `{"webcredentials":{"apps":["<TEAM_ID>.<bundleId>"]}}`. Needs the Apple Developer Program team.
- Android: `https://<rpId>/.well-known/assetlinks.json` with `delegate_permission/common.get_login_creds`, package, SHA-256 of **every** signing cert (debug keystore `keytool -list -v -keystore android/app/debug.keystore -alias androiddebugkey -storepass android`, EAS key from `eas credentials`). HTTPS, JSON, no redirects.
- First-call `PASSKEY_OPERATION_FAILED` ⇒ association file wrong/unreachable/redirecting — check with `curl -sI` before debugging code.
- Same rpId + passkey + index ⇒ same address on web and native.
- Never put PRF output / keys in AsyncStorage, SecureStore, logs or crash reports. SecureStore holds only the credential id and non-secret prefs.
- Don't add Privy's Expo SDK to this app (it uses a different passkey module, `react-native-passkeys`); Privy lives in the web app.

## 5. Native-grade UX toolkit
- Animations: `react-native-reanimated` (UI thread), gestures `react-native-gesture-handler`, sheets `@gorhom/bottom-sheet`, safe areas `react-native-safe-area-context`.
- Haptics `expo-haptics`: selection on slider detents/segment changes, impact light on hold start, notification success/error on fills/failures. Never the only signal.
- Lists: `FlatList`/`FlashList` with stable keys; no inline heavy renders; memoise rows; live per-block values in small leaf components so a block tick doesn't re-render screens.
- Numbers: tabular figures, fixed widths so ticking values don't jitter; colour + sign for PnL, never colour alone.
- Accessibility: `accessibilityLabel`/`Role` on every control, Dynamic Type (`allowFontScaling`, test at large sizes), contrast ≥ 4.5:1, tap targets ≥ 44 pt.
- AppState: pause sockets/polling in background, refetch on foreground, end signing sessions after the idle timeout.
- Errors: plain language + what to do; error haptic; never raw revert data.
- Icons/splash: iOS 1024 px icon, Android adaptive icon (foreground + background), dark splash matching the first screen.

## 6. Push notifications
`expo-notifications`: request permission in context (e.g. "Alert me before liquidation"), get the Expo push token, register it with the backend; send from the backend through Expo's push service. iOS needs an APNs key and Android FCM credentials configured in EAS — follow the current Expo push setup guide for the installed SDK.

## 7. Builds and distribution (EAS)
- `eas.json` profiles: `development` (dev client), `preview` (Android `buildType: apk`, `distribution: internal` → install link/QR for anyone), `production`.
- Android: `eas build -p android --profile preview`. Add the EAS signing SHA-256 to assetlinks before testing passkeys on it.
- iOS: `eas build -p ios --profile production` then `eas submit -p ios` → TestFlight. Internal testers: no review. Public/external link: Beta App Review (allow ~24 h).
- JS-only changes after a build: `eas update` (if expo-updates is configured) — native changes need a new build.
- Builds and submissions are outward-facing and use the owner's accounts: confirm with the user before the first `eas build`/`submit` of each profile.

## 8. Testing
- `packages/core`: vitest (rounding direction asserted, fixtures, no network).
- Components: jest-expo + React Native Testing Library (versions matching the SDK).
- Flows: Maestro YAML in `mobile/.maestro/` on emulator/simulator; passkey steps only on real devices (dev-only bypass hook, compiled out of release builds).
- Device QA matrix: see `phone-test` §5 plus background/foreground, kill-resume mid-trade, Dynamic Type large, VoiceOver/TalkBack.
