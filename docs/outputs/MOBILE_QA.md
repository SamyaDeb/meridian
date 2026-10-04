# Mobile QA checklist (C4): run by a founder on real phones

Build: production (`pnpm --filter @pulse/app build && start`, or the deployed URL), on the network under test. Fill in one column per device with ✅ / ❌ + a note. A ❌ is a bug on `ws-07*` before Wed 7 Oct.

| # | Check | iOS Safari (model, iOS ver) | Android Chrome (model, ver) |
|---|---|---|---|
| 1 | Add to home screen → opens standalone (no browser bar), icon + name "Pulse" | | |
| 2 | Login (provider per the decision) → address + AUSD balance visible; **time it: < 30 s (US1)** | | |
| 3 | First write shows the terms gate once; after Accept it doesn't ask again | | |
| 4 | Deposit AUSD (one signature + one tx with permit) | | |
| 5 | Open a position (market long), see entry / liq price / funding ticking | | |
| 6 | Close the position (reduce-only) | | |
| 7 | Earn: deposit → share price visible; redeem preview shows path + fee | | |
| 8 | Fix: pay fixed (long) → accrual ticks → close | | |
| 9 | Bottom nav: all 5 tabs reachable with the thumb; active tab highlighted | | |
| 10 | Tap targets ≥ 44 px (no mis-taps on Long/Short, Market/Limit, Deposit) | | |
| 11 | No horizontal scroll on any tab (portrait) | | |
| 12 | Safe areas: nothing under the notch / home indicator; bottom nav clears the home bar | | |
| 13 | Inputs don't zoom the page on focus; pinch-zoom still works | | |
| 14 | "Terms & risks" footer link opens `/terms` | | |
| 15 | Offline / flaky network: app shell loads; errors are readable, no blank screen | | |

Automated coverage (not a substitute): Playwright at 390×844 checks no horizontal scroll + buttons ≥ 44 px on Earn/Fix (`e2e/earn-fix.spec.ts`) and the terms/geo flow (`e2e/terms-geo.spec.ts`); Lighthouse numbers in `docs/standup/C.md`.
