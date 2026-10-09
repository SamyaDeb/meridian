You are the senior React Native + product engineer for Meridian (public name; internal codename Pulse). This session
executes MOBILE_PLAN phase **N4b — UX polish from the research**: make the first minute of the Android app feel like a
top consumer money app (Privy/Google-login simple, Cash-App clear) on screens that already exist. Small, visible,
well-tested changes; no new venue logic.

## 1. Read first (fully, in this order)
1. /Users/samya/Downloads/meridian-m/CONTRIBUTING.md
2. /Users/samya/Downloads/Meridian/docs/MOBILE_UX_RESEARCH.md — all (esp. §1.1 L4–L7 FIDO, §1.2, §3 principles, §4 gap
   table, §5.1–§5.2, §5.5 passkey card, §5.6 feel)
3. /Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md — §1 (spec), §1.3 UX bar, §3 timeline + decisions, phase **N4b**
4. `mobile/DESIGN.md` (tokens, haptics map, accessibility), then the code you change: `src/app/(onboarding)/*`,
   `src/app/(tabs)/_layout.tsx`, `src/app/(tabs)/portfolio.tsx`, `src/features/auth/*`, `src/features/wallet/*`,
   `src/wallet/balances.ts`, `src/features/perpl/PerplOnboarding.tsx` (copy only), tests under `src/__tests__/`
5. Skills: `mobile-app-ui-design`, `frontend-design`, `expo-native-app`, `mera-passkeys` §5 (errors).

## 2. Context (verified 9 Oct — don't re-derive)
- Branch stack: `n2-shell` → `n3-mera` → `n4-perpl` (worktree `/Users/samya/Downloads/meridian-n4`, 5 signed commits,
  unpushed). Create **`n4b-ux` from `n4-perpl`** in a new worktree:
  `git -C /Users/samya/Downloads/meridian-m worktree add /Users/samya/Downloads/meridian-n4b -b n4b-ux n4-perpl`, then
  `pnpm install --frozen-lockfile` (check `df -h /` first). Don't commit on other branches; don't kill other sessions'
  Metro; use port **8085**.
- Dev build `4e91111a` (no native deps added since). Passkeys on staging rpId `meridian-testnet.vercel.app` (assetlinks
  live). Tests today: mobile 146, core 245.
- Owner decisions: G1 "add a little MON" copy (no gas drip in this phase); G3 Trade Lite default (N5's job).

## 3. Hard rules
- Copy from the research verbatim where it says so (FIDO-tested lines); otherwise plain, sentence case, no chain words in
  the main path (no hex, "approve", "nonce", "chain id"); hex only behind "Details" / copy.
- Never show the address as identity on onboarding screens. Never store anything new except non-secret UI prefs.
- Every gesture keeps a single-tap alternative (WCAG 2.5.1/2.5.7). Haptics per DESIGN.md; never the only signal.
- Numbers: real data only, "—" when unknown, tabular figures. Strict TS, tests first, small signed commits.

## 4. Deliverables
1. **One-button onboarding:** Welcome = live spread + primary "Continue with passkey" (passkey symbol, `react-native-svg`)
   + text link "Use an existing passkey". Create = FIDO hero ("Your fingerprint is your wallet" / "Passkeys are encrypted
   digital keys you create using your fingerprint, face, or screen lock. Saved in Google Password Manager, so a new phone
   signs you back in.") → **Create my wallet** → OS sheet → "Wallet ready ✓" (600 ms, success haptic) → Home. Cancel ⇒
   calm line, no red. Unlock copy "Unlock with your fingerprint". Keep N3's error mapping (PRF missing, association).
2. **Identity:** deterministic identicon from the address + "Wallet ••a3f2"; full address in the copy sheet only.
3. **Tabs:** Home · Trade · Earn · Settings; Home = `(tabs)/portfolio`, first tab, default after unlock.
4. **Home hero (wallet part):** total AUSD (wallet balances now; venue equity arrives in N7 — leave a typed slot),
   heartbeat, actions Trade / Earn / Add funds; empty state "Add AUSD to start" (testnet: "Get test funds" → faucet).
5. **Add funds sheet:** QR, copy, share (RN `Share`), "Waiting for your deposit…"; a pure `detectArrival(prev, next)` on
   BalanceReader updates → toast "+12.50 AUSD arrived" + success haptic + count-up.
6. **Settings passkey card:** "Passkey · Google Password Manager · active", where it lives, what sign-out does (visible
   text). Perpl card stays (N4).
7. **Copy pass** on N4's Perpl screen and errors: "Allow Perpl to use exactly X AUSD", errors keep input, explicit success.
8. **Tests:** RNTL flows for Welcome → hero → ready → Home (fake WebAuthn), cancel copy, identicon determinism, arrival
   detector (pure), tab order, passkey card text; all existing tests green.

## 5. Real-device acceptance (owner taps; tell exactly what to tap; ask for screenshots and look at them)
Metro on :8085. 1) Fresh install → stopwatch: launch → Home ≤ 15 s, 2 taps + fingerprint, "Wallet ready" seen.
2) Cancel the OS sheet → calm message. 3) Owner (or the K3 wallet, with approval) sends test AUSD → arrival toast +
haptic seen. 4) TalkBack on: every new control is read. Record in `docs/outputs/MOBILE_QA.md` (N4b section). Tick only
what was seen.

## 6. Done
`pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm -r test` green (Node 24; mobile also Node 22); lockfile diff
= mobile importer only (only if a dep was added — prefer none); release guard `pnpm --filter @meridian/mobile check:release`.

## 7. Git / PR
Conventional commits `feat(mobile): …`, SSH-signed, author SamyaDeb only, **no Claude / Co-Authored-By trailers**. Ask
before every push, PR, `eas build`. PR only after N2–N4 merge and a rebase:
`git rebase --onto origin/main n4-perpl n4b-ux`, then
`GH_TOKEN=$(gh auth token -u SamyaDeb) gh pr create -R SamyaDeb/meridian --base main --head n4b-ux --title "[N4b] mobile: one-button passkey onboarding, Home hero, deposit arrival, passkey card"`.

## 8. Finish
Report what was seen on the phone vs only in tests (with the stopwatch time), screenshots reviewed, anything N5/N7 must
know (Home slot for venue equity, shared components added). Update MOBILE_PLAN §3 (N4b status) and append a §5 log line.
