# CLAUDE.md — Meridian

Meridian = Monad's funding-rate layer (per-block-funding perp, funding oracle, basis vault, funding swaps) + a native
Android app (`mobile/`, Expo) that trades two onchain books (Meridian + Perpl) behind one AUSD balance and a Mera passkey.

Read first: `CONTRIBUTING.md` (hard rules, rounding, tests, commits). Mobile work: `docs/mobile/MOBILE_PLAN.md` §0–§3 and
the phase prompt in `docs/mobile/prompts/`. **Cloud sessions (claude.ai/code): read `docs/mobile/CLOUD.md` first** — it
maps the prompts' local paths to this repo and overrides their git/device steps.

- Monorepo (pnpm 10.18.3, `node-linker=isolated` — never change it): `contracts/` Foundry, `packages/core` pure TS money
  logic (Hermes-safe), `mobile/` Expo app, `app/` Next.js web app, `mm-bot/`, `keepers/`, `mfi/`, `indexer/`, `bench/`.
- Never invent addresses, chain/market ids, decimals, URLs or package APIs: `deployments/*.json`, `abis/`, core readers,
  or `> VERIFY: <what, where>`.
- viem only; strict TS; tests first (vitest in core, jest-expo + RNTL in mobile; no network in tests).
- Money: bigint WAD via `@meridian/core`; round against the user; Monad bills the gas limit → limit = estimate × 1.2.
- Key material only in memory. Real data only on screen.
- Commits: conventional, author SamyaDeb, **no Claude / Co-Authored-By / Claude-Session trailers**.
