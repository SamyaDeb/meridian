# Hosting the MFI service on Railway (decision D15)

The `/rates` page reads the Meridian Funding Index from the MFI service (`mfi/`, `@pulse/mfi`) at `NEXT_PUBLIC_MFI_URL`. This runbook puts that service on Railway. **Status 5 Oct 2026: prepared, not deployed: BLOCKED on the owner's Railway login** (`railway login`; this session had no Railway credentials).

The configuration is Railway Infrastructure as Code: `mfi/.railway/railway.ts` (partial `mfi`, so it manages only this service). Railway's older `railway.json` config-as-code is deprecated and cannot be used for new services (docs.railway.com/infrastructure-as-code, read 5 Oct 2026). The file was typechecked against the pinned SDK (`railway@3.12.0`, devDependency of `mfi/`) and compiled locally: one service `meridian-mfi`, one volume `mfi-data` mounted at `/data`.

## What the service needs
| Variable | Value | Secret? |
|---|---|---|
| `MFI_CHAIN_ID` | `10143` now; `143` once `deployments/143.json` is committed (mainnet day) | no (in the IaC file) |
| `MFI_HISTORY_PATH` | `/data/history.jsonl` (the volume; history survives redeploys, decision D7) | no (in the IaC file) |
| `MONAD_TESTNET_RPC_URL` | the testnet RPC (required while `MFI_CHAIN_ID=10143`) | **yes**: set in the dashboard; the file says `preserve()` |
| `MONAD_RPC_URL` | the mainnet RPC (required when `MFI_CHAIN_ID=143`; use a paid endpoint, HUMAN_CHECKLIST #5) | **yes**: dashboard only |
| `PORT` | provided by Railway (the service reads `PORT`, default 8787 locally) | no |
| `PERPL_API_URL`, `PERPL_SYMBOL` | optional overrides; defaults are Perpl's documented URL for the chain and `MON` | no |
| `MFI_CYCLE_MS` | optional, default 60000 | no |

Build: `pnpm install --frozen-lockfile --filter "@pulse/mfi..."` from the **repo root** (the service reads `deployments/<chainId>.json` and the workspace lockfile). Start: `pnpm --filter @pulse/mfi start` (`tsx src/main.ts`; `tsx` is a runtime dependency). Healthcheck: `GET /healthz`. The API is read-only, GET + CORS (`/v1/mfi`, `/v1/mfi/history`).

## Steps (owner, about 10 minutes)
1. Install the Railway CLI (docs.railway.com/cli) and run `railway login`.
2. `cd mfi && railway link` (create or pick the Meridian project; environment `production`).
3. `railway config plan`: expect **2 to add** (volume `mfi-data`, service `meridian-mfi`) and nothing to change or destroy.
4. `railway config apply` and confirm.
5. In the dashboard, service `meridian-mfi` → Variables: set `MONAD_TESTNET_RPC_URL` (and `MONAD_RPC_URL` for mainnet). Never commit them.
6. Service → Settings → Networking: generate a public domain. > VERIFY: whether Railway also needs the target port set (the service listens on `PORT`).
7. Check: `curl https://<domain>/healthz` → `ok: true` after the first cycle (≤ 60 s); `curl https://<domain>/v1/mfi` → `version: "mfi-v0"`, Meridian venue `ok`, Perpl `ok` or `unavailable` with a reason.
8. App: set `NEXT_PUBLIC_MFI_URL=https://<domain>` on the app build and redeploy; `/rates` shows the index, venues and chart.
9. Mainnet day (after `deployments/143.json` is on `main`): change `MFI_CHAIN_ID` to `"143"` in `mfi/.railway/railway.ts`, set `MONAD_RPC_URL`, `railway config apply`. The history file is per chain in meaning, so delete `/data/history.jsonl` once when switching (Railway volume shell, or `MFI_HISTORY_PATH=/data/history-143.jsonl`).

> VERIFY on first apply: `volume("mfi-data")` without `region`/`sizeMB` takes Railway's defaults (the SDK marks both optional); the history file is about 0.2 KB per minute, so ~3 MB at 7 days.

## Verified locally (5 Oct 2026)
- Live against 10143: Meridian `ok` (1 h realized APR from the funding-rate oracle), Perpl `ok` (testnet market 64), index OI-weighted; `/rates` rendered it (`app/e2e/screenshots/rates-{phone,desktop}-live-10143.png`).
- Restart: 13 points on disk reloaded, served after one more cycle (14).
- Mainnet Perpl lists MON as market 10 with an empty `symbol` (`name: "MON"`); the client resolves it (`matchMarket`, `mfi/test/recorded.test.ts`).
