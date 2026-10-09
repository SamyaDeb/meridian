You are the senior blockchain + React Native engineer and release owner for Meridian's Android app. This session does
NO new features. It takes the unmerged mobile stack **N2 → N3 → N4 → N4b** (25 signed commits, zero phone runs, zero
PRs) through one real-phone QA run, fixes what the phone shows broken, and lands it on `main` in order so N5–N8 build
on merged code. Today is Fri 9 Oct; the go/no-go is Sat 10 12:00 IST (N5 on a real phone), so speed matters, but never
tick a row you didn't see.

## 1. Read first
1. /Users/samya/Downloads/meridian-m/CONTRIBUTING.md
2. /Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md §0, §3 (status, timeline, never-cut list), phases N2, N3, N4, N4b, §5 log
3. `docs/outputs/MOBILE_QA.md` in worktree `/Users/samya/Downloads/meridian-n4b` (N3 rows P1–P7, N4b rows U1–U8) and the
   N2 rows N1–N14 (uncommitted in `/Users/samya/Downloads/meridian-m/docs/outputs/MOBILE_QA.md` — copy them in)
4. `mobile/README.md` (run instructions, dev flags), `docs/prompts/mobile/{N2-finish,N3-mera,N4-perpl,N4b-ux}.md` §5 (device steps)
5. Skills: `phone-test`, `expo-native-app` §3, §7, `perpl-api` §4

## 2. State (verified 9 Oct — don't re-derive)
| Branch | Worktree | Head | On top of | Pushed |
|---|---|---|---|---|
| `n2-shell` | /Users/samya/Downloads/meridian-m | 2b10039 (9) | origin/main 6943fb8 | no |
| `n3-mera` | /Users/samya/Downloads/meridian-n3 | c20d420 (+6) | n2-shell | no |
| `n4-perpl` | /Users/samya/Downloads/meridian-n4 | 83a1b4d (+5) | n3-mera | no |
| `n4b-ux` | /Users/samya/Downloads/meridian-n4b | 41b9bf9 (+5) | n4-perpl | no |
- origin/main = eb470e7 (PR #8 ETH-PERP, PR #9 assetlinks merged); each branch merges cleanly. All 25 commits SSH-signed
  SamyaDeb, no trailers. On `n4b-ux`: `pnpm install --frozen-lockfile` OK (lockfile changes only the `mobile` importer),
  `pnpm -r typecheck` + `pnpm -r test` green Node 24 (core 245, mobile 166), mobile green Node 22,
  `check:release` clean. Jest prints "a worker process has failed to exit gracefully" → find the leaking timer
  (`--detectOpenHandles`) and fix it (CI flake risk).
- Staging passkeys: `https://meridian-testnet.vercel.app/.well-known/assetlinks.json` live (200 JSON, no redirect,
  Google statements API lists `xyz.meridianfi.app.staging` with SHA-256 23:2F:3C…16:B2 = EAS dev APK signer).
- **No native dependency changed since EAS dev build `4e91111a-2935-4791-becc-f9ed9cac11aa`** (commit 4afa094, has
  react-native-passkey) ⇒ install that APK and load `n4b-ux` JS from Metro; no new build needed. APK page:
  https://expo.dev/accounts/samyadeb/projects/meridian/builds/4e91111a-2935-4791-becc-f9ed9cac11aa
- Ports: other sessions may hold 8081–8086; use **8090**. Don't kill other sessions' Metro processes.
- Measured in N4: Perpl min account-open 10 AUSD mainnet / 100 testnet; enrol works without Origin; enrol 404 for a
  wallet Perpl never saw (app offers deposit first); funding positive ⇒ longs pay. N4b adds testnet "Get test funds"
  (faucet MON link, then mint 10,000 test AUSD from Meridian's AUSD mock — never on 143). Perpl testnet collateral
  (`0xa901…22dc`) for the deposit: check N4's notes/README for how it's obtained; ask me if a human step is needed.
- Mainnet canary (N4 step 5) is **not** in this session unless I say so; production assetlinks
  (`meridianfi.vercel.app`) still 404.
- HTTPS git with the active gh account fails; use the SamyaDeb token for fetch/push:
  `T=$(gh auth token -u SamyaDeb); git -c credential.helper= -c "credential.helper=!f(){ echo username=SamyaDeb; echo password=$T; }; f" push origin <branch>`

## 3. Steps
1. **Phone run on `n4b-ux`** (it contains all four phases). From `/Users/samya/Downloads/meridian-n4b/mobile`:
   `APP_ENV=development npx expo start --dev-client --port 8090 --lan` in the background (tunnel if LAN fails); give me
   the APK link + Metro URL. Tell me exactly what to tap. Run in this order and record each row in MOBILE_QA
   (✅/❌, seen by owner vs claude, phone model + Android version, note):
   a. **N2 N1–N14** (shell, live Welcome/Home numbers per block, sheets, background/foreground, offline, large font,
      TalkBack, Hermes smoke → record `deriveEvmKey` ms into core README §Open if still open)
   b. **N3 P1–P7** (passkey create → address, kill/reopen + reinstall → same address, recovery export → MetaMask/Rabby
      same address, lock timers via `EXPO_PUBLIC_SHORT_LOCK=1`, cancel/offline errors, 0-MON self-send if funded)
   c. **N4b U1–U8** (one-button onboarding, Wallet ready, Home hero + arrival toast, Add funds sheet, Get test funds,
      passkey card)
   d. **N4 testnet**: Perpl enable → deposit (≥ 100 test AUSD per measured min) → allow fast orders → READY; kill between
      steps → resumes; Dev → IOC buy smallest MON size → fill (order id, price, fee) → reduce-only close → flat;
      background 30 s → one trading socket reconnects. Put account id, tx hashes, order ids, block numbers in
      `docs/outputs/PROOF.md` §Mobile (testnet).
   Ask for screenshots/recordings and look at them. Watch Metro for red boxes / warnings.
2. **Fix on the branch that owns the bug** (N2 bug → `n2-shell`, etc.) in small signed commits with a test where
   testable, then cascade: `git -C <n3 wt> rebase n2-shell`, `<n4 wt> rebase n3-mera`, `<n4b wt> rebase n4-perpl`
   (worktrees, not checkouts). Re-run typecheck + tests at the top after each cascade. JS fixes reload via Metro; a
   native change needs a new dev build — ask me first.
3. **Docs**: MOBILE_QA rows committed on the right branches (N2 rows on `n2-shell`, …); MOBILE_PLAN §3 status per phase
   (verified on phone or not) + one §5 log line with phone model, Hermes numbers, testnet proof, fixes.
4. **PR train — ask me before each push/PR.** For each branch in order:
   a. N2: rebase `n2-shell` onto origin/main, final checks (`pnpm install --frozen-lockfile`, `pnpm -r typecheck`,
      `pnpm -r test`, mobile on Node 22, lockfile diff = mobile importer only), push, open
      `GH_TOKEN=$(gh auth token -u SamyaDeb) gh pr create -R SamyaDeb/meridian --base main --head n2-shell --title "[N2] mobile: Expo shell, design system, live layer"`
      — body: acceptance with ✅ only for phone-verified rows, versions, VERIFY list, "Android only". Wait for CI
      (ts job + GitGuardian); tell me to merge.
   b. After I merge: `git fetch`, `git rebase --onto origin/main n2-shell n3-mera` (in the n3 worktree), checks, push,
      PR "[N3] mobile: Mera passkey login, session security, recovery export, send helper".
   c. Same for `n4-perpl` → "[N4] mobile: Perpl onboarding, trading socket, IOC round trip" and `n4b-ux` →
      "[N4b] mobile: one-button passkey onboarding, Home hero, deposit arrival, passkey card".
   If a PR's CI fails, fix on that branch and re-cascade the ones above it.
5. Tell the N5 session (if running, `/Users/samya/Downloads/meridian-n5` on `n5-trade`) to rebase onto origin/main
   after N4b merges — message me the exact command instead of running it in their worktree.

## 4. Rules
Never invent addresses/IDs/package APIs (write `> VERIFY`). Never change the repo `.npmrc` linker; never print
~/.npmrc, tokens or keys. Key material only in memory. Real data only. Commits conventional, **SSH-signed, author
SamyaDeb, NO Claude / Co-Authored-By trailers**; never commit `.env*`, keystores, `android/`, API tokens. Ask before
every `eas build`, push, PR, Vercel deploy or mainnet tx. No new features.

## 5. Finish
Report: QA table (owner-verified vs claude-seen, ❌ with cause), testnet PROOF entries, fixes and which branch, PR
links + CI status + merge state per phase, anything that blocks N5's go/no-go (passkey on the phone, Perpl READY,
an IOC fill, live numbers).
