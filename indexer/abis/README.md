# Indexer ABIs

- `I*.json`: Meridian's own interfaces, copied from `../../abis` by `pnpm gen-config 10143 --hosted`, so Envio Cloud (Root Directory `indexer`) never reads outside this folder. Don't edit them here.
- `PerplExchange.json`: **vendored third-party ABI** (Perpl's exchange, another perp DEX on Monad), used only to decode Perpl events (K2.2, `../PERPL_EVENTS.md`).
  - Source: [`PerplFoundation/dex-sdk`](https://github.com/PerplFoundation/dex-sdk) `crates/sdk/abi/dex/Exchange.json` at commit `dbb37c59f6aef03e38d0787eb9c968f59f652617` (4 Sep 2026); `REVISION` = `rc_v1.1.7-203-g0e5902dd`.
  - Only the artifact's `abi` array is kept (bytecode and metadata dropped). Upstream file sha256 `766fc81326bdf27f243ca582f65c3e2ff72bc639d88674876697a63ae1c47cb3`.
  - Licence: MIT (the dex-sdk repository's licence; see `THIRD_PARTY.md` at the repo root).
  - The exchange is behind an ERC-1967 proxy: the indexer listens on the proxy address with this ABI.
