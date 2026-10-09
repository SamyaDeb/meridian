You are the senior React Native + product engineer for Meridian (public name; internal codename Pulse). This session
executes MOBILE_PLAN phase **N7 — Home (portfolio), Activity, Settings, share, push**: the screen people open first — one
honest AUSD number across the wallet and both venues, live positions, a clear history — at Cash-App clarity.

## 1. Read first (fully, in this order)
1. /Users/samya/Downloads/meridian-m/CONTRIBUTING.md
2. /Users/samya/Downloads/Meridian/docs/MOBILE_UX_RESEARCH.md — §1.2 (M1–M4), §3, §5.2, §5.5, §7
3. /Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md — §1, §1.3, §3 (decisions, cut order), phase **N7**;
   /Users/samya/Downloads/Meridian/docs/LAUNCH_PLAN.md (push backend, `/api/flags`)
4. N4b Home hero + Add funds sheet + passkey card (worktree `/Users/samya/Downloads/meridian-n4b`), N5 position card +
   receipt (`/Users/samya/Downloads/meridian-n5`), N4 `venues/perpl/*` (account, positions), N2 `live/*`
5. Skills: `expo-native-app`, `mobile-app-ui-design`, `frontend-design`.

## 2. Context
- Create **`n7-home` from `n4b-ux`** (or `n5-trade` if its position card is needed now; rebase later), worktree
  `/Users/samya/Downloads/meridian-n7`, Metro port **8088**.
- Perpl account/positions: signed REST + the one trading socket (N4). Meridian: contract reads + Envio indexer for
  history (> VERIFY hosted indexer URL per env in LAUNCH_PLAN). Perpl fills: `GET /v1/trading/fills` (paged, `np`).

## 3. Hard rules
- Totals: wallet AUSD + Meridian collateral + Meridian equity + Perpl equity, each from its venue, bigint, rounded down for
  display; unknown part ⇒ total shows "—" for that part, never a guess. Real data only.
- Swipe actions always have visible buttons; push permission asked only when the user turns an alert on (progressive).
- Strict TS, tests first, small signed commits; no secrets stored (push token is not a secret but stays out of logs).

## 4. Deliverables
1. **Home (P0):** hero total AUSD + today's PnL + heartbeat; per-venue breakdown sheet; actions Trade / Earn / Add funds;
   empty state; position cards (live PnL per block, funding accrued, liq meter) with swipe Close + button; basis grouped.
2. **Activity (P1):** deposits, trades on both venues, funding payments, merged by time, each → receipt; pull-to-refresh.
3. **Settings:** passkey card (N4b), wallet identicon + copy, recovery export, Perpl card (N4), alert toggles, network
   badge, sign out, "Open full terminal" (web).
4. **P2 (cut first):** share card (`react-native-view-shot` + `expo-sharing`), push (`expo-notifications` → backend
   register; rules liq < 5 %, fills, spread, funding flip; > VERIFY Expo push / FCM credential steps), Flip / Add margin /
   Close all.
5. Tests: total aggregation (unknown parts), PnL math vs core, activity merge/sort/dedupe, swipe fallback, settings text.

## 5. Real-device acceptance (owner taps; screenshots reviewed)
Metro :8088, testnet with open positions from N5: 1) Home total = sum of each venue's own UI (screenshots side by side).
2) PnL ticks per block. 3) Close from Home. 4) Activity shows the N4/N5 actions with working receipts. 5) (if built) a
test push arrives. Record MOBILE_QA (N7).

## 6. Done / 7. Git / 8. Finish
Same gates as N5. Signed commits as SamyaDeb, no Claude trailers; ask before push / PR / EAS / credentials. PR title
"[N7] mobile: Home portfolio, Activity, Settings". Report phone vs tests; update MOBILE_PLAN §3 (N7) and a §5 log line.
