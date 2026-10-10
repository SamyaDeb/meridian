---
name: perpl-api
description: Trade on Perpl (onchain perp DEX on Monad) from Meridian code — API-key enrolment, Ed25519 request signing, account creation, order forwarding, IOC orders over the trading WebSocket/REST, market data, positions, limits, error codes, testnet vs mainnet config. Use for any Perpl integration, the Meridian mobile app's Perpl leg (MOBILE_PLAN M2/M5/M6), the market-making bot's hedge, or Perpl funding/risk data.
---

# Perpl API

Source of truth: github.com/PerplFoundation/api-docs (`authentication.md`, `integrations.md`, examples). Re-read the relevant doc before changing behaviour; anything not below → `> VERIFY:`.

## 1. Config (never hard-code — read `deployments/perpl.json`)
| | Mainnet 143 | Testnet 10143 |
|---|---|---|
| REST | `https://app.perpl.xyz/api` | `https://testnet.perpl.xyz/api` |
| WS | `wss://app.perpl.xyz` (`/ws/v1/trading`, `/ws/v1/market-data`) | `wss://testnet.perpl.xyz` |
| Exchange | `0x34b6552d57a35a1d042ccae1951bd1c370112a6f` | `0x1964c32f0be608e7d29302aff5e61268e72080cc` |
| Collateral | AUSD `0x00000000efe302beaa2b3e6e1b18d08d69a9012a`, 6 dp | `0xa9012a055bd4e0edff8ce09f960291c09d5322dc`, 6 dp |
| MON market id | 10 | 64 |
Market metadata (price/size decimals, funding interval 2,580 s) is in `deployments/perpl.json`, copied from `/v1/pub/context`; refresh with `node indexer/scripts/seed-perpl.mjs`. Exchange ABI: `indexer/abis/PerplExchange.json`.

## 2. Existing code to reuse (don't rewrite)
- `meridian-k3/mm-bot/src/perpl/auth.ts` — canonical strings + signing (Node: uses `node:crypto` + `Buffer`; for the browser swap to `@noble/hashes/sha256` and a Uint8Array base64url helper, keep the same test vectors).
- `mm-bot/src/perpl/trading.ts` — `PerplTrading` WS client, reconnect delays, place results; `ratelimit.ts`, `state.ts`, `types.ts`, `config.ts`.
- `mm-bot/scripts/perpl-enroll.ts` — programmatic key enrolment flow.
- `mfi/src/perpl/*` — REST read client, units, validation; `mfi/src/mfi/*` funding index + spread.
- K5 rates-risk branch — Perpl liquidation rule (from dex-sdk).
Keep one implementation; if the app needs it, move it to a shared package rather than forking.

## 3. Auth
- Ed25519 key pair; private key 32 bytes. Signature = base64url **without padding** of Ed25519 over the canonical string.
- REST canonical: `chain_id\nMETHOD\nrequest-target\ntimestamp_ms\nnonce\nsha256(body) hex` (target = path + query without the `/api` base). Headers: `X-API-Key`, `X-API-Timestamp`, `X-API-Nonce`, `X-API-Signature`. Nonce = 16 random bytes base64url, single-use within the 30 s window.
- Trading WS: first frame `mt: 29` ApiKeySignIn signing `chain_id\ntrading-ws-signin\ntimestamp_ms\nnonce`.
- Enrolment: `POST /v1/api-key/payload` → EIP-712 typed data + mac → wallet signs the EIP-712 (secp256k1) and the key proves possession (Ed25519 over the EIP-712 digest) → `POST /v1/api-key/enroll` → opaque `X-API-Key` token. Scope mask: the bot used 3 (check integrations.md for the trade bit).
- API-key enrolment accepts EOA signatures (passkey wallets from Mera are EOAs — fine).

## 4. Becoming tradeable (three separate things)
1. API key enrolled (access only).
2. Exchange account: `createAccount(uint256)` with an initial AUSD deposit (approve first). Public API says `min_account_open_amount: 100000000` displayed as "10.0 AUSD" — verify the raw unit on the network you use before sending.
3. `allowOrderForwarding(true)` from the account's wallet; without it orders are acknowledged then fail `st: 7`, `sr: 34`. With it, the exchange submits and pays gas for orders.
Model this as a resumable state machine detected from API/chain on every load.

## 5. Limits and behaviour
- Trading WS: 120 req/min mainnet, 60 testnet; max 4 connections per wallet (shared across keys and browser tabs) → one connection per tab, close on hide.
- Market-data WS: 10 req/min, 16 subscriptions per connection. Public REST market data needs no auth.
- REST limits unpublished: exponential backoff + jitter on 429.
- Fees per market in micros, tiered by `Account.ft` (14-day volume). Fee field `f` is gross (protocol + builder); builder part reported as `bfa` — don't add them.
- Fill events (mt 25) can arrive after the order outcome; reconcile with REST fills/position history.

## 6. Browser use
- First check CORS from the real staging origin (REST GET, signed GET, enrol POST, WS). If REST is blocked, add a thin allow-listed relay route that forwards signed requests verbatim (the client still signs; never log headers). WS can't be relayed through Vercel functions.
- Never put an Ed25519 secret in storage; for passkey users derive it from the passkey (see `mera-passkeys` §4).

## 7. Testing
- No live network in CI: replay recorded WS frames/REST bodies (K3 has fixtures), signing vectors (incl. the RFC 8032 public vector — GitGuardian flags it; owner marks it, don't obfuscate).
- Manual smoke on testnet: enrol → createAccount → forwarding → IOC 1 lot → close. Mainnet canary: smallest size, record order ids + tx hashes in PROOF.md.
