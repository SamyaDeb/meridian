# @meridian/core

All of Meridian's money logic as pure, tested TypeScript that runs on React Native's Hermes: the native app (`mobile/`, MOBILE_PLAN N2–N7) imports it first; the web app and bots can move onto it later. No UI, no network in tests, no accounts.

```
pnpm --filter @meridian/core test        # vitest, recorded fixtures only
pnpm --filter @meridian/core typecheck   # src without Node/DOM types, then tests
pnpm --filter @meridian/core record:books  # re-record the testnet books (read-only; see scripts/)
```

## Module map

Import by subpath (`@meridian/core/perpl`, …) or as namespaces from `@meridian/core`.

| Subpath | What | Ported from |
|---|---|---|
| `perpl` | `auth` (canonical strings, Ed25519 signing, RFC 8032 + K3 vectors), `rest` (signed REST, 429/503 back-off + jitter, Retry-After), `trading` (`PerplTrading`: trading WS sign-in mt 29, place / cancel / outcome / fills, REST fallback, token bucket, `ioc()`), `marketData` (market-data WS, funding feed, **L2 book** for `order-book@<id>`), `client` (public REST: context, ticker, funding, book), `state`, `types`, `validate`, `units`, `errors` (all 70 `sr` codes + `fr`, HTTP and close codes → plain English), `enroll` (API-key enrolment flow), `onboarding` (state detector + tx builders), `abi` | K3 `mm-bot/src/perpl/*` + `scripts/perpl-enroll.ts` (perpl-hedge @ fe873b0), K3 `mfi/src/perpl/ws.ts` (@ 116e26d), `mfi/src/perpl/*` (main @ 0ba1664) |
| `keys` | `deriveEvmKey(prf, i)` (Mera: `entropyToMnemonic(prf)` → seed → `m/44'/60'/0'/0/i`), `derivePerplKey(prf, chainId, rotation = 0)` (HKDF-SHA256, salt `meridian/perpl-api-key/v1`, info `String(chainId)`), `recoveryPhrase(prf)` | new (Mera docs, mera-passkeys §1, §4) |
| `route` | `walkBook`, `meridianLevels` / `perplLevels`, `route` (router v1), `funding` (Meridian per block at the measured cadence, Perpl per interval), `planBasis`, `lockQuote`, `meridianLiq`, `liqPerpl` (Perpl's own margin rule), `crossVenue` (realized windows, countdown, net carry) | K5 `risk/src/{perpl,funding}.ts` (rates-risk @ 1edb15f); rest new |
| `exec` | `single` (QUOTE → SEND → CONFIRM → DONE \| FAILED), `basis` (two-leg open, MOBILE_PLAN N6 diagram), `close` (reverse order), `leg` (resume-safe prepare → send → confirm), `persist` (versioned bigint-safe JSON), `driver` (`runSingle` / `runBasis` / `runClose` with injected adapters) | new |
| `meridian` | typed ABI fragments + full ABIs (`@meridian/abis`), deployment readers (`deployments/{143,10143,31337,perpl}.json`; refuse `deployed: false` and a missing file), `orders` (tick snapping), `book`, `depth`, `blocks`, `format`, `permit` (AUSD "Agora Dollar" v"1"), `gas` (estimate × 1.2, ceil), `math` (MATH_SPEC), `liqDistance` | `app/src/lib/*` (main @ 0ba1664) with their tests |
| `util` | `fixed` (WAD, `divFloor` / `divCeil` / `divTrunc`), `bytes` (hex, base64url), `json` (bigint-safe), `runtime` (injected `FetchLike`, `WsLike`, `Clock`, `RandomBytes`) | K5 `risk/src/fixed.ts` |

Not a config system: `packages/config` (LAUNCH_PLAN §3.1, P1) owns loading per environment and the URLs that differ per env (Perpl WS base, indexer, MFI). Core only reads the parsed deployment JSON it is handed.

## Hermes-safe rules

- No Node built-ins (`node:*`, `crypto`, `fs`, …), no `Buffer`, no `require(`, no `process.env` reads, no `crypto.subtle`, no DOM, no storage, no `console`. `test/hermes-safe.test.ts` greps `src/` for all of these and allow-lists the packages `src/` may import (`viem`, `@noble/hashes`, `@noble/ed25519`, `@scure/bip32`, `@scure/bip39`, `@meridian/abis` JSON). `tsconfig.json` gives `src/` no Node or DOM types, so a stray global fails `typecheck` too.
- Ed25519 uses noble's **sync** API with `@noble/hashes` SHA-512 (`perpl/ed.ts`), never WebCrypto.
- Randomness, fetch, WebSocket and timers are injected (`util/runtime.ts`). On the phone: `crypto.getRandomValues` from the `expo-crypto` polyfill (first import), RN's global `fetch` / `WebSocket`.
- Key material: the derivation functions return `Uint8Array`, have no side effects, and log nothing; `redact()` strips `X-API-*`, `api_key`, `signature`, secrets, mnemonics and PRF from anything logged. Core persists only exec state (rq numbers / tx hashes, never keys).
- bigint for every onchain unit; floats only in display helpers that say so (`wadToFloatForDisplay`, `depth.ts` coordinates).

## Rounding (against the user, CONTRIBUTING §2)

| Where | Direction |
|---|---|
| `walkBook` average price and notional | buyer ↑, seller ↓ |
| router effective price (avg ± taker fee) | buy ↑, sell ↓; fee owed ↑ |
| size asked → venue step / lot; basis size → both venues' steps (lcm) | ↓ |
| funding per day (both venues) | ↑ (owed more, received less) |
| basis fee drag | ↑; net per day ↓ |
| lock fixed APR | sell (received) ↓, buy (paid) ↑ |
| unwind / retry limit from a reference | buy ↑, sell ↓ |
| Perpl liquidation price | toward the mark (long ↑, short ↓), as dex-sdk |
| Meridian liquidation preview | long ↑, short ↓ (warn early), MATH_SPEC §3.2 |
| WAD → collateral units | ↓ unless owed by the user (↑) |
| APR conversions (reference values) | toward zero |

## Exec machines: resume after an app kill

Every leg goes **prepare** (fix the order's identity without sending: the Perpl `rq`, or the signed Meridian tx's hash) → **send** (idempotent: re-sending the same `rq` is Perpl's at-most-once retry; re-broadcasting the same signed tx is a no-op by nonce) → **confirm** (definitive outcome, or throw and retry; never assumed). The app persists `serializeExec(state)` after every event; on launch `deserializeExec` + `nextBasisAction` gives the same next action as before the kill (tested from every snapshot).

Basis open (N6): `COLLATERAL → LEG1_PERPL_IOC → LEG2_MERIDIAN(q1 on the Meridian lot) → [LEG3_SWAP] → DONE`; q1 = 0 ⇒ `ABORTED`; q2 < q1 ⇒ `UNWIND_PERPL(q1 − q2)` ⇒ `PARTIAL_DONE`; Meridian fails (or q2 = 0, or q1 below one lot) ⇒ `UNWIND_PERPL(q1)` ⇒ `ABORTED_UNWOUND`; unwind short / failed ⇒ `UNWIND_RETRY` at 2× slippage ⇒ `MANUAL`; lock failure ⇒ `DONE_LOCK_FAILED` (hedge stays). Close: Meridian reduce-only first, then Perpl reduce-only for exactly what closed, retry 2×, else `MANUAL`.

## Fixtures (no network in tests)

`fixtures/README.md` lists each file's source and recording date. Real recordings: Perpl testnet trading session + REST history (K3, 8 Oct), market-data WS frames incl. `order-book@64` (K3, 7 Oct), REST context/ticker/funding testnet + mainnet (mfi, 5 Oct), exchange views for three accounts and both MON markets (K5, 8 Oct), and both testnet books (this package, 8 Oct). Synthetic: `fixtures/perpl/synthetic` (marked, from mfi).

## Open

Every `> VERIFY` in this package:

- **Answered (N4, 9 Oct 2026): Perpl minimum account-open amount, raw unit.** `getMinAccountOpenCNS()` is in collateral token units (AUSD 6 dp) and **differs per chain**: mainnet 143 exchange `0x34b6…2a6f` → `10000000` = **10 AUSD** (eth_call at block 111,691,545); testnet 10143 exchange `0x1964…80cc` → `100000000` = **100 test AUSD** (block 69,336,398). perpl-docs `docs/exchange/minimum-orders.md` (@ fbbe822) agrees ("$10 on mainnet ($100 on testnet)"); the api-docs' "100000000 = 10.0 AUSD" was the testnet raw value with the mainnet label. The app re-reads it right before every `createAccount` and refuses a smaller deposit (mobile `venues/perpl/amounts.ts`).
- **Answered (N4, 9 Oct 2026): enrolment `Origin`.** Native requests must send **no** `Origin`: `POST /v1/api-key/payload` with no Origin → **200** on both testnet and mainnet; with `Origin: https://meridian-testnet.vercel.app` / `https://meridianfi.vercel.app` (not whitelisted) → **400 Bad Request** (throwaway address + random key, nothing enrolled). RN `fetch` adds no Origin; `enrollApiKey` sends one only when given, and the app never gives one. A full enrol from the phone is the end-to-end proof (MOBILE_QA N4).
- **Answered (N4, 9 Oct 2026): API-key token persistence.** The app stores `{ token, rotation, publicKeyHex, chainId, address, enrolledAt }` per (chain, wallet) in SecureStore, validated field by field (mobile `venues/perpl/tokenStore.ts`); the Ed25519 secret is derived in the unlock PRF pass at the stored rotation and never stored. Lost token or 409 ⇒ one fresh passkey prompt, then `derivePerplKey(prf, chainId, r)` for r = rotation + 1 … until Perpl accepts (bounded; 423 = 16 active keys ⇒ revoke at Perpl → API keys). Listing/revoking keys is web-UI only (integrations.md "Listing and revoking keys is done from the web UI"), so the rotation can't be read back from Perpl. Also measured: **enrol answers 404 "target profile not found" for a wallet Perpl has never seen** (throwaway testnet address, no exchange account), so the app offers the deposit (`createAccount`) first and retries enrolment after it; whether `createAccount` creates the profile is checked on the phone (MOBILE_QA N4).
- **Answered (N4, 9 Oct 2026): Perpl funding sign.** Positive `rate` ⇒ **longs pay shorts**: perpl-docs `docs/exchange/funding.md:5` (@ fbbe822) "positive (payment flows from long positions to short positions)", and `price-indices.md:85` "When the perpetual trades above spot, longs pay shorts". Consistent with the recorded testnet series (`fixtures/perpl/testnet/funding-64.json`: rate 10 ⇒ `sum` +34 per lot, a long's funding PnL is −(xfs − efs)).
- > VERIFY: Hermes runtime cost and globals on the phone (N2 smoke): `deriveEvmKey` runs PBKDF2-SHA512 × 2048 synchronously (Mera's documented path); noble's `utf8ToBytes` needs `TextEncoder`; `crypto.getRandomValues` comes from `expo-crypto`.

Decisions taken here (not VERIFYs): Perpl trading budget 50/min testnet (K3) and 100/min mainnet (same margin under 60 / 120); READY = forwarding on **and** free collateral > 0 (FORWARDING_ON = forwarding on, nothing free yet); the unwind limit references the leg-1 average (an N6 adapter may pass a fresher mark); close order = Meridian first.
