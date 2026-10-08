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

Builds: `eas.json` profiles `development` (dev client APK) · `preview` (staging APK) · `production` (mainnet APK).
Dev-only screens (`/dev/smoke`, the hold-to-confirm test in the Trade sheet) are compiled out of release bundles.

Layout: `src/app` routes (expo-router) · `src/ui` design system · `src/live` block / Meridian / Perpl / network stores ·
`src/features` screen pieces · `src/config` environment.
