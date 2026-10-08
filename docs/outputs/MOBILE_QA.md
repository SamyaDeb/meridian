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
