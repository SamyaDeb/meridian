# WS-07 — Frontend PWA (mobile-first, Privy, AUSD)

**Founder:** C

**Goal:** An installable, phone-first Next.js app where anyone logs in (Privy **or** Mera, one only, decided by Day 2 from the Agora/Mera criteria), trades MON-PERP, deposits into the vault with one tap, and fixes their funding rate with a swap. Live per-block funding, oracle APR and yield tickers. It has to look good in the demo video.

## Owned paths
`app/**`.

## Interfaces
Consumes: ABIs (`abis/`), `deployments/<chainId>.json`, indexer GraphQL (`indexer/SCHEMA.md`), contract views (`getAccount`, `previewFundingState`, `averageFundingApr`, `markPrice`, `hedgeState`, `shortCapacity`, `sharePrice`, swap `markApr`/`getAccount`/`timeToMaturity`). Until WS-06 is live, use a typed mock data layer (`app/src/data/mock/*`) with the same shapes as SCHEMA.md.

## Task checklist (ordered)
1. [ ] Next.js (App Router, TS strict), Tailwind, wagmi + viem, Privy (`@privy-io/react-auth`) with Monad 143 + 10143 chains (supported, R21). **Also evaluate Mera passkey login** (Agora bounty signal, BOUNTY_MAP). PWA manifest + service worker; installable on iOS/Android.
2. [ ] Data layer: `useFundingTicker` (new block subscription over WSS + `previewFundingState`, falling back to indexer polling), `usePosition`, `useVault`, `useSwap`, `useFundingOracle`. One source of truth for formatting (AUSD 2 dp, prices by tick, APR %).
3. [ ] Screens (bottom tab nav, 390×844 first): **Trade** (price, funding rate + "next block" ticker, long/short, size slider, leverage, liq price preview, order book depth, limit/market), **Positions** (pnl, funding paid/received live, close, add margin), **Earn** (vault: one-tap deposit, APY, NAV chart, hedge status), **Fix** (funding swap: realized vs fixed APR, go long/short at a fixed APR, accrual ticking, maturity countdown), **Stats** (volume, fees, users; benchmark links).
4. [ ] Tx UX: approve+deposit in one tap (**AUSD supports ERC-2612 permit, verified on a fork**. Use a permit signature + deposit; the vault/CH may add `depositWithPermit` via a CR), toasts with explorer links (monadscan), tight gas limits.
5. [ ] Wire to the indexer (CP2), then mainnet config (CP3).
6. [ ] Polish for video: skeleton loaders, haptics, dark theme, AUSD-only copy.
7. [ ] Stretch: Aurora intents deposit (only if RISKS cut order allows).

## Acceptance criteria
- Lighthouse PWA installable; mobile performance ≥ 80.
- Login → first trade in ≤ 4 taps after funding the wallet; vault deposit = 1 confirmation.
- Funding ticker visibly updates several times per second on mainnet.
- All amounts are AUSD-denominated and use the correct 6-dp decimals conversion.
- Works on iOS Safari and Android Chrome (manual checklist in `app/QA.md`).

## Required tests
vitest for formatters, math helpers (liq price preview, swap accrual preview and oracle APR must match MATH_SPEC to 1e-6), hooks with mocked clients; Playwright smoke (mobile viewport) for the main flows against local anvil.

## Out of scope
Contracts, indexer internals, native mobile apps.

## Day budget
D1 shell + Privy · D2 trade screen (mock) · D3 positions + ticker · D4 vault · D5 CP1 on testnet · D6 Fix (swap) screen · D7 wire indexer · D9 CP2 · D10–11 mobile polish, PWA · D12 CP3 · D13 polish · D14 video capture.

## Kickoff prompt
```
You are the engineer for WS-07 (mobile-first Next.js PWA with Privy, AUSD) of Pulse.
Read CLAUDE.md, docs/TEAM_PLAN.md, docs/PRD.md (user stories US1–US10), docs/DEMO_SCRIPT.md, docs/BOUNTY_MAP.md, docs/INTERFACES.md, docs/MATH_SPEC.md (§1.8 oracle APR, §3.2 liq price, §6 swaps) and docs/workstreams/WS-07-frontend.md.
Work only in app/ on branch ws-07-frontend.
Start with the shell (Next.js App Router, wagmi/viem, and the single login chosen by the team: Privy or @category-labs/mera) and a typed mock data layer matching indexer/SCHEMA.md (or INTERFACES §3 if SCHEMA.md isn't there yet).
Design for a 390px-wide phone first. All values are in AUSD (6 decimals onchain). Never hard-code addresses; read deployments/<chainId>.json.
```
