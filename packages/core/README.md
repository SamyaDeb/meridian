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

- > VERIFY: Perpl minimum account-open amount, raw unit. `onboarding.minAccountOpenRead` reads `getMinAccountOpenCNS()` (CNS = AUSD 6 dp); the API docs show `min_account_open_amount: 100000000` displayed as "10.0 AUSD", which is 100 AUSD at 6 dp. Check on mainnet in the N4 canary before the first `createAccount`.
- > VERIFY: enrolment `Origin`. integrations.md says `/api-key/payload` and `/enroll` require a Perpl-whitelisted `Origin`; K3 enrolled on testnet with none. `enrollApiKey({ origin })` sends one only when given. N4: confirm whether native requests need one and which origin to have whitelisted (the rpId host?), and that RN `fetch` lets the app set it.
- > VERIFY: API-key token persistence. The `X-API-Key` token is not re-derivable and re-enrolling the same public key returns 409 (revoked keys can't be re-enrolled). The derived key is deterministic per (passkey, chain), so the app must store the token (non-secret identifier, SecureStore) and, if it is lost, enrol `derivePerplKey(prf, chainId, rotation + 1)`; which rotation is live isn't readable (no key-listing API). N4: ask Perpl, or store the rotation next to the credential id.
- > VERIFY: Perpl funding sign: positive `rate` ⇒ longs pay (MFI.md §2; K5 relies on the dex-sdk funding payment). Not stated in types.md @ 25ab6e2.
- > VERIFY: Hermes runtime cost and globals on the phone (N2 smoke): `deriveEvmKey` runs PBKDF2-SHA512 × 2048 synchronously (Mera's documented path); noble's `utf8ToBytes` needs `TextEncoder`; `crypto.getRandomValues` comes from `expo-crypto`.

Decisions taken here (not VERIFYs): Perpl trading budget 50/min testnet (K3) and 100/min mainnet (same margin under 60 / 120); READY = forwarding on **and** free collateral > 0 (FORWARDING_ON = forwarding on, nothing free yet); the unwind limit references the leg-1 average (an N6 adapter may pass a fresher mark); close order = Meridian first.
