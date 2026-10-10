You are the senior blockchain + TypeScript engineer for Meridian (public name; internal codename Pulse). This session
executes MOBILE_PLAN phase **N1 — `packages/core`** (`@meridian/core`): all money logic for the native Android app
(and later the web app and bots) as pure, tested, Hermes-safe TypeScript. No UI, no network in tests, no accounts needed.

## 1. Read first (fully, in this order)
1. /Users/samya/Downloads/meridian-m/CONTRIBUTING.md (public-repo rules: never invent, rounding, tests, commits)
2. /Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md — §0 (all), §2 Architecture, phase **N1**, and N6 (executor
   diagram: you build its pure state machine now), §5 log (decisions of 8 Oct)
3. /Users/samya/Downloads/Meridian/docs/LAUNCH_PLAN.md §3.1 (`packages/config` is a SEPARATE P1 package; core must not
   duplicate it — expose deployment *readers* that take a parsed JSON object, not a second config system)
4. Skills: load `perpl-api` (Perpl auth/enrolment/WS protocol/limits), `mera-passkeys` §1 + §4 (EVM + extra-key
   derivation), `expo-native-app` §2 (Hermes constraints).

## 2. Context (verified 8 Oct — don't re-derive)
- Working clone: `/Users/samya/Downloads/meridian-m` (origin `github.com/SamyaDeb/meridian`, `main` = 0ba1664, SSH
  signing as SamyaDeb already configured, `pnpm i` done). Node **24** (`nvm use 24`), pnpm 10.18.3, repo `.npmrc`
  `node-linker=isolated` — never change it or switch to a hoisted linker; never print ~/.npmrc.
- Workspace (`pnpm-workspace.yaml`) lists abis, keepers/*, mm-bot, indexer, app, bench, mfi → add `packages/*`.
  Other packages use vitest `^5.0.2` + typescript `^7.0.2` (mfi, mm-bot, bench); match those.
- Decisions: Android-first native (no Apple program → no iOS app); prod passkey rpId `meridianfi.vercel.app`, staging
  rpId `meridian-testnet.vercel.app`; Android package `xyz.meridianfi.app` (+ `.staging`). Core is chain/env agnostic:
  it never hard-codes an rpId, URL, address, market id or decimals.
- **Perpl code is NOT on main.** Sources to port (read them, port with their tests, keep behaviour and test vectors):
  | What | Where |
  |---|---|
  | Perpl auth (Ed25519 canonical strings, RFC 8032 vector), config, ratelimit, state, trading WS, types | `/Users/samya/Downloads/meridian-k3/mm-bot/src/perpl/{auth,config,ratelimit,state,trading,types}.ts` (branch `perpl-hedge`, PR meridian#5, open) |
  | Enrolment flow | `/Users/samya/Downloads/meridian-k3/mm-bot/scripts/perpl-enroll.ts` |
  | Perpl read client, units, errors, validation, transport | `meridian-m/mfi/src/perpl/{client,errors,transport,types,units,validate}.ts` (on main) |
  | Funding index math | `meridian-m/mfi/src/mfi/{compute,service}.ts` |
  | Perpl liquidation rule (K5, from dex-sdk) + cross-venue funding | `/Users/samya/Downloads/meridian-k5/app/src/features/rates/{perplView,crossVenue,meridianRisk}.ts` + tests + `fixtures/*.json` (branch `rates-risk`, PR meridian#3, open) |
  | Meridian math to copy (with tests) | `meridian-m/app/src/lib/{math,liqDistance,orders,book,depth,blocks,units,format,permit,gas}.ts` |
  | Addresses / markets / ABIs | `meridian-m/deployments/{143,10143,31337,perpl}.json`, `meridian-m/abis/*.json` (note: `143.json` may be absent until mainnet day — readers must handle "not deployed") |
  When a file you need differs between branches, port from the branch named above and note the source commit in
  the file header comment. Do not merge or cherry-pick those branches into yours.

## 3. Hard rules
- Never invent addresses, chain/market IDs, decimals, URLs, package exports or API fields. Use deployments/*.json,
  the `perpl-api` skill, the ported code, or write `> VERIFY: <what, where>` and continue against a typed mock.
- **Hermes-safe:** no Node built-ins (`node:*`, `Buffer`, `crypto`, `fs`, `process.env` reads inside the library),
  no DOM. Use `@noble/hashes` (sha256, hkdf), `@noble/ed25519`, `viem`, Uint8Array + own base64url helpers.
  Add a test that greps `packages/core/src` for forbidden imports (`node:`, `Buffer`, `require(`) and fails.
- Transports are injected (fetch-like, WebSocket-like interfaces), so RN `WebSocket`/`fetch` and test fakes plug in.
- **Round against the user** (CONTRIBUTING): owed by the user → up; paid to the user → down; average fill price
  for a buyer → up, seller → down; sizes → down to lot. Every formula comment: `// <source>, rounds <up|down>`.
  bigint for all on-chain units; no floats in money paths (floats only for display APR helpers, clearly named).
- Never log or persist key material; key-derivation functions return Uint8Array and have no side effects.
- viem only (no ethers). Strict TS (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- Tests first per module. No network in tests: recorded fixtures only (reuse K5/K3/mfi fixtures; record new ones
  from public endpoints only with a script under `packages/core/scripts/record-*.ts`, outputs committed).

## 4. Deliverables (`packages/core/`, ESM, `"type": "module"`, exports map per subpath)
1. **Scaffold:** `package.json` (`@meridian/core`, private, scripts `test`, `typecheck`, `lint` if repo has one),
   `tsconfig.json` extending `tsconfig.base.json`, `vitest.config.ts`, add `packages/*` to the workspace, README
   (module map + "Hermes-safe rules").
2. **`perpl/`** — port: `auth` (same canonical strings + the RFC 8032 vector + K3 vectors), REST signer with 429
   backoff + ratelimit, trading-WS protocol (frames, sign-in mt 29, place/cancel/outcome/fills; transport injected;
   IOC helper), market-data protocol, `units` driven by `deployments/perpl.json`, `errors` (`st/sr` table → plain
   English), **onboarding state machine** `NO_KEY → KEY_ENROLLED → ACCOUNT_CREATED → FORWARDING_ON → READY`
   detected from API/chain reads; tx builders return viem `{ to, data, value }` (the app sends them). Perpl min
   account open stays `> VERIFY raw unit (N4 mainnet canary)`.
3. **`keys/`** — `deriveEvmKey(prf, index)` exactly per Mera docs (`entropyToMnemonic(prf)` → seed → `m/44'/60'/0'/0/i`),
   `derivePerplKey(prf, chainId)` = HKDF-SHA256(ikm=prf, salt="meridian/perpl-api-key/v1", info=String(chainId), L=32)
   → Ed25519 secret + public key. Fixed test vectors (a fixed 32-byte PRF → fixed address / pubkey; assert the EVM
   key bytes ≠ Perpl key bytes; different chainId → different Perpl key). Only `@scure/bip32`, `@scure/bip39`, noble.
4. **`route/`** — `walkBook` (avg price rounds against the user, levels consumed, residual), `router` v1 (whole order
   to the cheaper effective price incl. taker fee; tie → Meridian; residual → venue ineligible), `funding` (per-day
   for both venues: Meridian per-block via measured block time — block.number, never timestamps; Perpl per
   funding interval from config, mainnet 2,580 s per MOBILE_PLAN §0.5), `basis` (short the higher-funding venue,
   long the lower, equal MON size rounded down to BOTH venues' lot sizes, net spread after fees amortised 30 d,
   `edge` flag), `lock` (fixed-rate quote from Meridian funding-swap book views; pure, inputs = book levels),
   `liq` (Meridian: port `liqDistance.ts`; Perpl: K5 rule).
5. **`exec/`** — pure state machines with injected adapters: single-leg (`QUOTE → SEND → CONFIRM → DONE|FAILED`) and
   two-leg basis exactly per MOBILE_PLAN N6 diagram (`LEG1_PERPL_IOC` → q1=0 ABORT / `LEG2_MERIDIAN(size=q1)` →
   q2=q1 DONE (+ optional `LEG3_SWAP`) / q2<q1 `UNWIND_PERPL(q1−q2)` PARTIAL_DONE / fail `UNWIND_PERPL(q1)`
   ABORTED_UNWOUND; unwind fail → retry with 2× wider limit → MANUAL). Lock failure never unwinds the hedge.
   Persisted-state (de)serialisers (versioned JSON, bigint-safe) so an app kill resumes or unwinds.
6. **`meridian/`** — typed ABIs re-exported from `@meridian/abis` (or `abis/*.json`), deployment readers for
   143 / 10143 / 31337 that take the parsed JSON and refuse `deployed: false`, order helpers (tick snapping from
   `app/src/lib/orders.ts`), permit typed-data builder (from `permit.ts`; AUSD domain "Agora Dollar" v"1" per §0.5),
   gas helper `estimate × 1.2` (ceil).

## 5. Tests (all in vitest, no network)
- Every module; rounding direction asserted (buyer avg ≥ exact, seller avg ≤ exact; sizes floor to lot).
- Property tests (fast-check if already in the repo, else a seeded generator): basis → net MON exposure is 0 or
  the result is flagged; router never picks a venue whose effective price is worse; walkBook never over-fills.
- Recorded-fixture quote from real testnet books (reuse K5 `fixtures/market-10143.json` etc.).
- Exec machines: every transition incl. q1=0, partial, Meridian failure → unwind, unwind failure → retry → manual,
  serialise/deserialise mid-state → resume to the same next action.
- Forbidden-imports test (Hermes).

## 6. Done = acceptance
- `pnpm --filter @meridian/core typecheck` and `pnpm --filter @meridian/core test` green; `pnpm -r typecheck` still
  green for the rest of the repo; CI (`.github/workflows/ci.yml` ts job) would pass.
- Nothing imported from Node; bundle check: `pnpm --filter @meridian/core exec tsc --noEmit` + forbidden-imports test.
  (The real Hermes smoke happens in N2 when the app imports core on the phone.)
- Every `> VERIFY` listed in `packages/core/README.md` §Open.

## 7. Git / PR
- Branch `n1-core` from `main` in /Users/samya/Downloads/meridian-m. Conventional commits (`feat(core): …`,
  `test(core): …`), small and logical. **SSH-signed, author SamyaDeb only, NO Claude / Co-Authored-By trailers.**
- Never commit `.env*`, keys, keystores. Don't push or open a PR without asking me; when I say so:
  `GH_TOKEN=$(gh auth token -u SamyaDeb) gh pr create -R SamyaDeb/meridian --title "[N1] packages/core: …"`
  (the active gh account may be saxux2 — always use that token).

## 8. Finish
Report: modules + test counts, rounding decisions, every `> VERIFY`, what you ported from which branch/commit,
anything that blocks N2/N3/N4. Update MOBILE_PLAN §3 (N1 status) and append a §5 log line in
/Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md. Tick only what you verified.
