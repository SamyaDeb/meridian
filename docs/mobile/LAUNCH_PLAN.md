# LAUNCH_PLAN: Meridian web + iOS + Android, live against every service (production-grade)

Owner: Samya. Written Thu 8 Oct 2026. This is the **master plan**: platform, environments, services, config, CI/CD, monitoring, release and go-live. App features for the native apps are in `docs/MOBILE_PLAN.md` (phases N0–N10); this file adds the platform track (P0–P6) and the web track (W1–W2) and schedules all three together.

Timeline (owner's choices): implementation done **Sat 10 Oct**; staging (testnet) runs 24/7 from **Fri 9**; mainnet deploy **last, Sun 11 morning**; video Sun 11; buffer Mon 12; **submit Tue 13 by 12:00**.

---

## 0. Principles

1. **Three environments, one topology.** Local, staging and production run the *same* services with the *same* config shape; only the chain and the secrets differ. Anything that works on staging works on production by changing the environment, not the code.
2. **One source of truth for addresses.** `deployments/<chainId>.json` (written by the deploy scripts) + `deployments/perpl.json` → a generated config consumed by web, mobile, bots, indexer. Nobody types an address.
3. **Secrets live only in the platform's secret store** (Vercel env, Railway variables, EAS env, Envio). Local `.env` files are gitignored, one per process (RUNBOOK §1). One hot key per process.
4. **Everything has a health check, an alert and a kill switch.**
5. **Contracts are deployed only by script, owned by the Safe.** Apps and services never hold owner keys.
6. CONTRIBUTING.md rules apply (never invent addresses/IDs/URLs → `> VERIFY`).

---

## 1. Environments

| | **local** | **staging** | **prod-fork** (rehearsal) | **production** |
|---|---|---|---|---|
| Chain | anvil 31337 (or `--chain-id 10143`) | Monad testnet **10143** | anvil `--fork-url` mainnet, chain id **143** | Monad mainnet **143** |
| Perpl | mocked (core fixtures) | Perpl testnet (MON market 64) | Perpl **mainnet** read-only / tiny canary | Perpl mainnet (MON market 10) |
| Web | `next dev` :3000 | Vercel **Preview** at `staging.<domain>` | `next dev` against the fork | Vercel **Production** at `app.<domain>` |
| Mobile | dev build → LAN | EAS `preview` builds, channel `staging` | dev build → fork over LAN | EAS `production` (TestFlight + APK), channel `production` |
| Bots/services | local processes | Railway env `staging` | local processes | Railway env `production` |
| Indexer | none (chain data source fallback) | Envio hosted, testnet deployment | none | Envio hosted, mainnet deployment |
| Passkey rpId | `localhost` | `staging.<domain>` | `localhost`/LAN | `app.<domain>` (**permanent**) |
| Data | throwaway | throwaway | throwaway | real money |

> Domains: owner picks `<domain>`. Passkeys made on staging never work on production (by design).

---

## 2. Service inventory (what must be running)

| # | Service | Code | Hosting | Health | Notes |
|---|---|---|---|---|---|
| S1 | Contracts | `contracts/` (`DeployMeridian.s.sol`, `VerifyDeployment.s.sol`, `preflight-143.sh`) | chain | `VerifyDeployment` | Script-only; owner = Safe |
| S2 | Keeper (main market) | `keepers/ts-fallback` | Railway | `/health` (HEALTH_PORT) | Oracle pushes, funding pokes, liquidations, unwind, vault fulfil, swap duties |
| S3 | Keeper (demo market) | same, `MARKET=demo` | Railway **staging only** | `/health` | Crash demo only |
| S4 | Perp MM (+ Perpl hedge) | `mm-bot` (K3 `perpl-hedge`) | Railway | log heartbeat + watcher | Own key; KILL_FILE |
| S5 | Swap MM | `mm-bot` `MARKET=swap` | Railway | watcher | `REQUOTE_BPS ≥ 1000` |
| S6 | Watcher / pager | `keepers/ts-fallback` `pnpm watch` | Railway | pages Discord/Telegram | Start ≥ 30 s after keeper |
| S7 | MFI (funding index + spread API) | `mfi/` (`.railway/railway.ts` exists) | Railway + volume `/data` | `/healthz` | Feeds Welcome/Earn spread |
| S8 | Push worker | new: `services/push` (rules → Expo push) | Railway (cron/loop) | `/healthz` | Liq / spread / funding-flip / fill alerts |
| S9 | Indexer | `indexer/` (Envio HyperIndex) | Envio hosted | lag endpoint | Free plan 100k-event cap (K2) → lean config or paid plan |
| S10 | Web app + API | `app/` (Next 16) | Vercel | `/api/health` (K6) | Also serves `/.well-known/*` for passkeys, `/api/flags`, `/api/push/register` |
| S11 | iOS app | `mobile/` | EAS → TestFlight | in-app health banner | Mera only |
| S12 | Android app | `mobile/` | EAS → APK link | same | Mera only |
| S13 | CRE workflows (optional) | `keepers/cre` | `cre simulate` only (no DON access, K4) | evidence logs | Not on the critical path |

External dependencies: paid Monad RPC (HTTP + WS if offered), Perpl API, Pyth Hermes (`PYTH_API_KEY`), Kuru Flow (vault route), Chainlink AUSD/USD + MON/USD feeds (watcher), Envio, Vercel, Railway, EAS/Expo push, Apple (APNs/TestFlight), Google (FCM).

---

## 3. Config and secrets

### 3.1 Generated config (single source)
- New workspace package `packages/config` (`@meridian/config`): build script reads `deployments/{31337,10143,143}.json` + `deployments/perpl.json` → typed `getConfig(chainId)` = `{ contracts, perpl: { api, ws, exchange, collateral, monMarketId, markets }, startBlocks }`. Refuses `deployed: false` records. The web app's existing `app/scripts/sync-mainnet.mjs` + `app/src/config/deployments.ts` move onto it (keep behaviour; tests first).
- Consumers: `app/`, `mobile/` (via `packages/core`), `mm-bot`, `keepers/*`, `mfi/`, `indexer` config generator (`indexer/scripts/*` writes `config.<env>.yaml` from it).
- URLs that are **not** secrets but differ per env (Perpl API base, indexer GraphQL URL, MFI URL, web base URL) live in `packages/config/env/<staging|production>.json` — committed, reviewed.

### 3.2 Secrets matrix (names only; values only in the platform stores)
| Secret | Where | Consumers |
|---|---|---|
| `MONAD_RPC_URL` / `MONAD_TESTNET_RPC_URL` (bots key) | Railway | S2–S8 |
| `NEXT_PUBLIC_MONAD_RPC_URL` (app key, origin-restricted if the provider allows) | Vercel, EAS | S10–S12 |
| Indexer RPC key | Envio | S9 |
| `KEEPER_PK`, `MM_PK`, `SWAP_MM_PK`, demo keeper key | Railway (one per service) | S2–S5 |
| `PERPL_API_KEY` / `PERPL_API_KEY_SECRET` (MM hedge) | Railway | S4 |
| `PYTH_API_KEY` | Railway | S2 |
| `KURU_FLOW_JWT` or `KURU_API_KEY` | Railway | S2 |
| `PAGE_DISCORD_WEBHOOK_URL` / `PAGE_TELEGRAM_*` | Railway | S6 |
| `EXPO_ACCESS_TOKEN` (push send) | Railway | S8 |
| `NEXT_PUBLIC_PRIVY_APP_ID` (public) | Vercel | S10 |
| `ENVIO_API_TOKEN` | GitHub Actions / local | deploy |
| APNs key, FCM creds, Apple App Store Connect API key | EAS credentials | S11–S12 |
| `DEPLOYER_PK` | **local only, deploy day, then emptied** | S1 |
| `FLAGS_WRITES`, `FLAGS_PERPL`, `FLAGS_EARN`, `FLAGS_LOCK` (`"true"`/`"false"`, default on), `FLAGS_MIN_APP_VERSION` (x.y.z, default `0.0.0`), `FLAGS_MESSAGE` (not secrets; kill switches, §3.3) | Vercel (per environment) | `/api/flags` → web WriteGate, mobile flags client |
- Rotation: any key printed in a log or committed → rotate the same day. Hot wallets hold only what they need (top-up alerts at < 5 MON exist in the watcher).

### 3.3 Flags and kill switches
- `/api/flags` (Vercel, Edge Config or env-backed — > VERIFY Edge Config on the plan) → `{ writes: bool, perpl: bool, earn: bool, lock: bool, minAppVersion }`. Web reads it in `WriteGate`; mobile reads it on start + foreground and every 60 s. Turning `writes` off stops new trades everywhere without a rebuild; closes stay allowed.
- Bots: `KILL_FILE` (MM), `UNWIND`, `SWAP_DUTIES`, `VAULT_REBALANCE` envs (RUNBOOK). Railway "stop service" is the hard stop.
- `minAppVersion` forces a mobile update screen if a broken build ships.

---

## 4. Hosting setup

### 4.1 Railway (long-running services)
- One project `meridian`, two environments: `staging`, `production`.
- Extend the existing IaC (`mfi/.railway/railway.ts`, partial "mfi") with partials per service: `keepers` (S2, S3 staging-only, S6), `mm` (S4, S5), `push` (S8). Each: build from the repo root with `pnpm install --frozen-lockfile --filter "<pkg>..."`, start command, healthcheck path, restart policy on failure, env with secrets as `preserve()`.
- Deploy flow: `main` → auto-deploy to `staging`. `production` deploys only on a release tag (or manual promote). `railway config plan` before every `apply` (read-only preview).
- Logs: Railway log explorer; retention per plan.
- The Railway MCP tools / `use-railway` skill can drive this from a Claude session (owner's account; confirm before creating resources).

### 4.2 Vercel (web + API)
- Project root `app/`. Production branch `main`… but **production domain assignment only on the release tag** (promote a verified deployment). Preview deployments per PR; `staging.<domain>` aliased to the latest `main` preview (or a `staging` branch fast-forwarded by CI).
- Env per environment (Preview = staging values, chain 10143; Production = 143).
- Headers: `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` served as `application/json`, no redirects (passkeys); security headers (CSP allowing the RPC/Perpl/indexer/Privy origins only).
- Geo-block config per `app/.env.example` (`GEO_*`) — owner decides the list; > VERIFY the platform's country header name.

### 4.3 Envio (indexer)
- Two hosted deployments: testnet (exists, but on the OLD v1 addresses — K6: must redeploy on current addresses) and mainnet (Sun 11, start block = deploy block from `deployments/143.json`).
- Config generated from `@meridian/config`; GraphQL URLs into `packages/config/env/*.json`.
- Watch the free-plan event cap (K2): lean Perpl indexing or upgrade.

### 4.4 EAS (mobile)
- `eas.json` profiles: `development`, `preview` (staging, Android APK internal + iOS internal), `production` (TestFlight + APK). Each profile sets `APP_ENV` → `app.config.ts` picks `packages/config/env/<env>.json`, chain id, rpId, bundle id suffix (staging app can install next to production: e.g. `…app.staging` — then assetlinks/AASA list both).
- `expo-updates` with channels `staging` / `production` for JS-only fixes (no store review); native changes → new build.
  > VERIFY / later (N8-prep, 10 Oct): **not installed.** `expo-updates` is a native dependency, so adding it means a new
  > dev client + preview build and a lockfile change; N8 ships without it. Until then a JS fix = a new EAS build, and a
  > broken build is handled by `/api/flags` (`writes=false`, `minAppVersion` → the update screen with its close path).
- Credentials (APNs, FCM, signing) managed by EAS.

### 4.5 Observability
- Health endpoints: keeper `/health`, MFI `/healthz`, push `/healthz`, web `/api/health` (aggregates: RPC head age, indexer lag, MFI freshness, keeper last tick, MM quoting, Perpl API reachable).
- External uptime monitor (free tier of any uptime service — owner picks) on all public health URLs, alerting to the same Discord/Telegram as the watcher.
- Error tracking: Sentry (web + `@sentry/react-native` for mobile) — optional but recommended; DSNs in env. > VERIFY current Sentry Expo setup docs.
- `/stats` page (K6) = public metrics; `docs/outputs/PROOF.md` = evidence.

---

## 5. CI/CD and release flow

```
PR ─► CI (contracts fmt/build/test · pnpm -r typecheck/test · core/mobile tests · lint) ─► Vercel preview + EAS preview (on label)
merge main ─► Railway staging auto-deploy · Vercel staging alias · indexer staging (if config changed)
          ─► smoke:staging (scripted, §5.1) must pass
tag vX.Y.Z ─► Vercel promote to production · Railway production deploy · EAS production build/submit (or eas update)
          ─► smoke:production (read-only) ─► announce
```
- Add CI jobs: `packages/core`, `packages/config`, `mobile` typecheck + tests; config drift check (generated config committed == regenerated).
- Contract deploys never run in CI.
- Branch protection on `main`: CI green + owner review.

### 5.1 Smoke suites (one command each, in `tools/smoke/`)
- `pnpm smoke:local` — anvil stack up, deposit → trade → close, MFI responds, web renders.
- `pnpm smoke:staging` — all health endpoints green; config addresses have code; indexer lag < N blocks; MFI fresh; Perpl testnet reachable; a **canary wallet** (dedicated staging key) opens and closes 1 lot on Meridian testnet and 1 lot on Perpl testnet.
- `pnpm smoke:production` — read-only by default (health, code at addresses, book has ≥ 2 levels each side within ±1%, MFI fresh); `--trade` flag (owner only) runs the canary trade with tiny size.

### 5.2 Local one-command stack
`pnpm stack:local` (`tools/stack/local.mjs`): start anvil → `DeployLocal.s.sol` → write `deployments/31337.json` → start keeper + MM + MFI (each its own env, ports from RUNBOOK) → `next dev` → print the LAN URL + QR for the Expo dev build (`EXPO_PUBLIC_*` pointing at the Mac's LAN IP). `pnpm stack:fork` = same against a mainnet fork (prod-fork env). Stop everything with Ctrl-C (child processes cleaned up).

---

## 6. Web track

| Phase | What | When | Notes |
|---|---|---|---|
| W1 | **Mera on the web** next to Privy (same rpId as production native → same passkey + same address on web and phone) | Fri 9 | Reuses `packages/core` key derivation; the earlier web M1 design (custom wagmi connector, mutual exclusion with Privy, passkey wallets unsponsored). Strong demo moment: "log in on your laptop with your phone's passkey" |
| W2 | **Earn-spread + dual-book quote on the web** (reuses `packages/core` routing/basis/exec) | Sat 10 | Optional; cut if behind. Keeps web ↔ mobile parity for judges on laptops |
| W3 | Web production hardening | Sat 10 | `/api/flags`, `/.well-known/*`, CSP, geo-block, health aggregation, staging/prod env split |

---

## 7. Platform track (P0–P6)

### P0 — Provision accounts and infra (Thu 8) · HUMAN-heavy
- [ ] Domain: `app.<domain>` (prod, permanent rpId), `staging.<domain>`; DNS at the registrar → Vercel.
- [ ] Vercel project (root `app/`), Preview + Production envs.
- [ ] Railway project `meridian` with `staging` + `production` environments.
- [ ] Paid Monad RPC: keys for bots, app, indexer (+ WS). Note limits (`eth_getLogs` span, `debug_traceCall` support needed for `VAULT_ROUTE=flow` on mainnet).
- [ ] Envio account/token; plan check (event cap).
- [ ] Expo/EAS account; Apple Developer Program (Team ID); Google/FCM project for Android push.
- [ ] Paging channel (Discord webhook or Telegram bot) + uptime monitor account.
- [ ] Wallets: staging keeper/MM/swap-MM/canary keys funded with testnet MON (budget below); production keys generated (unfunded until Sun); Safe address.
- [ ] Testnet MON budget: keeper + perp MM floor ≈ 12.3 MON/h on testnet (K6) → ~900 MON for Fri–Mon 24/7; reduce with `TICK_EVERY_BLOCKS=3`, `LEVELS=1`, `REQUOTE_BPS=10` on staging if the faucet can't cover it (> VERIFY faucet limits).

### P1 — Config + secrets pipeline + local stack (Thu 8 – Fri 9)
- [ ] `packages/config` (§3.1) with tests; migrate `app/` deployment reading onto it without behaviour change.
- [ ] `packages/config/env/{staging,production}.json` (URLs, not secrets).
- [ ] Env templates per service (extend `keepers/143.env.example` pattern to staging + push + mfi + mobile).
- [ ] `pnpm stack:local` and `pnpm stack:fork` (§5.2).
Acceptance: `pnpm stack:local` brings up chain + bots + MFI + web in one command; the Expo dev build on a phone trades against it over LAN.

### P2 — Staging live 24/7 on testnet (Fri 9)
- [ ] Redeploy the Envio testnet indexer on the **current** addresses (K6 blocker). Config `indexer/config.hosted.testnet.yaml` already matches `deployments/10143.json` (checked 10 Oct); the hosted deploy needs the owner's Envio login, then `NEXT_PUBLIC_INDEXER_URL` on Vercel staging.
- [ ] Railway IaC partials for S2–S8; `railway config plan` → `apply` (staging).
- [~] Vercel staging deploys `main` (10 Oct: `/api/health` commit `ca84977`, `/api/flags` 200, assetlinks 200). `/api/health` still `ready:false`: indexer URL unset. Prod `meridianfi` assetlinks still 404 (waits for the L2 EAS production signer SHA-256).
- [ ] Push worker (S8) skeleton: `/api/push/register` (web) stores tokens; worker evaluates rules every block-ish (≥ 2 s) and sends via Expo.
- [ ] EAS `preview` builds pointing at staging, installed on both phones.
- [ ] Uptime monitor on every health URL; watcher paging live.
Acceptance: web + iOS + Android all trading on testnet against hosted keeper/MM/MFI/indexer/push for 12 h with no page.

### P3 — CI/CD, flags, smoke (Fri 9 – Sat 10)
- [ ] CI jobs for core/config/mobile; config drift check.
- [ ] Release workflow on tags (§5); Railway prod deploy on tag; Vercel promote; EAS build/submit job (manual approval).
- [x] `/api/flags` + clients (web WriteGate, mobile gate + forced update): merged in #15, live on staging 10 Oct.
- [ ] `smoke:local`, `smoke:staging`, `smoke:production` (§5.1).
Acceptance: a tag on staging runs the full flow end to end (with production steps in dry-run mode until Sun).

### P4 — Production dress rehearsal (Sat 10 evening)
- [ ] `pnpm stack:fork`: exact mainnet deploy script + config on a fork; ownership → Safe; keeper/MM against the fork; web + mobile dev build against the fork; Trade + Earn + Close work.
- [ ] `preflight-143.sh` passes; `VerifyDeployment` passes on the fork.
- [ ] Production Railway env filled (keys, RPC, Pyth, Kuru, paging) but services **stopped**.
- [ ] Production Vercel env filled; EAS production build ready (pointing at 143; addresses come from config generated after the deploy → final build Sun, or EAS Update with the config).
- [ ] Runbook for Sun printed (§8) with named owner per step.

### P5 — Go-live (Sun 11 morning) = MOBILE_PLAN N9
See §8.

### P6 — Operate (Sun 11 → Tue 13)
- On-call: one founder owns pages at any time (rota in `docs/standup/ONCALL.md`); response target 15 min.
- Daily: `smoke:production`, wallet balances, indexer lag, MFI freshness, book depth, error tracker.
- Incident playbook: (1) flip `/api/flags.writes=false`, (2) stop MM via KILL_FILE, (3) diagnose, (4) fix forward via tag, (5) re-enable, (6) note in `docs/outputs/INCIDENTS.md`.
- Testers onboarding (consented addresses only → USERS.md).

---

## 8. Go-live runbook (Sun 11) — owner per step

| Time | Step | Owner | Check |
|---|---|---|---|
| 07:30 | Final go/no-go: staging green 12 h, P4 rehearsal passed, wallets funded, Safe ready | all | checklist |
| 08:00 | `preflight-143.sh` → `DeployMeridian` (mainnet) → `VerifyDeployment` → explorer verify | A | `deployments/143.json` written by script |
| 08:30 | Ownership → Safe (Safe txs signed) | A | owner() = Safe on every contract |
| 08:45 | Regenerate config (`packages/config`), commit, tag `v1.0.0-rc` | A | drift check green |
| 09:00 | Envio mainnet deployment (start block = deploy block) | C | synced |
| 09:00 | Railway production: keeper → perp MM (+ Perpl hedge) → swap MM → wait 30 s → watcher → MFI → push | B | health green, pages quiet |
| 09:30 | Book check: ≥ 2 levels each side within ±1%; funding ticking | B | `smoke:production` |
| 09:45 | Vercel promote production (`app.<domain>`); `/.well-known/*` live for prod | C | curl 200 JSON, no redirect |
| 10:00 | EAS production: Android APK link + iOS TestFlight (or `eas update` if the build already exists) | C | installs on both phones |
| 10:30 | Demo passkey on `app.<domain>` (phone), fund, run: Perpl onboarding → Trade Perpl → Trade Meridian → Earn + Lock → Close | C | all hashes/order ids in PROOF.md §Mobile |
| 11:00 | Web: Mera login with the same passkey (W1) → same address; Privy email path still works | C | screenshot |
| 11:30 | `smoke:production --trade` (canary) + uptime monitors on prod URLs | A | green |
| 12:00 | Tag `v1.0.0`; announce to testers | A | — |
| PM | Record video (MOBILE_PLAN N10) | all | — |
Rollback at any step: flags `writes=false`, stop MM, positions remain closable (non-upgradeable contracts).

---

## 9. Master schedule (all tracks)

Lanes: **A** = platform (P), **B** = core + Perpl + bots, **C** = mobile + web UI. (Claude sessions can run any lane; humans do HUMAN items.)

| Day | A — Platform | B — Core / Perpl / bots | C — Mobile + web |
|---|---|---|---|
| **Thu 8** | P0 provisioning; P1 start (`packages/config`) | N1 `packages/core` | N0 → N2 Expo shell; N3 Mera native |
| **Fri 9** | P1 local stack; **P2 staging live**; P3 start | N4 Perpl onboarding (phone run) + mainnet canary; MM hedge on staging | N4b UX polish (MOBILE_UX_RESEARCH) → N5 Trade (Lite/Pro, live chart); W1 Mera on web |
| **Sat 10** | P3 CI/CD + flags + smoke; **P4 rehearsal (evening)** | N6 Earn executor; push rules (S8) | N7 Home/Activity/Settings (push = P2); hallway test (3 people, before 12:00); N8 release builds + QA; W2/W3 |
| **Sun 11** | **P5 go-live (§8)** | bots on mainnet, canary | prod builds, demo passkey, **video** |
| **Mon 12** | P6 operate, smoke daily | testers, fixes | polish, write-up |
| **Tue 13** | submit by 12:00 | — | — |

**Go/no-go gates:** Fri 18:00 staging must be live (else cut W2 + push); Sat 12:00 mobile Trade must work on a device (else Android-only + cut Lock); Sat 22:00 P4 rehearsal must pass (else delay mainnet to Mon 08:00 and record the video on staging + mainnet canary only).

**Cut order (top first):** W2 web Earn → push alerts (S8) → Lock → Sentry → iOS TestFlight external link (internal only) → CRE.
**Never cut:** staging 24/7, config pipeline, flags/kill switch, health + paging, smoke suites, mainnet go-live runbook, Mera on native, Perpl trade, video.

---

## 10. Session prompt (platform phases)

```
You are a senior blockchain + platform engineer on Meridian. Read
/Users/samya/Downloads/Meridian/docs/LAUNCH_PLAN.md (all of §0–§5 and the phase <PX or WX>) and, for anything
mobile, docs/MOBILE_PLAN.md §0. Work in /Users/samya/Downloads/meridian-m on branch <branch> from main. Follow
CONTRIBUTING.md: never invent addresses/URLs/IDs (use deployments/*.json or write > VERIFY), tests first, one key per
process, secrets only in platform stores. Before creating or changing any hosted resource (Railway, Vercel, Envio,
EAS, DNS) show me the plan/diff and wait for my OK. Public repo commits: signed, author SamyaDeb, no Claude trailers.
Finish by ticking only verified boxes, listing HUMAN steps left, updating §11 log, and opening a PR "[PX] …".
```

## 11. Log
- 2026-10-08 — Launch plan written (platform P0–P6, web W1–W3, schedule with MOBILE_PLAN N0–N10). Open: domains, RPC provider, Apple Team ID, Envio plan, paging channel, testnet MON budget, Safe address.
- 2026-10-08 — P0: owner will not join the Apple Developer Program → S11 (iOS app / TestFlight) cut; iOS shown via web + Mera (W1) in Safari, Android via EAS APK (MOBILE_PLAN §5). Toolchain check: Node 22 (need 24), no Xcode/CocoaPods/Android SDK, JDK 22 only, Railway CLI logged in as another user; disk full (ENOSPC) — blocking installs.
- 2026-10-08 — `<domain>` resolved as free Vercel hosts: production `meridianfi.vercel.app` (project `meridianfi`, created + placeholder), staging `meridian-testnet.vercel.app`. Permanent rpId = `meridianfi.vercel.app` (renaming/deleting that project strands passkeys; recovery = mnemonic export).
- 2026-10-08 — P0: Railway runs on teammate Priyanshu's account (owner confirmed; CLI + MCP both on it). Faucet: keeper 0x0D3B… and MM 0x814D… now 5.00 MON each (≈ 25–40 min of unthrottled keeper+MM at 12.3 MON/h). `meridian-m` cloned (main 0ba1664, SSH signing as SamyaDeb, pnpm i on Node 24). EAS logged in as samyadeb.
- 2026-10-08 — Owner chose **option A**: staging runs only during test sessions + the demo (not 24/7) — testnet MON too scarce (10 MON on keeper+MM). P2 acceptance "12 h with no page" → replace with "a full test session (web + Android) with no page". Android install path: EAS cloud dev build + Wi-Fi Metro (no USB needed). N1 prompt: docs/prompts/mobile/N1-core.md.
- 2026-10-10 — **L1**: all finished branches are on `main` (see MOBILE_PLAN §5, same date). Staging web redeployed itself from main (`ca84977`): `/api/health` 200 JSON (`ready:false`, `indexerUrl` missing), `/api/flags` 200 `{v:1,writes,perpl,earn,lock,minAppVersion}`, assetlinks 200. Open for the owner: Envio hosted redeploy + URL into Vercel staging, app-only RPC key, `FLAGS_*`, Pyth; prod assetlinks fingerprint after L2.
