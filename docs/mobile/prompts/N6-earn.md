You are the senior blockchain + React Native engineer for Meridian (public name; internal codename Pulse). This session
executes MOBILE_PLAN phase **N6 — Earn: two-leg basis executor + Lock**: "Earn X % APR on AUSD" as one hold-to-confirm,
executed as two legs (Perpl IOC first, then Meridian for exactly the filled size) with automatic unwind, resumable after
an app kill, shown as a receipt timeline. This is the "creative use of the three integrations" story — it must be
correct before it is pretty.

## 1. Read first (fully, in this order)
1. /Users/samya/Downloads/meridian-m/CONTRIBUTING.md
2. /Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md — §0.4 rule 7, §1, §3 (decisions, cut order), phase **N6**
3. /Users/samya/Downloads/Meridian/docs/MOBILE_UX_RESEARCH.md — §3, §5.4, §7
4. `packages/core`: `exec/{basis,close,leg,persist,driver}.ts`, `route/{basis,funding,lock,crossVenue}.ts`, README
   ("Exec machines: resume after an app kill"; funding sign: positive ⇒ longs pay)
5. N5 code (worktree `/Users/samya/Downloads/meridian-n5`): numpad, receipt, position card, Meridian + Perpl leg adapters;
   N4 `venues/perpl/*`
6. Skills: `perpl-api`, `expo-native-app`, `mobile-app-ui-design`.

## 2. Context
- Create **`n6-earn` from `n5-trade`** (worktree `/Users/samya/Downloads/meridian-n6`), Metro port **8087**.
- Leg adapters exist from N5 (Perpl `runIoc`, Meridian order via `sendTx`); N6 wires core `runBasis` / `runClose` with
  persistence (versioned bigint-safe JSON, non-secret: rq numbers / tx hashes only) in app storage allowed for exec state.
- Lock = P2 (cut first). Funding sign: positive rate ⇒ longs pay shorts (core README §Open).

## 3. Hard rules
- Net MON exposure after DONE = 0 or an alert; never leave a naked leg silently. Unwind failure ⇒ in-app alert + retry 2×
  wider, then one-tap manual close.
- Persist after every event; on launch resume from the snapshot (tested from every snapshot).
- Same money-action pattern as N5 (summary → hold/tap → passkey if needed → receipt), specific errors, input kept.
- Strict TS, tests first, small signed commits; never invent units or endpoints.

## 4. Deliverables
1. Earn screen: hero "Earn X % APR on AUSD" net of fees (live, per block), 24 h sparkline, numpad amount (presets) →
   "≈ $Y / day", legs preview in plain words, "No edge right now" + next funding time, 3-step explainer, Lock toggle (P2).
2. Executor wiring: `runBasis` with N5 adapters + `ensureCollateral` (move AUSD if a venue is short, fresh prompt), state
   persisted; `runClose` for closing (Meridian first, then Perpl for exactly what closed).
3. Receipt timeline: each leg sent → filled / partial / unwound with order ids and tx links; PARTIAL_DONE /
   ABORTED_UNWOUND / MANUAL in plain words; success haptic only on DONE.
4. Dev flag (`__DEV__` only): force the Meridian leg to fail → auto-unwind path on the phone.
5. Tests: plan → each terminal phase with fakes; resume from every persisted snapshot; unwind retry; UI states (RNTL).

## 5. Real-device acceptance (owner taps; screenshots reviewed)
Testnet, Metro :8087: 1) open basis $10 → both legs fill → timeline + receipt. 2) close → flat on both venues. 3) dev flag
forced failure → Perpl auto-unwound. 4) kill mid-trade → relaunch → resumes to a terminal phase. Record MOBILE_QA (N6) +
PROOF.md (order ids, tx hashes).

## 6. Done / 7. Git / 8. Finish
Same gates as N5 (`pnpm -r typecheck`, `pnpm -r test`, Node 24 + mobile Node 22, release guard, lockfile = mobile only).
Signed commits as SamyaDeb, no Claude trailers; ask before push / PR / EAS / mainnet tx. PR title
"[N6] mobile: Earn (two-leg basis, auto-unwind, resume, receipt timeline)". Report phone vs tests, PROOF entries; update
MOBILE_PLAN §3 (N6) and append a §5 log line.
