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
- `EXPO_PUBLIC_INDEXER_URL` — optional; the Envio GraphQL URL of this env's indexer (LAUNCH_PLAN §4.3). Without it,
  Activity lists this app's own trades + Perpl history and says Meridian history needs the indexer
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
counts up. Home total = `totalAusdWad({ walletWad, venues })` in `src/features/home/total.ts` (venues: N7, below). Testnet "Get test funds": Monad faucet for MON, then 10,000 test AUSD minted from
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
- **Pro (completed after N5):** chart **Line / Candles** toggle (candles = open/high/low/close per bucket from the same
  Perpl candles, the live candle widening per block; up/down coloured, carried gaps dim; scrub label shows O H L C) and
  **Books / Trades** tabs, both choices remembered (`prefs.ts`). Trades = both venues newest first: Perpl from the
  market-data socket `trades@<id>` (api-docs websocket.md "Trade Messages", core `parseTrades` + `MarketDataFeed.trades`),
  Meridian from the OrderBook `Trade` events (`data/trades.ts`: eth_getLogs only while the tab is visible, 100-block
  backfill, then incremental, ≤ 100 blocks per request — > VERIFY the RPC's getLogs range limit).
- Providers: `TradeProvider` (root, under the auth gate) sits ABOVE `BottomSheetModalProvider`, as do Toast and the
  wallet feed: sheet content renders through a portal and only sees contexts above the provider.

## Earn (N6)
`(tabs)/earn` → `features/earn/`: "Earn X % APR on AUSD" = the funding gap between the venues, net of both taker fees
(round trip over 30 d) and the book slippage at your size (core `planBasis`), live per block; 24 h gap sparkline
(`history.ts`: Perpl funding events over REST + Meridian `previewFundingState` read at the block ~each hour ago — falls
back to "since you opened Earn" when the RPC can't serve old blocks, > VERIFY archive depth); numpad (25 % / 50 % / MAX
of 2 × the binding venue) → "≈ $Y / day"; legs in plain words; "No edge right now" + Perpl's next funding time; a
3-step explainer. **Lock** toggle (below).
- **Sizing (`plan.ts`):** the amount is split evenly, 2× per leg, so notional per leg = the AUSD committed (APR on AUSD =
  the pair's net APR); room is left for the taker fee; size = notional / the highest price the buy leg could pay,
  floored to lcm(Meridian lot, Perpl step). Limits = each book walked at that size ± 1 %, snapped buy ↑ / sell ↓.
  Collateral need per venue = margin + fee (rounds up); deposits in whole AUSD units.
- **Executor (`executor.ts`):** core `runBasis` — collateral (both venues re-read; ONE fresh passkey prompt for any
  top-ups: Meridian permit/approve + deposit, Perpl approve exactly + `depositCollateral`) → Perpl IOC → Meridian for
  exactly the filled size (floored to its lot) → DONE; short hedge ⇒ reduce-only unwind of the difference
  (PARTIAL_DONE); Meridian fail ⇒ unwind all (ABORTED_UNWOUND); unwind short ⇒ retry at 2× slippage ⇒ MANUAL (alert
  + one-tap close of the exact leftover via the Trade executor). Close = core `runClose`: Meridian reduce-only first,
  then Perpl reduce-only for exactly what closed. The N5 venue legs are reused, one instance per leg key.
- **Persistence + resume:** run record `meridian.earn.run.<chain>.<wallet>` (core exec state + per-leg notes: rq floor,
  signed raw tx + nonce, ref, order id, fill, error) written after every event; the hedged pair + any one-sided leftover
  in `meridian.earn.position.<chain>.<wallet>` (folded in idempotently by run id). Resume on unlock: a FIRST leg not
  sent before the kill is cancelled (nothing placed); any later leg runs to its end (Meridian re-broadcasts the stored
  signed tx; Perpl finds the order after the stored rq floor). No key material is stored.
- **Receipt (`app/earn-receipt.tsx`):** outcome in plain words + a timeline per leg (sent → filled / partly filled /
  didn't fill / undone, Perpl order id, explorer tx link). Success haptic only on DONE / CLOSED.
- **Dev flag (`devFail.tsx`, `__DEV__` only):** "force the Meridian leg to fail" → the Perpl leg is auto-unwound on the
  phone. Required only behind `__DEV__`; `check:release` fails if its marker reaches a release bundle.
- **Lock (`plan.ts` quoteLock, `data/swap.ts`, core `meridian/swapMargin.ts`):** fixes the MERIDIAN leg's floating
  funding on Meridian's funding-swap book (a second OrderBook, price = 1 + fixed APR; MATH_SPEC §6): a Meridian short
  sells the swap (receives fixed), a long buys it. Size = the hedge floored to the swap lot (1,000 MON on the spec), the
  rest stays floating; Perpl's side always floats. The quote shows the fixed APR after the swap taker fee and
  "until <maturity>"; the swap-market collateral = core `swapLockNeedWad` (a 1:1 port of `SwapMarginLib` +
  `FundingSwapMarket._fee/_check`: IM + fee − V at the worst APR, minus the account's settled collateral, ↑ to whole
  AUSD), deposited in the SAME fingerprint prompt as the venue top-ups. The swap is core LEG3_SWAP after the hedge: if it
  fails, the hedge stays open at the floating rate (DONE_LOCK_FAILED, nothing unwound). Closing with a lock buys/sells
  the swap back FIRST (reduce-only, ±20 bps of price); if it doesn't close in full, nothing else is sent, so a swap is
  never left without its hedge. Unavailable states are said plainly (below one lot, matured, no quotes, loading).

## Home, Activity, Settings (N7)
- **Total** (`features/home/total.ts`): wallet AUSD (the one `useWalletFeed` reader) + each deployed venue's own account
  value, bigint WAD, from the same per-block `AccountsReader` the Trade screen uses (no second balance reader).
  Meridian = AccountView `equity` (= collateral + uPnL − pending funding, `ClearingHouse.getAccount`: collateral is
  already inside it). Perpl = account `balanceCNS` (excludes open positions: dex-sdk `state/account.rs`) + the MON
  position's deposit + delta PnL + premium PnL; the account view's position bitmap (dex-sdk
  `perpetuals_with_position`, checked on the recorded K3 account) marks a position on another Perpl market ⇒ that part
  is unknown. Any unknown part ⇒ the hero shows "—" and the breakdown sheet ("See breakdown") says which part and why.
  A venue not deployed on the network is not part of the total (the sheet says so). Values floor at 0.
- **Open PnL** next to the total (not "today's": no honest per-day baseline without the indexer): Meridian uPnL −
  pending funding + Perpl delta + premium PnL, per block; "—" while any part is unknown.
- **Account reads** run while any holder is on: `useAccountReadsWhileFocused()` (Home, Trade) and the liquidation
  alert while the app is in the foreground. `focus` is a counter, so tab focus/blur order can't switch reads off.
- **Positions on Home** = the N5 `PositionCards` (swipe + visible Close → summary → hold/tap → receipt), plus a
  funding line (Meridian −pendingFunding, Perpl premium PnL; + = received) and a "Basis trade" header when one
  Meridian and one Perpl position are equal and opposite (fallback until N6 stores a `basisId`).
- **Activity** (`features/activity/`, Home shows the latest 3, `app/activity.tsx` all, pull-to-refresh on both):
  (1) this app's receipts, persisted per (chain, wallet) in SecureStore (`meridian.activity.<chain>.<wallet>`, newest
  25, non-secret); (2) Perpl `GET /v1/trading/fills` grouped per order + `GET /v1/trading/account-history` (deposit,
  withdrawal, liquidation, funding), signed REST, one page of 50 each; (3) Meridian `Trade` / `FundingPayment` /
  `Liquidation` from the Envio indexer, only when `EXPO_PUBLIC_INDEXER_URL` is set (> VERIFY root fields + `_ilike`
  against the live Hasura console, as the web app's `account.ts`). Merged newest first, deduped (the app's own receipt
  wins over Perpl's row for the same order id / Meridian tx hash). Trade rows → the receipt modal; other rows →
  `app/activity-item.tsx`. A source that is off or failed says so under the list. Not listed: wallet transfers and
  Meridian deposits (no indexed per-event source; the arrival toast covers incoming AUSD live).
- **Settings**: passkey card, wallet identicon + copy, recovery export, Perpl card, sign out (N3/N4/N4b), plus
  **Alerts** (`features/alerts/`): "Close to liquidation" (< 5 %, re-arms above 6 %) and "Funding flips", off by
  default, saved on the device, shown in-app (error toast + haptic / info toast) — no OS notification permission is
  asked because this build has no push; and **Open full terminal** (staging/dev: `meridian-testnet.vercel.app`; hidden
  on production until the prod web URL is set, > VERIFY in `config/appConfig.ts`).
- **Close all** (`app/close-all.tsx`, "Close all" on the positions card when 2+ are open): a hedged basis pair closes
  through core's two-leg close machine (`features/trade/exec/closeAll.ts` → core `exec/close` + `runClose`): Meridian
  reduce-only first (final onchain), then Perpl reduce-only IOC for exactly what Meridian closed (floored to Perpl's
  lot), one retry at 2× slippage, else MANUAL with the unhedged size named. Persisted per (chain, wallet) in SecureStore
  (`meridian.trade.closeall.<chain>.<wallet>`) after every event and resumed on launch (signed Meridian tx re-broadcast;
  Perpl order adopted by rq floor, which is cleared on every phase change). Unrelated positions close one by one
  (Meridian first, stop at the first that doesn't fill). One order at a time across the Trade executor and Close all.
- **Cut (MOBILE_PLAN cut order, no new native dependency ⇒ the EAS dev build `4e91111a` still works):** push
  (`expo-notifications` + the `/api/push/*` backend, which doesn't exist yet), share card (`react-native-view-shot` +
  `expo-sharing`), Flip / Add margin.
