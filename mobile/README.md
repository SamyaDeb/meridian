# @meridian/mobile

Meridian's native app (Expo SDK 57 / React Native 0.86, Android first): shell, design system (`DESIGN.md`) and live
layer. Money math comes from `@meridian/core`; env lives behind `src/config` (`getAppConfig()`).

```
pnpm --filter @meridian/mobile typecheck
pnpm --filter @meridian/mobile test          # jest-expo, no device, no network
cd mobile && npx expo start --dev-client     # needs a dev build installed on the phone
```

Env (never committed): `mobile/.env.local` or EAS environment variables
- `EXPO_PUBLIC_MONAD_RPC_URL` — the app-tier RPC key (it ships inside the APK: never the bots' key)
- `EXPO_PUBLIC_MONAD_WS_URL` — optional; heads over WebSocket, else a 400 ms poll
- `APP_ENV` — `development` (default; testnet, may fall back to viem's public RPC with a badge) · `staging` · `production`
- `EXPO_PUBLIC_SHORT_LOCK=1` — dev builds only: idle lock after 60 s, background lock after 30 s (device QA)
- `EXPO_PUBLIC_FAKE_PASSKEY=1` — dev builds with `APP_ENV=development` only: a fake WebAuthn client for emulators without
  a passkey provider. Compiled out of release bundles; `pnpm --filter @meridian/mobile check:release` exports a
  production bundle with the flag on and fails if the fake is in it.

Builds: `eas.json` profiles `development` (dev client APK) · `preview` (staging APK) · `production` (mainnet APK).
Dev-only screens (`/dev/smoke`, the hold-to-confirm test in the Trade sheet) are compiled out of release bundles.

Layout: `src/app` routes (expo-router) · `src/ui` design system · `src/live` block / Meridian / Perpl / network stores ·
`src/features` screen pieces · `src/config` environment · `src/auth` Mera passkey wallet (N3) · `src/wallet` send + balances.

## Wallet (N3)
Mera 0.2.0 + react-native-passkey 3.6.1 (Mera's exact peer). A passkey on the rpId (`meridian-testnet.vercel.app` in
development/staging, `meridianfi.vercel.app` in production; anything else is refused) gives a 32-byte PRF output →
core `deriveEvmKey(prf, 0)` (Mera's BIP-39/44 path) → `createSecp256k1SigningSession` → `toViemAccount`. The PRF and the
key copy are zeroed right after; the session (in memory only) signs until it locks: 10 min without a touch, > 5 min in
the background, "Lock now", or sign-out. SecureStore holds only `{ credentialId, transports?, createdAt, addressHint }`.
Recovery export and value-moving actions use a fresh passkey prompt and a per-action session (`withFreshPrf` /
`withFreshSession`). Writes go through `src/wallet/sendTx.ts`: gas = estimate × 1.2 rounded up, pending nonce, EIP-1559
fees, explicit chain id, receipt, reverts decoded to plain English. Android needs
`https://<rpId>/.well-known/assetlinks.json` listing the package and the signing SHA-256 (served by `app/public`).

## First run and Home (N4b)
Welcome (live spread) → **Continue with passkey** → passkey hero (`(onboarding)/create`, FIDO copy) → **Create my wallet**
→ OS sheet → "Wallet ready ✓" (600 ms, success haptic) → Home. "Use an existing passkey" signs in from Welcome directly.
A cancelled OS sheet shows a calm muted line, never red. Identity everywhere is identicon + "Wallet ••a3f2"
(`src/wallet/identity.ts`); the full address is only on Add funds (`/fund`, a modal: QR, copy, share).
Tabs: Home (`(tabs)/portfolio`, first, default after unlock) · Trade · Earn · Settings.
`WalletFeedProvider` (root, under the auth gate) runs the one BalanceReader for the unlocked wallet; each state goes
through `detectArrival` (pure) → "+12.50 AUSD arrived" toast + success haptic anywhere in the app, and Home's total
counts up. Home total = `totalAusdWad({ walletWad, venues })` in `src/features/home/total.ts`: `venues` is empty until
N7 adds Meridian + Perpl equity. Testnet "Get test funds": Monad faucet for MON, then 10,000 test AUSD minted from
Meridian's AUSD mock (`src/wallet/testFunds.ts`; never on 143).
