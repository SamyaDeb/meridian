You are the senior blockchain + React Native engineer for Meridian (public name; internal codename Pulse). This session
executes MOBILE_PLAN phase **N4 — Perpl onboarding + mainnet canary**: the Android app makes the user's Mera passkey
wallet tradeable on Perpl (API key enrolled, exchange account funded with AUSD, order forwarding on), keeps one signed
trading connection, and proves it with an IOC round trip from the phone on testnet and a tiny canary on mainnet.
This is the Agora bounty's "executes trades through Perpl" requirement; N5 (Trade) and N6 (Earn) sit on it. Treat it
as wallet + exchange-integration code: every on-chain unit from config, every tx gas-capped, no key at rest.

## 1. Read first (fully, in this order)
1. /Users/samya/Downloads/meridian-m/CONTRIBUTING.md
2. /Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md — §0 (all; §0.5 Perpl rows), §1.1 `(onboarding)/perpl`,
   §2, phase **N4**, glance N5/N6 (what they need from you), §5 log
3. `packages/core/README.md` (esp. **§Open** — four of its VERIFYs are yours), `packages/core/src/perpl/*`
   (`client`, `rest`, `auth`, `enroll`, `onboarding`, `trading`, `marketData`, `units`, `errors`, `abi`),
   `packages/core/src/keys/index.ts` (`derivePerplKey(prf, chainId, rotation)`), `packages/core/src/exec/single.ts`
4. N3 code you build on (worktree `/Users/samya/Downloads/meridian-n3`, branch `n3-mera`): `mobile/src/auth/*`
   (esp. `controller.ts` `open()` / `withFreshPrf()` / `withFreshSession`, `derive.ts`, `credentialStore.ts`),
   `mobile/src/wallet/*` (`sendTx`, balances), `mobile/src/live/*`, `mobile/src/config/appConfig.ts`, `mobile/README.md`
5. Perpl sources: skill `perpl-api` (all), github.com/PerplFoundation/api-docs (`authentication.md`, `integrations.md`;
   core pins @ 25ab6e2 — re-read for anything you change), K3 reference `/Users/samya/Downloads/meridian-k3/mm-bot/scripts/{perpl-enroll,perpl-history}.ts`
6. Skills: `perpl-api`, `expo-native-app`, `mera-passkeys` §4–§5, `phone-test` §5.

## 2. Context (verified 8 Oct ~22:30 IST — don't re-derive)
- **Branch stack (nothing of N2/N3 is on main yet):** `n2-shell` (9 commits, `/Users/samya/Downloads/meridian-m`,
  device QA pending) → `n3-mera` (6 commits, worktree `/Users/samya/Downloads/meridian-n3`, not pushed, device QA
  deferred by the owner). main = eb470e7 (includes PR #9 assetlinks). Create **`n4-perpl` from `n3-mera`** in a new
  worktree `git -C /Users/samya/Downloads/meridian-m worktree add /Users/samya/Downloads/meridian-n4 -b n4-perpl n3-mera`,
  then `pnpm install --frozen-lockfile` there (check `df -h /` ≥ 5 GB first). Don't commit on n2-shell/n3-mera, don't
  kill Metro processes of other sessions (ports 8081–8083 may be taken: use 8084). After N2 and N3 merge:
  `git rebase --onto origin/main n3-mera n4-perpl`.
- Verified on `n3-mera`: frozen install OK (lockfile changes only the `mobile` importer); `pnpm -r typecheck` +
  `pnpm -r test` green on Node 24 (core 241, mobile 97); mobile green on Node 22. Mera 0.2.0, react-native-passkey 3.6.1
  (Mera's exact peer), expo-secure-store / clipboard / screen-capture 57.x, react-native-qrcode-svg 6.3.26.
- **Passkeys on staging work end to end on paper:** `https://meridian-testnet.vercel.app/.well-known/assetlinks.json`
  → 200 `application/json`, no redirect, Google statements API lists `xyz.meridianfi.app.staging` with SHA-256
  `23:2F:3C:…:16:B2`, which equals the EAS dev APK's signer (checked with apksigner). Latest dev build with the passkey
  module: EAS `4e91111a-2935-4791-becc-f9ed9cac11aa` (commit 4afa094). **No phone run has happened yet for N2 or N3** —
  your device steps are also the first real passkey test; budget for fixing N3 issues found there (on `n4-perpl`,
  called out in the PR, or ask me to have them fixed on n3-mera).
- **Production passkey domain is NOT ready:** `https://meridianfi.vercel.app/.well-known/assetlinks.json` → 404
  (separate placeholder Vercel project `meridianfi`); production package `xyz.meridianfi.app` has no EAS keystore
  fingerprint recorded. The mainnet canary needs both (or a fallback, §4.7).
- Perpl config only from `deployments/perpl.json` via core `readPerplDeployment` (mainnet exchange `0x34b6…2a6f`, AUSD
  6 dp, MON market 10; testnet exchange `0x1964…80cc`, collateral `0xa901…22dc` 6 dp, MON market 64). REST/WS bases
  per the `perpl-api` skill §1. No CORS in native → call Perpl directly.
- Perpl limits: trading WS 120/min mainnet / 60 testnet (core budgets 100/50), **max 4 connections per wallet** →
  one trading socket per app, closed on background; market-data WS 16 subs (N2 already runs one).
- K3 reference account on testnet: acct 969 (the MM's, not ours). Testnet collateral for a fresh user:
  > VERIFY how to get testnet Perpl collateral (`0xa901…22dc`) — faucet/mint in api-docs or testnet.perpl.xyz UI; ask
  me if it needs a human step. New addresses also need testnet MON for 3 txs (approve, createAccount, forwarding).
- Core §Open items you must close (write the answer into core README §Open, with evidence):
  1. **Min account-open raw unit**: `getMinAccountOpenCNS()` on chain vs docs' `100000000` shown as "10.0 AUSD"
     (= 100 AUSD at 6 dp?). Read it on both chains (eth_call, no tx) before any `createAccount`; size deposits from it.
  2. **Enrolment `Origin`**: does `/v1/api-key/payload` / `/enroll` require a whitelisted Origin? K3 enrolled without
     one on testnet. Try without; if refused, report the exact response and ask me (Perpl must whitelist).
  3. **API-key token persistence**: the `X-API-Key` token is not re-derivable; re-enrolling the same public key →
     409. Store `{ token, rotation, publicKeyHex, chainId, address, enrolledAt }` in SecureStore (token is a bearer id,
     useless without the Ed25519 secret, but keep it out of logs). On lost token → enrol `rotation + 1`.
  4. **Perpl funding sign** (positive rate ⇒ longs pay?): confirm from api-docs or a live funding event vs position
     PnL; N6's basis direction depends on it.

## 3. Hard rules
- Never invent addresses, market ids, decimals, endpoints, JSON fields, scope bits, error codes or package exports.
  Use deployments + core + api-docs, or `> VERIFY: <what, where>` and continue against a typed fake.
- **Ed25519 secret = key material**: derived from the PRF with core `derivePerplKey(prf, chainId, rotation)`, held in
  memory only for the unlocked session, wiped (`fill(0)`) on lock / sign-out / background lock, never in SecureStore,
  logs, React state dumps, nav params or tests. Recommended design (confirm against `controller.ts`, then implement
  with tests): derive the Perpl key in the **same PRF pass** as the EVM key inside `open()` (one Face ID per unlock,
  not per order), expose it only through a `perplSigner()` capability that signs canonical strings, never returns bytes.
- Value-moving txs (AUSD approve, `createAccount` deposit, later withdrawals) use N3's fresh per-action session
  (re-prompt). `allowOrderForwarding(true)` may use the unlocked session. All txs through N3 `sendTx`
  (gas = estimate × 1.2 ceil, pending nonce, EIP-1559, explicit chain, receipt, decoded reverts). Approve exactly the
  deposit amount (no infinite approvals).
- Amounts: bigint in token units from config decimals; deposit ≥ on-chain min (round **up** to satisfy it); order sizes
  floor to the market lot; IOC limit price with an explicit slippage cap, rounded against the user (buy up, sell down).
- Orders are forwarded (exchange pays gas) — but only after forwarding is on; READY = forwarding on **and** free
  collateral > 0 (core decision). Onboarding state is **detected** from API + chain on every launch/foreground, never
  trusted from local flags.
- One trading WS per app; signed-in with mt 29; reconnect with core delays; closed on background; resumes on
  foreground. Market-data stays N2's socket.
- Real data only; plain-language errors via core's `st/sr` table; haptics per DESIGN.md. Strict TS, tests first,
  small signed commits.

## 4. Deliverables
1. **`mobile/src/venues/perpl/`** — app wiring of core: REST client (RN `fetch`), trading socket manager (RN
   `WebSocket`, one per app, AppState aware), `perplSigner` from the session, token store (SecureStore record above,
   validated field-by-field like N3's `credentialStore`), account/position/fill readers, `usePerpl()` hooks with leaf
   subscriptions (no screen re-render per frame).
2. **Onboarding state** — core detector `NO_KEY → KEY_ENROLLED → ACCOUNT_CREATED → FORWARDING_ON → READY` run on launch,
   unlock and foreground; tx builders from core (`{ to, data, value }`) sent via `sendTx`.
3. **`(onboarding)/perpl` screen** — three resumable checks with live status, each one tap:
   ① "Enable Perpl trading" = enrol (payload → Mera EIP-712 `signTypedData` + Ed25519 proof over the digest → enroll
   → store token); ② "Deposit AUSD" = amount input (≥ live min, MAX), approve exact + `createAccount(amount)` (fresh
   prompt); ③ "Allow fast orders" = `allowOrderForwarding(true)`. Gas card: "Add ~0.5 MON for network fees" (> VERIFY
   the number from 3 measured testnet txs × current gas price; show the real estimate) with address + QR + live MON.
   Kill the app at any step → relaunch resumes at the right step (detected, not stored).
4. **Trade smoke (dev-visible, behind `__DEV__` in Settings → Dev, and reused by N5)**: IOC buy of the smallest MON
   size on Perpl with a slippage-capped limit from the live book, wait for outcome + fills (mt 25 may arrive after the
   outcome — reconcile via REST history), show position, then reduce-only IOC close; through core `exec/single`.
5. **Settings → Perpl**: account id, free collateral, forwarding status, key rotation + "Re-enable trading"
   (enrol `rotation + 1` when the token is lost or revoked).
6. **Tests** (jest-expo + RNTL + core fakes, no network): token store validation + "no secret written" scan (extend
   N3's), signer never exposes bytes + wiped on lock, detector → screen state for every state, resume after kill at
   each step, deposit ≥ min rounding, exact approve, IOC limit rounding + lot floor, socket single-instance +
   background close + reconnect, enrol 409 → rotation path, error mapping (`st/sr`). Recorded REST/WS fixtures only
   (core/K3 fixtures); **no hex keys or phrases pasted in tests**.
7. **Mainnet canary prep (ask me before each outward step):** production passkeys need
   `https://meridianfi.vercel.app/.well-known/assetlinks.json` with `xyz.meridianfi.app` + the EAS **production**
   keystore SHA-256, and an EAS `production` APK. Propose the exact steps (file content, which Vercel project serves
   it, `eas credentials -p android` for the production profile, `eas build -p android --profile production`), then
   execute only what I approve. **Fallback if not ready by Fri 9 evening:** move the canary to N9 morning and record
   that decision; testnet acceptance stands alone.

## 5. Real-device acceptance (I do the tapping — tell me exactly what to tap/approve)
After I approve: `eas build -p android --profile development` if native deps changed (else reuse dev client
`4e91111a…`); Metro on :8084. First run N3's QA rows P1–P3, P6–P7 (`docs/outputs/MOBILE_QA.md`) since nothing has been
tested on a phone yet; then:
1. Testnet: unlock → Perpl screen shows step ① → enrol → ② deposit (min from chain) → ③ forwarding → READY.
2. Kill the app between ② and ③ → relaunch → resumes at ③.
3. Dev → IOC buy smallest MON size → fill shown (order id, price, fee) → close → flat; free collateral updates.
4. Background 30 s → foreground: trading socket reconnects and signs in (one connection).
5. **Mainnet canary (only if §4.7 is done; I fund ≤ 20 AUSD + ~1 MON to a throwaway passkey labelled "canary" on
   `meridianfi.vercel.app`):** same flow on 143 market 10, smallest size, close.
Record everything in `docs/outputs/MOBILE_QA.md` (N4 section) and, for testnet + mainnet, `docs/outputs/PROOF.md`
§Mobile: account id, min-open raw value per chain, tx hashes (approve, createAccount, forwarding), order ids, fill
prices, fees, block numbers. Ask for screenshots and look at them. Tick only what was seen.

## 6. Done = acceptance
- `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm -r test` green (Node 24; mobile also Node 22);
  lockfile diff = mobile importer only.
- Testnet rows 1–4 verified on my phone with hashes/order ids in PROOF.md; mainnet canary done **or** explicitly
  moved to N9 with the reason.
- The four core §Open items answered with evidence (or still `> VERIFY` with what was tried).

## 7. Git / PR
- Branch `n4-perpl` (stacked on `n3-mera`). Conventional commits (`feat(mobile): …`, `fix(core): …` only with a
  test and called out). **SSH-signed, author SamyaDeb only, NO Claude / Co-Authored-By trailers.** Never commit
  `.env*`, keystores, `android/`, credentials JSON, API-key tokens, or recorded fixtures containing tokens/signatures
  of real accounts (redact).
- Fetch/push with the SamyaDeb token:
  `T=$(gh auth token -u SamyaDeb); git -c credential.helper= -c "credential.helper=!f(){ echo username=SamyaDeb; echo password=$T; }; f" push origin n4-perpl`
- Ask me before every `eas build`, `eas credentials`, Vercel deploy, push, PR, and every mainnet tx. PR only after
  N2 + N3 are merged and you've rebased:
  `GH_TOKEN=$(gh auth token -u SamyaDeb) gh pr create -R SamyaDeb/meridian --base main --head n4-perpl --title "[N4] mobile: Perpl onboarding, trading socket, IOC round trip, mainnet canary"`

## 8. Finish
Report: what was verified on the phone vs only in tests, PROOF.md entries (hashes, order ids), the four §Open answers,
min-open raw values, measured gas per onboarding tx, production-passkey status (assetlinks + keystore + build) and
the canary decision, anything N3 needed fixing, and what N5 can rely on (`usePerpl`, socket, IOC exec, signer).
Update MOBILE_PLAN §3 (N4 status; also N3 if its device rows passed) and append a §5 log line in
/Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md.
