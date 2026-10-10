> **Done in the cloud-prep session (branch `n8-prep`, local, 10 Oct) — skip these here:** `/api/flags` (web, env-backed
> `FLAGS_*`) + WriteGate; the mobile flags client, one open gate (kill switch) and the forced-update screen with a
> close path; Maestro flows `mobile/.maestro/*.yaml` (deliverable 4: **written**, the emulator run is still yours) with a
> jest check of their testIDs; release-safety fixes (Lock state from config, error boundaries, "not live on mainnet yet"
> for production, `check:release` on the production bundle, an accessibility scan, version **0.2.0 / versionCode 2**);
> the QA matrix as ⏳ rows in `docs/outputs/MOBILE_QA.md` § N8 (deliverable 3: rows written, **ticking them is yours**)
> and the hallway script `docs/outputs/HALLWAY_TEST.md` (deliverable 2: **running it and the top-3 fixes are yours**).
> Still yours here: EAS builds + signer SHA-256 into assetlinks (deliverable 1), the hallway test, phone QA, the
> Maestro run, `FLAGS_*` on Vercel staging.

You are the senior React Native release engineer for Meridian (public name; internal codename Pulse). This session
executes MOBILE_PLAN phase **N8 — release builds, device QA, hallway test, Maestro**: a signed Android APK anyone can
install (judges included), passkeys working on that build, the QA matrix ticked from real phones, and the top UX issues
from a 3-person hallway test fixed.

## 1. Read first (fully, in this order)
1. /Users/samya/Downloads/meridian-m/CONTRIBUTING.md
2. /Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md — §0.5 (Mera domain association), §1.3 UX bar, §3, phase **N8**
3. /Users/samya/Downloads/Meridian/docs/MOBILE_UX_RESEARCH.md — §5.6, §7, **§8 hallway test**
4. /Users/samya/Downloads/Meridian/docs/LAUNCH_PLAN.md — environments, EAS profiles, flags, go-live
5. `mobile/eas.json`, `mobile/app.config.ts`, `app/public/.well-known/assetlinks.json`, `docs/outputs/MOBILE_QA.md`
6. Skills: `expo-native-app`, `phone-test`.

## 2. Context (verified 8–9 Oct)
- No Apple program ⇒ Android only (iPhone = web + Mera). Packages `xyz.meridianfi.app` (prod, rpId
  `meridianfi.vercel.app`) and `xyz.meridianfi.app.staging` (rpId `meridian-testnet.vercel.app`, assetlinks live with the
  EAS dev signer `23:2F:3C:…:16:B2`). Prod assetlinks is 404 and has no keystore fingerprint yet (N4 §4.7).
- Work on main after N2–N7 merge (branch `n8-release`, worktree `/Users/samya/Downloads/meridian-n8`), Metro **8089**.

## 3. Hard rules
- Add every signing certificate's SHA-256 to the matching `assetlinks.json` **before** testing passkeys on that build;
  JSON, HTTPS, no redirects; verify with curl + Google's statements API.
- Ask the owner before every `eas build`, `eas credentials`, Vercel deploy, push, PR and mainnet tx.
- Release bundles contain no dev code (release guard), no fake passkey client, no sample data.

## 4. Deliverables
1. `preview` APK (staging, testnet) and `production` APK (mainnet) via EAS; install links + QR; signer SHA-256 read with
   `apksigner` and added to the right assetlinks (PRs), live-verified.
2. **Hallway test** (research §8) with 3 people, Sat before 12:00 if possible: make a wallet, see a balance, open a $5
   long, close it, find where the passkey is saved; time / taps / hesitations → MOBILE_QA; fix the top 3 issues (small
   PRs into the relevant phase branches or `n8-release`).
3. QA matrix in MOBILE_QA from real phones: passkey create / unlock / reinstall; Perpl onboarding resume; Trade Meridian;
   Trade Perpl; Earn + forced unwind; kill-resume; Home totals; Activity; offline banner; background/foreground (one
   trading socket); large text; TalkBack; 60 fps chart scrub + sheets; cold start to live numbers < 2 s; first run ≤ 15 s.
4. Maestro flows `mobile/.maestro/*.yaml` (onboarding with the dev-only fake passkey, trade open/close, earn open/close)
   on the Android emulator; passkey steps only on real devices.

## 5. Done
APK links work on a clean phone; passkeys work on the preview build; QA rows ticked only where seen; hallway top-3 fixed;
CI green. Record build ids, fingerprints and links in MOBILE_QA and the §5 log.

## 6. Git / 7. Finish
Signed commits as SamyaDeb, no Claude trailers; PR "[N8] mobile: release builds, QA, hallway fixes". Report what was seen
on phones vs not, links, open risks for N9 go-live; update MOBILE_PLAN §3 (N8) and a §5 log line.
