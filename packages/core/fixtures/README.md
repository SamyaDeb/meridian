# Fixtures (packages/core)

Recorded from public endpoints or read-only sessions; replayed by the tests (no network in CI). Copied unchanged from the branch named; nothing here is a secret (the trading session holds no key or signature, only server frames).

| Path | What | Recorded | Source |
|---|---|---|---|
| `perpl/testnet/trading/trading-session.jsonl` | trading WS: wallet / orders / positions snapshots + heartbeats, hedge account 969 | 8 Oct 2026 | K3 `mm-bot/fixtures/recorded/testnet` (perpl-hedge @ fe873b0), `scripts/perpl-record-trading.ts` |
| `perpl/testnet/trading/history-*.json` | REST fills / order-history / position-history pages, account 969 | 8 Oct 2026 | same |
| `perpl/testnet/ws/*.jsonl` | market-data WS: control, heartbeat, market-config, market-state, funding, **order-book@64**, trades (60 s) + one funding interval | 7 Oct 2026 | K3 `mfi/fixtures/recorded/testnet/ws` (@ 116e26d) |
| `perpl/{testnet,mainnet}/{context,funding-*,ticker-*}.json` | REST `/v1/pub/context`, funding history, ticker (MON 64 / 10) | 5 Oct 2026 | `mfi/fixtures/recorded` (main @ 0ba1664) |
| `perpl/chain/*.json` | Perpl exchange views over RPC: accounts 969 (testnet), 1076 (mainnet), none; both MON markets | 8 Oct 2026 | K5 `app/src/features/rates/fixtures` (rates-risk @ 1edb15f) |
| `perpl/synthetic/*.json` | **synthetic** shapes, values invented (see its README) | — | `mfi/fixtures/synthetic` |
| `books/testnet-meridian-69059070.json` | Meridian `getDepth` / tick / lot / riskParams / funding at block 69,059,070 (during the K3 MM + hedge run) + the Perpl REST book and ticker at recording time | 8 Oct 2026 | `scripts/record-books.ts` (archive RPC) |
| `books/testnet-2026-10-08T1029.json` | the same at the head: the Meridian book was empty (MM not running) | 8 Oct 2026 | `scripts/record-books.ts` |
