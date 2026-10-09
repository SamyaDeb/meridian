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

## Trade (N5)
`(tabs)/trade`: header (Perpl mark per block, 24 h change from 1 h candles, both funding APRs, Perpl's next-funding
countdown) → chart → position cards → Pro: both books; sticky **Long / Short** open the ticket sheet. **Lite** (sparkline)
is the default, **Pro** (full chart + books) is remembered on the device (`features/trade/prefs.ts`, SecureStore KV).
- **Chart (G2 = own native chart, no new dependency):** `features/trade/chart/` — Perpl candles via core `getCandles`
  (api-docs rest-endpoints.md, documented resolutions, ≤ 1,024), cached per timeframe (1m 5m 15m 1h 4h 1D), live last
  price appended per block, refetch on foreground; `react-native-svg` line + Reanimated/gesture-handler scrub on the
  UI thread with one selection haptic per point; mark / entry / **liquidation** lines (pinned to the edge when off
  range). `react-native-wagmi-charts` was not used: JS-only but built on `react-native-redash` for Reanimated 2/3,
  untested on Reanimated 4.5 / RN 0.86, and it would mean another lockfile merge (> VERIFY if revisited).
- **Ticket:** `features/trade/ticket/` — numpad (`Numpad.tsx` + text model `amountText.ts`, reusable by N6), presets
  25 % / 50 % / MAX of the chosen venue's free collateral + the wallet token that funds it, leverage detents 1/2/5/10
  (capped per venue: Meridian 1/imr, Perpl init-margin hdths / 100), slippage 0.5/1/3 %, live quote through core
  `router` on both books per block (input debounced 150 ms, `quote.ts`), tap a venue row to force it, plain summary,
  blockers fixed inline (first Perpl trade → the N4 checks; Perpl short → "Move X AUSD"; Meridian short → permit
  deposit inside the order flow; wallet short → Add funds), hold-to-confirm + visible "Or tap here" alternative.
- **Execution:** `features/trade/exec/` — core `exec/single` per order, persisted after every event in SecureStore
  (`meridian.trade.pending.<chain>.<wallet>`): Perpl IOC (`perplLeg.ts`: rq floor saved before sending; outcome from
  the socket, else REST order history; not in history after lb + 10 blocks ⇒ failed), Meridian `placeMarketOrder`
  (`meridianLeg.ts`: signed locally, raw tx persisted before broadcast, gas = estimate × 1.2, fills from the `Trade`
  events). On launch an open trade resumes to filled / failed (`executor.ts`); a trade that never left the phone ends
  "closed before sending". Receipt (`app/receipt.tsx`): venue, avg price, size, fee, Perpl order id / explorer tx link,
  blocks to fill.
- **Positions:** `features/trade/positions/` — Meridian `getAccount`, Perpl `getPositionV2` → core `perplPositionRisk`;
  swipe Close + visible Close → reduce-only for the whole size at the opposite best ± 2 %.
- Providers: `TradeProvider` (root, under the auth gate) sits ABOVE `BottomSheetModalProvider`, as do Toast and the
  wallet feed: sheet content renders through a portal and only sees contexts above the provider.
