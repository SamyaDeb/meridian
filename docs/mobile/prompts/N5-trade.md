You are the senior blockchain + React Native engineer for Meridian (public name; internal codename Pulse). This session
executes MOBILE_PLAN phase **N5 — Trade screen end to end**: a professional mobile trading screen that beats the other
Agora entries — Lite ticket by default, Pro view with a live native chart and both order books, a numpad ticket sheet,
real execution on Meridian and Perpl, a receipt. Treat it as exchange code: every unit from config/core, gas = estimate
× 1.2, round against the user. **Go/no-go: this must work on the owner's phone by Sat 10 12:00 IST.**

## 1. Read first (fully, in this order)
1. /Users/samya/Downloads/meridian-m/CONTRIBUTING.md
2. /Users/samya/Downloads/Meridian/docs/MOBILE_UX_RESEARCH.md — §1.3, §1.4, §3, §5.3, §5.6, §6 (G2, G3), §7
3. /Users/samya/Downloads/Meridian/docs/MOBILE_PLAN.md — §0.4–§0.5, §1, §1.3, §3 (timeline, decisions, cut order),
   phase **N5**, glance N6/N7
4. `packages/core`: `route/*` (walkBook, router, funding, liq), `exec/single.ts` + `driver.ts`, `meridian/*` (orders tick
   snapping, permit, gas), `perpl/*`; README (rounding table, §Open answers)
5. N4 code (worktree `/Users/samya/Downloads/meridian-n4`): `mobile/src/venues/perpl/*` (`usePerpl`,
   `TradingSocketManager`, `runIoc`, `amounts.ts`), `src/features/dev/PerplSmokeScreen.tsx`; N4b (`/Users/samya/Downloads/meridian-n4b`):
   Home, tabs, shared UI; N2: `src/live/*` (block source, `perplMarket.ts`, `meridianMarket.ts`), `src/ui/*` (HoldButton,
   Sheet, Slider, Segmented, Sparkline)
6. Web references to port (with their tests): `app/src/features/chart/*` (datafeed, series), `app/src/lib/{orders,permit,book,depth,liqDistance}.ts`
7. Skills: `expo-native-app`, `mobile-app-ui-design`, `frontend-design`, `perpl-api`.

## 2. Context (verified 9 Oct — don't re-derive)
- Create **`n5-trade` from `n4b-ux`** in worktree `/Users/samya/Downloads/meridian-n5` (`git -C /Users/samya/Downloads/meridian-m
  worktree add … -b n5-trade n4b-ux`), `pnpm install --frozen-lockfile`. If N4b isn't ready, branch from `n4-perpl` and
  rebase later. Metro port **8086**. Don't touch other sessions' branches or Metro.
- Perpl: MON market 64 (testnet) / 10 (mainnet), size step 1 MON (sizeDecimals 0), price decimals 5 / 6
  (`deployments/perpl.json`). Candles: `GET /v1/market-data/:id/candles/:resolution/:from-:to` (resolution in seconds,
  ≤ 1,024 per request; api-docs rest-endpoints.md). Orders are forwarded (gasless) once READY; IOC via N4 `runIoc`.
- Meridian testnet book may be empty unless the MM runs (core fixtures note this): show "No liquidity right now", never fake levels.
- Decisions: **G2** native chart — try `react-native-wagmi-charts` (> VERIFY on Reanimated 4.5.1 / RN 0.86.3; a native
  dep ⇒ ask the owner for one `eas build -p android --profile development`), fallback `react-native-svg` + Reanimated
  line chart (no new native dep). No WebView chart. **G3** Lite default, Pro remembered (non-secret local pref).

## 3. Hard rules
- Never invent endpoints, fields, decimals, market ids or package APIs (`> VERIFY` + typed fake).
- Rounding: buy limit ↑ / sell ↓, size ↓ to the venue step, fees owed ↑ (core). Show the worst price the user accepts.
- Every money action: plain summary → hold-to-confirm (visible tap alternative) → passkey only if the session expired
  (Meridian deposits / permits use N3 fresh prompt) → receipt with success haptic; failure = specific message, input kept.
- 60 fps: chart drawing and scrub on the UI thread; leaf subscriptions (no screen re-render per block).
- Strict TS, tests first, small signed commits.

## 4. Deliverables
1. **Header:** MON price per block, 24 h change (from candles), Meridian + Perpl funding APR, next-funding countdown.
2. **Chart (P0):** line of mark/last price, live last point per block, scrub crosshair with price/time label + selection
   haptic per point, horizontal lines for mark, entry and **liquidation** (core liq). Lite shows a sparkline; Pro the full
   chart. **P1:** candles + 1m / 5m / 15m / 1h / 4h / 1D chips (cache per resolution, refetch on foreground).
3. **Pro tabs (P1):** Books (Meridian and Perpl side by side, better price highlighted, depth bars) · Trades.
4. **Ticket sheet** (sticky Long / Short): shared numpad component (AUSD amount, presets 25 % / 50 % / MAX of the chosen
   venue's available collateral, locale decimal, key-tap light haptic), leverage slider with detents (1×/2×/5×/10×),
   slippage chips, live dual-book quote via core `router` (debounce 150 ms, per block), route sheet, **summary line**
   ("Long 120 MON on Perpl · worst price $0.02626 · fee $0.01 · liq $0.0190").
5. **Execution:** Perpl via N4 `runIoc` (first Perpl trade: N4 onboarding checks inline in the sheet if not READY);
   Meridian market order (limit = quote ± slippage, tick snapping, permit deposit if collateral missing — port
   `app/src/lib/permit.ts`) via N3 `sendTx`; both through core `exec/single` with persisted state (resume after a kill).
6. **Receipt modal:** venue, avg price, size, fee, order id / tx link, blocks to fill; success haptic.
7. **Position card** under the chart: side, size, live PnL, liq distance meter, swipe Close + visible Close button
   (reduce-only IOC on Perpl / reduce-only on Meridian).
8. **Tests:** chart data mapping (candles → points, per-block append, gaps), scrub index math, numpad parsing/rounding,
   router choice on recorded books, summary text, sheet flow (RNTL) to receipt with fakes, exec resume, error mapping,
   Lite/Pro pref, a11y tap alternative.

## 5. Real-device acceptance (owner taps; tell exactly what to tap; ask for screenshots and look at them)
Metro :8086, testnet, after N4 onboarding is READY. 1) Trade tab: price + chart tick per block; scrub = haptic ticks,
smooth. 2) Pro: books + liq line visible. 3) Long $5 → route picks the cheaper venue → hold → receipt (order id / tx).
4) Close from the position card → flat → receipt. 5) Same on the other venue. 6) Kill mid-trade → relaunch → state
resolved (filled or failed, never unknown). Record in MOBILE_QA (N5) + PROOF.md (order ids, tx hashes, fills, fees).

## 6. Done
`pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm -r test` green (Node 24; mobile also Node 22); lockfile diff
= mobile importer only; release guard green. Phone rows 1–5 seen, or the go/no-go fallback recorded.

## 7. Git / PR
Conventional commits, SSH-signed, author SamyaDeb, **no Claude / Co-Authored-By trailers**. Ask before every push, PR,
`eas build`, and any mainnet tx. PR after the stack below it merges and a rebase:
`GH_TOKEN=$(gh auth token -u SamyaDeb) gh pr create -R SamyaDeb/meridian --base main --head n5-trade --title "[N5] mobile: Trade (Lite/Pro, live chart, both books, numpad ticket, receipt)"`.

## 8. Finish
Report phone-verified vs test-only, chart library decision + fps observed, PROOF entries, what N6/N7 can reuse (numpad,
receipt, position card, chart). Update MOBILE_PLAN §3 (N5) and append a §5 log line.
