You are the senior blockchain + React Native engineer for Meridian. This session **finishes MOBILE_PLAN phase N2**
(Expo shell, design system, live layer). The code is written and verified; what's left is the real-phone install,
device acceptance, the Hermes numbers, docs, and the PR. Do not rewrite N2 — fix only what the device run shows broken.

## 1. Read first
1. /Users/samya/Downloads/meridian-m/CONTRIBUTING.md
2. /Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md §0, §1.3 (UX bar), phase **N2** (acceptance), §5 log
3. /Users/samya/Downloads/Meridian/docs/prompts/mobile/N2-shell.md §5–§8 (the original brief's device steps, done-criteria, git rules)
4. /Users/samya/Downloads/meridian-m/mobile/README.md and packages/core/README.md §Open
5. Skills: `expo-native-app` §3, §7, §8; `phone-test` §5

## 2. State at hand-off (verified 8 Oct ~18:35 IST — don't redo)
- Clone `/Users/samya/Downloads/meridian-m`, branch **`n2-shell`**, 9 commits on origin/main 6943fb8, clean tree,
  **not pushed, no PR**. Commits SSH-signed SamyaDeb, no trailers.
- Verified: `pnpm install --frozen-lockfile` OK (lockfile changes only the `mobile` importer); `pnpm -r typecheck`
  green (11 packages, Node 24); `pnpm -r test` green (core 241, mobile 30, app/bots/mfi all green); mobile typecheck +
  tests green on Node 22 (CI). Expo SDK 57.0.27, RN 0.86.3, Reanimated 4.5.1, TS 6.0.3 in mobile.
- EAS project `@samyadeb/meridian` (id 802495fa-…), owner `samyadeb`. **Dev build `199097cf-2d7e-4291-bca4-7471d2a71dc6`**
  (profile development, commit 2b10039, Android APK, package `xyz.meridianfi.app.staging`, name "Meridian Dev") was
  in progress since 18:16. Check: `cd mobile && npx eas-cli@latest build:view 199097cf-2d7e-4291-bca4-7471d2a71dc6`.
  Logs: https://expo.dev/accounts/samyadeb/projects/meridian/builds/199097cf-2d7e-4291-bca4-7471d2a71dc6
- No `mobile/.env.local` → development uses viem's public `monadTestnet` RPC with the "public RPC" badge (fine for N2).
  Never create/print secrets; if the owner wants the paid app-tier RPC, they put it in `.env.local` themselves.
- Mac LAN IP was 192.168.1.10 (re-check `ipconfig getifaddr en0`). No USB needed; `adb` is installed if a cable is used.
- Meridian testnet book may be empty (MM bot not running) → "—" / "No liquidity right now" on Meridian is expected.
- core README §Open still has "Hermes runtime cost and globals (N2 smoke)" → you close it with measured numbers.
- HTTPS git with the active gh account fails; use the SamyaDeb token:
  `T=$(gh auth token -u SamyaDeb); git -c credential.helper= -c "credential.helper=!f(){ echo username=SamyaDeb; echo password=$T; }; f" push origin n2-shell`

## 3. Steps
1. **Build.** Poll the build (≤ 1/min). If it **failed**: read the EAS logs, fix the cause in a small signed commit
   (common: pnpm/Metro resolution, Node version, lockfile, prebuild plugin), re-run typecheck + tests, and **ask me
   before** a new `eas build -p android --profile development`. If it **finished**: print the APK/install URL and a
   QR (`npx qrcode-terminal "<url>"`) plus the plain URL.
2. **Install (I tap).** Tell me exactly: phone on the same Wi-Fi as the Mac; open link → download → allow "Install
   unknown apps" for Chrome/Files → install "Meridian Dev".
3. **Dev server.** Run `npx expo start --dev-client` from `mobile/` in the background (keep it running, show me its
   QR/URL `http://<lan-ip>:8081`). If the phone can't connect (client isolation), restart with `--tunnel`.
   Watch Metro logs for red-box errors/warnings while I test; fix real errors.
4. **Device acceptance (I do it, you guide and record).** Ask for screenshots/a screen recording and look at them:
   - cold start → Welcome shows block number ticking per block, Meridian APR / Perpl APR / spread (or honest "—")
   - all 4 tabs; open a sheet; HoldButton demo (haptic, cancel on release); Slider detents haptics
   - background 30 s → foreground resumes and refetches; airplane mode → offline banner → back online recovers
   - large font (Settings → Display → Font size max): no clipped numbers; TalkBack labels on a few controls
   - Settings → **Hermes smoke (dev)**: all rows green; get the numbers (esp. `deriveEvmKey` ms, Ed25519 sign,
     getRandomValues, TextEncoder, atob/btoa, structuredClone, JSON ABI import, bigint JSON, getBlockNumber, Perpl REST)
   - icon, adaptive icon, splash, dark theme, safe areas (notch, gesture bar)
   Record every row in `docs/outputs/MOBILE_QA.md` in meridian-m (✅/❌ + note + phone model + Android version;
   mark which rows I verified vs you saw only in Metro/screenshots). Do NOT tick anything not seen.
5. **Fix what fails** (small commits, tests first where testable, typecheck + `pnpm -r test` green). JS-only fixes:
   reload via Metro, no new build. Native changes (new native package/plugin) need a new build — ask first.
6. **Close N1's open item:** in `packages/core/README.md` §Open replace the Hermes VERIFY with the measured numbers,
   phone model, and any polyfill that turned out needed (and add it to `mobile/polyfills.ts` if so). If
   `deriveEvmKey` is > ~1.5 s, note it as an N3 risk (show a "Unlocking…" state / run after first paint).
7. **Docs.** `mobile/README.md`: how to install the dev build, run Metro, env vars, profiles. In
   /Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md: §3 N2 row status (what's verified, PR #), §5 log line
   (versions, build id, Hermes numbers, gotchas). Note "iOS: none (no Apple program)".
8. **Final checks:** `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm -r test` (Node 24, and mobile on
   Node 22); lockfile diff vs origin/main still only the mobile importer; `git ls-files mobile` has no .env/keystore/android/ios.
9. **Push + PR — ask me first.** Then push with the SamyaDeb token and:
   `GH_TOKEN=$(gh auth token -u SamyaDeb) gh pr create -R SamyaDeb/meridian --base main --head n2-shell --title "[N2] mobile: Expo shell, design system, live layer"`
   Body: acceptance criteria with ✅ only for verified items, device QA table summary, Hermes numbers, versions,
   VERIFY list, "Android only". Wait for CI; report the ts job result. GitGuardian must stay clean (no hex keys in tests).

## 4. Rules
Never invent addresses/IDs/package APIs (write `> VERIFY`). Never change the repo `.npmrc` linker; never print
~/.npmrc or secrets. Real data only. Commits: conventional (`fix(mobile): …`, `docs(mobile): …`), **SSH-signed,
author SamyaDeb, NO Claude / Co-Authored-By trailers**. Ask before every `eas build`, push, or PR. Don't start N3.

## 5. Finish
Report: build id + install URL, device QA table (verified by me vs by you), Hermes numbers, fixes made, PR link + CI
status, anything that blocks N3 (Mera: Google Password Manager on the phone, assetlinks with the EAS signing SHA-256
from `eas credentials`, `deriveEvmKey` cost).
