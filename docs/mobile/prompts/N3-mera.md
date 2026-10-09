You are the senior blockchain + React Native engineer for Meridian (public name; internal codename Pulse). This session
executes MOBILE_PLAN phase **N3 — Mera Face ID login (native, Android)**: a seedless EVM wallet from a passkey (WebAuthn
PRF) via `@category-labs/mera`, held in memory as a viem account, with session security, recovery-phrase export and a
gas-safe send helper. This is the identity + signing foundation for N4 (Perpl), N5 (Trade) and N6 (Earn). Treat it as
wallet code: correctness and key hygiene beat speed.

## 1. Read first (fully, in this order)
1. /Users/samya/Downloads/meridian-m/CONTRIBUTING.md
2. /Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md — §0 (all; §0.5 Mera rows), §1.1–§1.2 (onboarding/create,
   Settings), §2, phase **N3**, glance N4 (it re-uses the PRF for the Perpl key), §5 log (8 Oct decisions)
3. `mobile/README.md`, `mobile/DESIGN.md`, `mobile/src/config/appConfig.ts`, `mobile/src/app/(onboarding)/*`,
   `mobile/src/app/(tabs)/settings.tsx`, `mobile/src/live/clients.ts`, `mobile/polyfills.ts` (N2 shell you build on)
4. `packages/core/README.md` + `packages/core/src/keys/index.ts` (`deriveEvmKey`, `recoveryPhrase`, `derivePerplKey`),
   `packages/core/src/meridian/gas.ts`
5. Skills: `mera-passkeys` (all; §3 is web/wagmi — not for native), `expo-native-app` §2–§4, §7, §8; `phone-test` §5.
6. Mera RN docs: docs.monad.xyz/guides/mera/react-native.md (read the current page; it is the API source of truth).

## 2. Context (verified 8 Oct ~19:00 IST — don't re-derive)
- Clone `/Users/samya/Downloads/meridian-m`. **N2 is not merged yet**: branch `n2-shell` (9 signed commits, Expo SDK
  57.0.27, RN 0.86.3, React 19.2.3, TS 6.0.3 in mobile; all repo typecheck/tests green) is in device QA in another
  session (Metro on :8081 LAN and :8082 tunnel — **don't kill those processes, don't commit on `n2-shell`**).
  origin/main = a4e08e4 (adds ETH-PERP: `deployments/10143.json` gained an additive `markets[]`; merges cleanly with
  n2-shell). **Create `n3-mera` from `n2-shell`** (stacked). When N2 merges, `git rebase --onto origin/main n2-shell n3-mera`.
  The mobile app stays MON-PERP only; ignore `markets[]` (ETH) in N3.
- Fetch/push via the SamyaDeb token (HTTPS with the active gh account fails):
  `T=$(gh auth token -u SamyaDeb); git -c credential.helper= -c "credential.helper=!f(){ echo username=SamyaDeb; echo password=$T; }; f" fetch origin`
- Node 24 (`nvm use 24`), pnpm 10.18.3, repo `.npmrc` `node-linker=isolated` — never change/hoist; never print ~/.npmrc.
  **Lockfile gotcha:** after adding deps, only the `mobile` importer may change in `pnpm-lock.yaml`; hand-restore any
  other importer, then `pnpm install --frozen-lockfile` and `pnpm --filter @meridian/app typecheck` must pass.
- Packages (npm, 8 Oct): `@category-labs/mera` **0.2.0** (latest; first with React Native), `react-native-passkey`
  **3.6.2** (peer react/react-native `*`). Pin exact. Install `expo-crypto` / other Expo modules with `npx expo install`.
  Mera's RN entry: `reactNativeWebAuthnClient` from `@category-labs/mera/react-native-webauthn-client`, passed as
  `webAuthnClient` to `createPasskeyWithPrfOutput({ rp, user, webAuthnClient })` and
  `getPasskeyPrfOutput({ rpId, webAuthnClient })` (MOBILE_PLAN §0.5) — confirm against the installed 0.2.0 typings.
- **Android only** (no Apple program). Dev build package `xyz.meridianfi.app.staging`, rpId (from `getAppConfig()`)
  **`meridian-testnet.vercel.app`** for development/staging; production `xyz.meridianfi.app` / `meridianfi.vercel.app`.
- **Domain association is NOT in place yet:** `https://meridian-testnet.vercel.app/.well-known/assetlinks.json` and
  `https://meridianfi.vercel.app/.well-known/assetlinks.json` both return **404** today. The web app (`app/`, Vercel
  project `meridian-testnet`, deployed from SamyaDeb/meridian) has no `app/public/.well-known/`. Its Next 16 proxy
  (`app/src/proxy.ts`) skips `*.json` paths, so a static `app/public/.well-known/assetlinks.json` is served without a
  rewrite/redirect. `meridianfi.vercel.app` is a separate placeholder project — production assetlinks is N9, not N3.
- Mera on the web app (W1) does not exist yet ⇒ the "same address on web" cross-check is deferred to W1; in N3 prove
  address stability via sign-in after reinstall and via recovery-phrase import in MetaMask/Rabby.
- The existing EAS dev build (`199097cf…`) has no passkey module ⇒ N3 **needs a new dev build** (same EAS keystore,
  so the signing SHA-256 doesn't change). Native modules ⇒ `npx expo prebuild` locally only to inspect; never commit
  `android/`.
- `deriveEvmKey` (PBKDF2-SHA512 × 2048 on Hermes) cost is still unmeasured unless the N2 session recorded it in
  `docs/outputs/MOBILE_QA.md` / core README — read those; if absent, measure it on the phone in N3.
- New addresses have 0 MON on testnet. Anything that sends a tx needs the owner to fund the address (faucet) — ask.

## 3. Hard rules (wallet-grade)
- Never invent package exports, error codes, config-plugin names or Android manifest keys: read the installed
  package's typings/README or the Mera docs; else `> VERIFY: <what, where>` and continue against a typed fake.
- **Key material** (PRF output, private key, mnemonic, Ed25519 secret) lives only in memory during a session: never in
  SecureStore/AsyncStorage/MMKV/files, logs, error reports, React state that DevTools can dump, navigation params, or
  test snapshots. Zero `Uint8Array`s after use (`fill(0)`); `session.end()` on lock. SecureStore holds only
  `{ credentialId, transports?, createdAt, addressHint }` — address is public, fine for a "Welcome back 0x12…ab" hint.
- Add a test that scans every SecureStore/AsyncStorage write in the app (mocked) and fails on 32/64-byte hex or
  12/24-word phrases; and an ESLint/grep test that `console.*` never receives a key-bearing variable in `src/auth`.
- Assert at startup that `getAppConfig().rpId` is one of the two known rpIds for the build's APP_ENV; refuse passkey
  creation otherwise (prevents stranding users on a wrong host).
- Signing: viem only. Gas limit = `estimateGas × 1.2` ceil (core `gas.ts`), Monad bills the limit. Explicit
  `chainId`, nonce from `getTransactionCount(…, "pending")`, EIP-1559 fees from the client; wait for receipt; decode
  reverts with the ABI to plain English (port `app/src/lib/tx.ts` behaviour, tests first).
- Value-moving actions (withdraw, Perpl deposit in N4, recovery export) re-prompt the passkey and use a fresh per-tx
  session that ends right after. No biometric bypass in release builds; a dev-only fake WebAuthn client is allowed
  behind `__DEV__ && APP_ENV==="development"` and must be tree-shaken from release (assert in a test like N2's smoke).
- Real data only. Plain-language errors. Haptics per DESIGN.md (success on create/sign-in, error on failure).
- Strict TS; tests first; small signed commits.

## 4. Deliverables (`mobile/src/auth/`, `mobile/src/wallet/`, screens)
0. **Assetlinks (do first — a separate tiny PR so it can go live before the app code):** branch `n3-assetlinks` from
   origin/main with `app/public/.well-known/assetlinks.json`:
   relations `["delegate_permission/common.get_login_creds", "delegate_permission/common.handle_all_urls"]`,
   target `{ namespace: "android_app", package_name: "xyz.meridianfi.app.staging", sha256_cert_fingerprints: [<EAS
   Android keystore SHA-256 for this package>] }`. Get the fingerprint from EAS (`npx eas-cli credentials -p android`,
   development/staging profile — interactive: tell me what to pick) or from the built APK (`apksigner verify
   --print-certs`, or `keytool -printcert -jarfile` if v1-signed). Ensure `Content-Type: application/json` (add a
   `headers()` entry in `app/next.config.*` for `/.well-known/assetlinks.json` if Next doesn't already serve it as JSON).
   Add a vitest/Playwright check that the file parses and lists the package. Ask me to push + open
   "[N3] web: assetlinks for the Android staging app" and merge it; then verify live:
   `curl -sI https://meridian-testnet.vercel.app/.well-known/assetlinks.json` → 200, `application/json`, no 3xx;
   and Google's checker `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://meridian-testnet.vercel.app&relation=delegate_permission/common.get_login_creds`.
1. **Deps** on `n3-mera`: `@category-labs/mera@0.2.0`, `react-native-passkey@3.6.2`, `@scure/bip32`/`@scure/bip39`
   (same versions as core), `expo-secure-store`, `expo-local-authentication` only if used for app-lock, a screenshot
   blocker for the recovery screen (`expo-screen-capture` — `> VERIFY` API for SDK 57). Config plugins only if the
   packages' docs require them. Polyfill order: `polyfills.ts` stays first; confirm Mera's RN requirements (getRandomValues
   via expo-crypto) on device.
2. **`auth/passkey.ts`** — `createAccount(displayName)` → `createPasskeyWithPrfOutput({ rp: { id: rpId, name: "Meridian" },
   user: { name, displayName }, webAuthnClient })`; `signIn()` → `getPasskeyPrfOutput({ rpId, webAuthnClient,
   credential? })` (stored credential first; no stored id ⇒ discoverable picker). Store only the credential record.
3. **`auth/session.ts`** — pure state machine (tests first): `LOCKED → UNLOCKING → UNLOCKED(session) → LOCKED`;
   derive via core `deriveEvmKey(prf, 0)` (off the first paint: show "Unlocking…" if it takes > 300 ms), Mera
   `createSecp256k1SigningSession({ privateKey })`, `toViemAccount(session)`; wipe PRF + key bytes immediately after;
   idle lock 10 min (touch = activity); `AppState` background > 5 min ⇒ lock; sign-out ⇒ `session.end()` + clear
   credential record (with confirm). Per-tx session helper `withFreshSession(fn)` for value-moving actions.
4. **`wallet/`** — `walletClient(account)` per chain from N2's clients; `sendTx({ to, data, value })` with the hard-rule
   gas/nonce/fee/receipt/revert handling; `useAccount()` (address, locked state); AUSD + MON balance reads for the
   Fund screen (AUSD address/decimals from deployments + core readers, never typed in).
5. **Screens** (DESIGN.md components, a11y labels, 44 pt):
   - `(onboarding)/create`: "Create with fingerprint / Face" (primary) + "I already have one" (sign in); progress +
     plain errors: `PRF_UNAVAILABLE` → "This phone's passkey provider can't create a wallet. Use Google Password
     Manager (Android 9+) and try again."; `PASSKEY_OPERATION_FAILED` on first call → "Couldn't verify Meridian's passkey
     domain" (dev: log host + package + the curl hint, no secrets); cancel → "Cancelled. Try again."; `SESSION_ENDED` →
     silent re-prompt on next action.
   - `(onboarding)/fund`: address, copy (expo-clipboard), QR (react-native-qrcode-svg, `> VERIFY` version for SDK 57),
     live AUSD + MON balances ticking per block, testnet faucet hint (link only).
   - Welcome: returning user (credential record present) ⇒ "Unlock" instead of "Continue".
   - Settings: address + copy, lock now, sign out, **Export recovery phrase**: fresh passkey prompt →
     `recoveryPhrase(prf)` shown once, screenshots blocked, auto-hide on background, explicit warning, never copied
     to clipboard by default.
   - Auth gate in `_layout.tsx`: tabs need UNLOCKED; deep links to tabs while locked go to Unlock.
6. **Tests** (jest-expo + RNTL, no network, fake WebAuthn client): session machine (all transitions, idle/background
   timers with fake clock), wipe-after-derive, storage scan, rpId guard, error → message mapping, create/sign-in screens,
   sendTx (gas ×1.2 ceil, nonce pending, revert decode) against a mocked client, release-build exclusion of the fake
   client. Re-use core's fixed-vector test for the address from a synthetic PRF (derive at runtime — **no hex keys or
   phrases pasted in tests**, GitGuardian flagged N1's).

## 5. Real-device acceptance (I do the tapping — tell me exactly what to tap/approve)
Prereqs I may need to do: Google Password Manager signed in and set as passkey provider; screen lock set; phone on the
same Wi-Fi. After assetlinks is live and **after I approve**: `eas build -p android --profile development` (new dev
client with react-native-passkey), give me the install link, run Metro on a port not used by the N2 session.
1. Create account → fingerprint/face → address shown; no secrets in SecureStore (show me the stored record keys only).
2. Kill app → reopen → Unlock → **same address**. Uninstall → reinstall → "I already have one" → **same address**.
3. Settings → Export recovery phrase → import into MetaMask/Rabby on the phone or desktop → **same address** (I check).
4. Idle 10 min (or a dev-shortened timer behind `__DEV__`) → locked; background > 5 min → locked.
5. If I fund the address with testnet MON: send a 0-value self-transfer → receipt shown; gas limit = estimate × 1.2.
6. Cancel the prompt → friendly error; airplane mode during unlock → readable error.
Record each row in `docs/outputs/MOBILE_QA.md` (new "N3" section; ✅/❌, seen by owner vs claude, phone + Android version).

## 6. Done = acceptance
- assetlinks live (200 JSON, no redirect, Google statements API lists it); `pnpm install --frozen-lockfile`,
  `pnpm -r typecheck`, `pnpm -r test` green (Node 24; mobile also on Node 22); lockfile diff = mobile importer only.
- Rows 1–4 verified on my phone (5 if funded). Tick only what was seen; list what still needs me.
- deriveEvmKey on-device time recorded (MOBILE_QA + core README §Open closed if N2 didn't).

## 7. Git / PR
- Two branches: `n3-assetlinks` (from origin/main, tiny, first) and `n3-mera` (from `n2-shell`). Conventional commits
  (`feat(mobile): …`, `feat(web): …`, `test(mobile): …`). **SSH-signed, author SamyaDeb only, NO Claude / Co-Authored-By
  trailers.** Never commit `.env*`, keystores, `android/`, credentials JSON.
- Ask me before every `eas build`, push, PR, or `eas credentials` change. PR for `n3-mera` only after N2 is merged and
  you've rebased: `GH_TOKEN=$(gh auth token -u SamyaDeb) gh pr create -R SamyaDeb/meridian --base main --head n3-mera
  --title "[N3] mobile: Mera passkey login, session security, recovery export, send helper"`.

## 8. Finish
Report: package versions + any config plugin, the assetlinks fingerprint source, on-device deriveEvmKey ms, device QA
table (owner-verified vs seen), every `> VERIFY`, and what N4 needs (PRF re-use for `derivePerplKey`, per-tx session
for the Perpl deposit, where the Perpl API token will be stored). Update MOBILE_PLAN §3 (N3 status) and append a §5 log
line in /Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md.
